// Stepped modal that builds a Matrix. The user must complete this before the
// matrix loads any data.
//
// Four steps, each answering one question (#1202 — "a matrix is a document"):
//
//   Subjects      — user accounts or identities, and which ones
//   Resources     — resources alone or with business roles, and which ones
//   Layout        — group & sort, roll-up, and what the matrix opens with
//   Save & share  — name it to keep it, pick people to share it with
//
// deriveSteps() in the helpers file owns which steps a filter shows (a roles-only
// roll-up has no Resources step). The step indicator jumps anywhere.
//
// Each step shows live counts so the analyst can see the size of the
// sub-selection grow/shrink as they tweak conditions. On the last step ONE
// primary button commits the matrix to the parent (which triggers the data
// fetch) — showing it as it stands, or saving and sharing it first. Its label
// follows the fields; see saveStepState.js.
//
// Saved matrices are org-wide and live in the `SavedMatrixFilters` table (name
// retained for backward compat; the user-facing term is "matrix").

import { useEffect, useReducer, useState, useCallback, useRef } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import Stepper from '@ui/components/Stepper';
import { Modal, PrimaryButton, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { useDialog } from '@ui/components/dialogContext';
import { normalizeMatrixFilter } from '@ui/utils/matrixFilter';
import {
  deriveSteps, commitFilter, resolveInitialStep, servesViaAttrCut, matrixIsBlocked,
  applyRollupMode, referencedContextIds,
} from './MatrixFilterWizard.helpers';
import { WizardSubjectsStep, WizardResourcesStep } from './WizardConditionSteps';
import WizardLayoutStep from './WizardLayoutStep';
import WizardSaveStep from './WizardSaveStep';
import WizardLiveSummary from './WizardLiveSummary';
import { useWizardSave } from './useWizardSave';
import { matchSavedMatrix, wizardPreferredSavedId, liveShareWarning, appliedSavedMatrix } from './shareState';

const EMPTY_PREVIEW = { subjectCount: 0, subjectTotal: 0, resourceCount: 0, resourceTotal: 0, assignmentCount: 0 };

// Column metadata for each entity (Principal / Identity / Resource). Schema-only
// first for a fast paint, then full values in the background.
//
// Both requests are in flight at once and either can answer first, so the fast
// one must never be allowed to land on top of the full one. It carries no
// values and none of the ext.* extension attributes derived from them, and
// nothing on screen distinguishes that placeholder list from a deployment that
// genuinely has neither — the wizard just settles into offering every field
// with a "(0)" count and no extension attributes at all, permanently. That
// last-write-wins race made three matrix e2e specs intermittent (~30-40% of
// runs) before the guard below.
function useColumns(authFetch, open, rowType) {
  const [principalColumns, setPrincipalColumns] = useState(null);
  const [identityColumns,  setIdentityColumns]  = useState(null);
  const [resourceColumns,  setResourceColumns]  = useState(null);

  const loadColumns = useCallback((entity, setColumns) => {
    let cancelled = false;
    let full = false;
    const get = url => authFetch(url).then(r => r.ok ? r.json() : []);
    get(`/api/matrix/columns?entity=${entity}&schema=true`)
      .then(cols => { if (!cancelled && !full) setColumns(cols); });
    get(`/api/matrix/columns?entity=${entity}`)
      .then(cols => { if (!cancelled) { full = true; setColumns(cols); } });
    return () => { cancelled = true; };
  }, [authFetch]);

  useEffect(() => {
    if (!open) return;
    const cancelPrincipal = loadColumns('Principal', setPrincipalColumns);
    const cancelResource = loadColumns('Resource', setResourceColumns);
    return () => { cancelPrincipal(); cancelResource(); };
  }, [open, loadColumns]);

  // Identity columns only once the rows are identities.
  useEffect(() => {
    if (!open || rowType !== 'identity' || identityColumns) return;
    return loadColumns('Identity', setIdentityColumns);
  }, [open, rowType, identityColumns, loadColumns]);

  return { subjectColumns: rowType === 'identity' ? identityColumns : principalColumns, resourceColumns };
}

// Debounced preview — re-fetch counts 250ms after the last filter mutation.
function usePreview(authFetch, open, filter) {
  const [preview, setPreview] = useState(EMPTY_PREVIEW);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);
  const abort = useRef(null);
  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (abort.current) abort.current.abort();
      const controller = new AbortController();
      abort.current = controller;
      setLoading(true);
      try {
        const res = await authFetch('/api/matrix/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter }),
          signal: controller.signal,
        });
        if (res.ok) {
          const body = await res.json();
          setPreview(Object.fromEntries(Object.keys(EMPTY_PREVIEW).map(k => [k, body[k] || 0])));
        }
        setLoading(false);
      } catch (err) {
        if (err.name !== 'AbortError') setLoading(false);
      }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [filter, open, authFetch]);
  return { preview, loading };
}

// Context metadata for every context id the filter references, so chips and the
// roll-up name render names instead of UUIDs. Cached across edits.
function useContextMeta(authFetch, open, filter) {
  const [contextMeta, setContextMeta] = useState(new Map());
  useEffect(() => {
    if (!open) return;
    const missing = referencedContextIds(filter).filter(id => !contextMeta.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(missing.map(id =>
      authFetch(`/api/contexts/${id}`).then(r => r.ok ? r.json() : null).catch(() => null)
    )).then(results => {
      if (cancelled) return;
      setContextMeta(prev => {
        const next = new Map(prev);
        for (const r of results) {
          if (r?.attributes) next.set(r.attributes.id, r.attributes);
        }
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [filter, open, authFetch, contextMeta]);
  const resolved = useCallback((node) => setContextMeta(prev => new Map(prev).set(node.id, node)), []);
  return { contextMeta, onContextResolved: resolved };
}

// ─── Wizard component ──────────────────────────────────────────────

export default function MatrixFilterWizard({
  open,
  initialFilter,
  initialManaged = 'all',
  initialStep,
  onApply,
  onClose,
}) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [step, setStep] = useState(() => resolveInitialStep(initialStep));
  // Normalised (never structuredClone'd raw): the filter can arrive from a URL,
  // a saved matrix, or the seeded org default, any of which may be missing
  // fields the steps read directly. See utils/matrixFilter.js.
  const [filter, setFilter] = useState(() => normalizeMatrixFilter(initialFilter));
  // The default lens (All / Governed / Non-governed / Gaps) — set on the Layout
  // step, carried through showing and saving.
  const [managed, setManaged] = useState(initialManaged);
  const [savedFilters, setSavedFilters] = useState([]);

  // Which saved matrix the wizard is EDITING. `savedMatch` answers "does the
  // current filter equal a saved one" and goes null the moment anything is
  // changed; this remembers which matrix those changes belong to, so saving
  // writes them back instead of demanding a second name (#1202). Only a matrix
  // the wizard was opened on can be edited — "Create matrix" starts a new one.
  // Value-only state; a reducer dispatch keeps the sync effect below clear of
  // react-hooks/set-state-in-effect.
  const [editingSaved, setEditingSaved] = useReducer((_, v) => v, null);

  // Which saved matrix the current filter IS, if any. Fingerprint-matched, so a
  // matrix that was only folded or drilled still recognises itself.
  const savedMatch = matchSavedMatrix(savedFilters, filter, wizardPreferredSavedId(editingSaved, initialFilter));
  useEffect(() => {
    // Identity, not id: a re-read list (after a sharing change) brings a fresh row
    // whose shared state must replace the stale one.
    if (initialFilter && savedMatch && savedMatch !== editingSaved) setEditingSaved(savedMatch);
  }, [initialFilter, savedMatch, editingSaved]);

  // The saved-matrix list carries each matrix's shared state (#1202), so it is
  // re-read after sharing changes — hence the bump key rather than a one-shot fetch.
  const [savedReloadKey, reloadSavedFilters] = useReducer(n => n + 1, 0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    authFetch('/api/matrix/saved-filters')
      .then(r => r.ok ? r.json() : [])
      .then(rows => { if (!cancelled) setSavedFilters(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setSavedFilters([]); });
    return () => { cancelled = true; };
  }, [open, authFetch, savedReloadKey]);

  const { subjectColumns, resourceColumns } = useColumns(authFetch, open, filter.rowType);
  const { preview, loading: previewLoading } = usePreview(authFetch, open, filter);
  const { contextMeta, onContextResolved } = useContextMeta(authFetch, open, filter);

  const { steps, stepKeys, curPos, isLast, activeStep, rollupOn } = deriveSteps(filter, step);
  const blocked = matrixIsBlocked(filter, rollupOn, preview.assignmentCount);
  // The committed shape, exactly as it will load — what is shown, saved and
  // shared must be the same matrix.
  const committed = commitFilter(filter, servesViaAttrCut(filter, rollupOn, preview.assignmentCount));

  const save = useWizardSave({
    authFetch, dialog, editing: editingSaved, savedMatch, managed, committed, onApply,
    showAs: appliedSavedMatrix({ savedMatch, editingSaved, savedFilters, initialFilter }),
    onSaved: (row) => {
      const merged = { ...savedFilters.find(f => f.id === row.id), ...row };
      setSavedFilters(prev => [...prev.filter(f => f.id !== row.id), merged].sort((a, b) => a.name.localeCompare(b.name)));
      setEditingSaved(merged);
    },
  });

  // Reset state when reopened. Done during render on the closed→open
  // transition (React's "adjusting state when a prop changes" pattern) rather
  // than in an effect, so it doesn't trip react-hooks/set-state-in-effect.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setFilter(normalizeMatrixFilter(initialFilter));
      setManaged(initialManaged);
      setStep(resolveInitialStep(initialStep));
      setEditingSaved(null);
      save.reset();
    }
  }

  // ─── Mutators ──────────────────────────────────────────────────

  const patchFilter = useCallback((patch) => setFilter(prev => ({ ...prev, ...patch })), []);
  // Row type flips clear the subject conditions, because the columns differ.
  const setRowType = useCallback((rowType) => setFilter(prev => (
    prev.rowType === rowType ? prev : { ...prev, rowType, subject: { include: [], exclude: [] } }
  )), []);
  const editBlock = useCallback((block, side, change) => setFilter(prev => ({
    ...prev,
    [block]: { ...prev[block], [side]: change(prev[block][side]) },
  })), []);
  const conditionProps = (block) => ({
    contextMeta,
    onContextResolved,
    onAdd: (side, cond) => editBlock(block, side, list => [...list, cond]),
    onRemove: (side, idx) => editBlock(block, side, list => list.filter((_, i) => i !== idx)),
    onUpdate: (side, idx, patch) => editBlock(block, side, list => list.map((c, i) => i === idx ? { ...c, ...patch } : c)),
  });

  if (!open) return null;

  const goNext = () => setStep(stepKeys[Math.min(curPos + 1, steps.length - 1)]);
  const goBack = () => setStep(stepKeys[Math.max(curPos - 1, 0)]);
  const warning = save.action.kind === 'update' && editingSaved?.shared ? liveShareWarning(editingSaved) : '';

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <Modal
      title={initialFilter ? 'Adjust matrix' : 'Create matrix'}
      subtitle="Choose who and what the matrix compares and how it reads, then show it — or name it to save it. The matrix only loads once you do."
      onClose={onClose}
      width={760}
    >
      <div className="flex items-center justify-end gap-2 mb-3 pb-3 border-b border-gray-100 dark:border-gray-700">
        <StepIndicator steps={steps} current={activeStep} onJump={setStep} />
      </div>

      {activeStep === 'subjects' && (
        <WizardSubjectsStep
          filter={filter}
          columns={subjectColumns}
          onRowTypeChange={setRowType}
          {...conditionProps('subject')}
        />
      )}
      {activeStep === 'resources' && (
        <WizardResourcesStep
          filter={filter}
          columns={resourceColumns}
          onFlagChange={(key, value) => patchFilter({ [key]: value })}
          {...conditionProps('resource')}
        />
      )}
      {activeStep === 'layout' && (
        <WizardLayoutStep
          filter={filter}
          columns={subjectColumns}
          contextMeta={contextMeta}
          rollupOn={rollupOn}
          assignmentCount={preview.assignmentCount}
          managed={managed}
          onManagedChange={setManaged}
          onPatch={patchFilter}
          onRollupModeChange={(mode, attribute) => setFilter(prev => applyRollupMode(prev, mode, attribute))}
          onContextResolved={onContextResolved}
        />
      )}
      {activeStep === 'save' && (
        <WizardSaveStep
          save={save}
          editing={editingSaved}
          filter={committed}
          managed={managed}
          blocked={blocked}
          onSharingChanged={reloadSavedFilters}
        />
      )}
      <WizardLiveSummary preview={preview} loading={previewLoading} filter={filter} rollupOn={rollupOn} />

      {warning && (
        <p className="mt-3 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800 dark:border-blue-700 dark:bg-blue-900/20 dark:text-blue-300">
          {warning}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-gray-100 dark:border-gray-700">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        {curPos > 0 && <SecondaryButton onClick={goBack}>Back</SecondaryButton>}
        {isLast
          ? (
            <PrimaryButton onClick={save.submit} disabled={blocked || save.busy}>
              {save.busy ? 'Saving…' : save.action.label}
            </PrimaryButton>
          )
          : <PrimaryButton onClick={goNext}>Next</PrimaryButton>}
      </div>
    </Modal>
  );
}

// ─── Step indicator ────────────────────────────────────────────────

function StepIndicator({ steps, current, onJump }) {
  // Map the keyed, already-filtered step list onto the shared Stepper's
  // sequential numbering.
  const stepperSteps = steps.map((s, i) => ({ n: i + 1, label: s.label }));
  const curN = Math.max(1, steps.findIndex(s => s.key === current) + 1);
  return <Stepper steps={stepperSteps} current={curN} onStepClick={(n) => onJump(steps[n - 1].key)} allowAll />;
}

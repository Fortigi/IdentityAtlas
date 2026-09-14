// Stepped modal that builds a Matrix. The user must complete this before the
// matrix loads any data.
//
//   Setup      — subject type + orientation
//   Content    — what a roll-up puts in the grid (roll-up only)
//   Subjects   — which users/identities to include
//   Resources  — which resources to include (unless rolling up roles only)
//   Sort       — column order / fold / trends panel (flat matrices only)
//   Share      — hand this view to named colleagues (matrixSharing flag + `data.share`)
//
// The list is dynamic; deriveSteps() in the helpers file owns which steps a
// given filter and permission set actually show.
//
// Each step shows live counts so the analyst can see the size of the
// sub-selection grow/shrink as they tweak conditions. The final "Apply" button
// commits the matrix to the parent (which triggers the data fetch).
//
// Saved matrices are org-wide (any user can load/rename/delete any saved
// matrix) and live in the `SavedMatrixFilters` table (name retained for
// backward compat; the user-facing term is "matrix").

import { useEffect, useReducer, useState, useCallback, useRef } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useCanShareMatrix } from '@ui/hooks/useCanShareMatrix';
import Stepper from '@ui/components/Stepper';
import { Modal, PrimaryButton, SecondaryButton, ErrorBox } from '@ui/components/contexts/ModalPrimitives';
import ContextPicker from '@ui/components/contexts/ContextPicker';
import AttributePicker from './AttributePicker';
import { variantMeta, targetTypeMeta } from '@ui/utils/contextStyles';
import { useDialog } from '@ui/components/dialogContext';
import { attributeLabel, friendlyLabel } from '@ui/utils/formatters';
import { normalizeMatrixFilter } from '@ui/utils/matrixFilter';
import { deriveSteps, commitFilter, FOLD_AUTO_THRESHOLD } from './MatrixFilterWizard.helpers';
import MatrixSortStep from './MatrixSortStep';
import WizardShareStep from './WizardShareStep';
import SavedMatrixMenu from './SavedMatrixMenu';
import SaveMatrixDialog from './SaveMatrixDialog';
import { matchSavedMatrix, tagWithSavedMatrix, wizardPreferredSavedId } from './shareState';

// ─── Constants ──────────────────────────────────────────────────────

const WARN_ASSIGNMENTS  =  5_000;
const BLOCK_ASSIGNMENTS = 25_000;

function willLoadFolded(filter, assignmentCount) {
  const fol = filter?.foldOnLoad ?? 'auto';
  if (fol === true) return true;
  if (fol === false) return false;
  return (assignmentCount || 0) >= FOLD_AUTO_THRESHOLD;
}

// An oversized FLAT matrix can still load efficiently IF it will open folded on
// attributes: we then serve it as a server-aggregated layered view (counts +
// expand-in-place) instead of shipping every per-subject row. (Small matrices
// keep the detailed per-subject grid; an oversized *unfolded* matrix can't.)
function servesViaAttrCut(filter, anyRollup, assignmentCount) {
  if (anyRollup || filter?.sortHierarchy) return false;
  if ((assignmentCount || 0) <= BLOCK_ASSIGNMENTS) return false;
  return (filter?.sortAttributes?.length || 0) > 0 && willLoadFolded(filter, assignmentCount);
}

// Server-aggregated views return a compact payload, so they load at any size:
// attribute roll-up, context roll-up, Manager-Hierarchy sort, and an oversized
// attribute fold served via the layered attribute cut.
function isServerAggregated(filter, anyRollup, assignmentCount) {
  return anyRollup || !!filter?.sortHierarchy || servesViaAttrCut(filter, anyRollup, assignmentCount);
}

// Hard-block only an oversized FLAT matrix that won't fold — folding the columns
// is what lets us aggregate it on the server; an unfolded oversized grid would
// have to ship every per-subject row, which can't be loaded.
function matrixIsBlocked(filter, anyRollup, assignmentCount) {
  if (anyRollup || filter?.sortHierarchy) return false;
  if ((assignmentCount || 0) <= BLOCK_ASSIGNMENTS) return false;
  return !(((filter?.sortAttributes?.length || 0) > 0) && willLoadFolded(filter, assignmentCount));
}

function filterHasAnyCondition(f) {
  if (!f) return false;
  const blocks = [f.subject, f.resource];
  for (const b of blocks) {
    if (b && ((b.include?.length || 0) > 0 || (b.exclude?.length || 0) > 0)) return true;
  }
  return false;
}

// ─── Wizard component ──────────────────────────────────────────────

export default function MatrixFilterWizard({
  open,
  initialFilter,
  initialManaged = 'all',
  onApply,
  onClose,
}) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  // Sharing is offered as the wizard's last step, but only when the feature is
  // switched on and the user may create a share — otherwise it would be a dead
  // end (#1166).
  const canShare = useCanShareMatrix();
  const [step, setStep] = useState('setup');
  // Normalised (never structuredClone'd raw): the filter can arrive from a URL,
  // a saved matrix, or the seeded org default, any of which may be missing
  // fields the steps read directly. See utils/matrixFilter.js.
  const [filter, setFilter] = useState(() => normalizeMatrixFilter(initialFilter));
  // The All / Governed / Non-governed toggle lives in the matrix toolbar, not
  // the wizard, but it's part of a saved matrix — carry it so save/load and
  // Apply round-trip it. The wizard has no UI to change it; loading a saved
  // matrix overrides it.
  const [managed, setManaged] = useState(initialManaged);
  const [savedFilters, setSavedFilters] = useState([]);
  const [contextMeta, setContextMeta] = useState(new Map());  // id → context row
  const [error, setError] = useState(null);

  // Column metadata for each entity (Principal / Identity / Resource).
  // Loaded lazily — Principal/Resource on open, Identity only when rowType=identity.
  const [principalColumns, setPrincipalColumns] = useState(null);
  const [identityColumns,  setIdentityColumns]  = useState(null);
  const [resourceColumns,  setResourceColumns]  = useState(null);

  // Preview counts (subjectCount / total, resourceCount / total, assignments).
  // Re-fetched (debounced) whenever the filter changes.
  const [preview, setPreview] = useState({ subjectCount: 0, subjectTotal: 0, resourceCount: 0, resourceTotal: 0, assignmentCount: 0 });
  const [previewLoading, setPreviewLoading] = useState(false);

  // Save-matrix dialog state.
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving]   = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Which saved matrix the wizard is EDITING. `savedMatch` answers "does the
  // current filter equal a saved one" and goes null the moment anything is
  // changed; this remembers which matrix those changes belong to, so Save can
  // offer to write them back instead of demanding a second name (#1202).
  // Value-only state; a reducer dispatch keeps the sync effect below clear of
  // react-hooks/set-state-in-effect.
  const [editingSaved, setEditingSaved] = useReducer((_, v) => v, null);

  // Which saved matrix the current filter IS, if any. Fingerprint-matched, so a
  // matrix that was only folded or drilled still recognises itself.
  // The matrix being edited wins a tie, or — before the list has matched
  // anything — the one the wizard was opened on.
  const savedMatch = matchSavedMatrix(savedFilters, filter, wizardPreferredSavedId(editingSaved, initialFilter));
  useEffect(() => {
    if (savedMatch && savedMatch.id !== editingSaved?.id) setEditingSaved(savedMatch);
  }, [savedMatch, editingSaved]);

  // Reset state when reopened. Done during render on the closed→open
  // transition (React's "adjusting state when a prop changes" pattern) rather
  // than in an effect, so it doesn't trip react-hooks/set-state-in-effect.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setFilter(normalizeMatrixFilter(initialFilter));
      setManaged(initialManaged);
      setStep('setup');
      setError(null);
      setEditingSaved(null);
    }
  }

  // Load saved filters and column schemas when the modal opens. The list also
  // carries each matrix's shared state (#1202), so it is re-read after sharing
  // changes — hence the bump key rather than a one-shot fetch.
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

  // Schema-only first for a fast paint, then full values in the background.
  //
  // Both requests are in flight at once and either can answer first, so the fast
  // one must never be allowed to land on top of the full one. It carries no
  // values and none of the ext.* extension attributes derived from them, and
  // nothing on screen distinguishes that placeholder list from a deployment that
  // genuinely has neither — the wizard just settles into offering every field
  // with a "(0)" count and no extension attributes at all, permanently. That
  // last-write-wins race made three matrix e2e specs intermittent (~30-40% of
  // runs) before the guard below.
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

  // Lazy-load Identity columns when the user switches rowType=identity.
  useEffect(() => {
    if (!open) return;
    if (filter.rowType !== 'identity' || identityColumns) return;
    return loadColumns('Identity', setIdentityColumns);
  }, [open, filter.rowType, identityColumns, loadColumns]);

  // Resolve context metadata for any context-id referenced by the filter so
  // chips render names instead of UUIDs. Cached across edits.
  useEffect(() => {
    if (!open) return;
    const seen = new Set();
    const missing = [];
    for (const block of [filter.subject, filter.resource]) {
      for (const side of [block.include, block.exclude]) {
        for (const c of side) {
          if (c?.kind === 'context' && !seen.has(c.contextId) && !contextMeta.has(c.contextId)) {
            seen.add(c.contextId);
            missing.push(c.contextId);
          }
        }
      }
    }
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

  // Debounced preview — re-fetch counts 250ms after the last filter mutation.
  const previewTimer = useRef(null);
  const previewAbort = useRef(null);
  useEffect(() => {
    if (!open) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      if (previewAbort.current) previewAbort.current.abort();
      const controller = new AbortController();
      previewAbort.current = controller;
      setPreviewLoading(true);
      try {
        const res = await authFetch('/api/matrix/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter }),
          signal: controller.signal,
        });
        if (!res.ok) {
          setPreviewLoading(false);
          return;
        }
        const body = await res.json();
        setPreview({
          subjectCount:    body.subjectCount    || 0,
          subjectTotal:    body.subjectTotal    || 0,
          resourceCount:   body.resourceCount   || 0,
          resourceTotal:   body.resourceTotal   || 0,
          assignmentCount: body.assignmentCount || 0,
        });
        setPreviewLoading(false);
      } catch (err) {
        if (err.name !== 'AbortError') setPreviewLoading(false);
      }
    }, 250);
    return () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    };
  }, [filter, open, authFetch]);

  // ─── Mutators ──────────────────────────────────────────────────

  const setRowType = useCallback((rowType) => {
    // Clearing subject conditions when row type flips, because columns differ.
    setFilter(prev => ({
      ...prev,
      rowType,
      subject: { include: [], exclude: [] },
    }));
  }, []);

  const addCondition = useCallback((block, side, cond) => {
    setFilter(prev => ({
      ...prev,
      [block]: {
        ...prev[block],
        [side]: [...prev[block][side], cond],
      },
    }));
  }, []);
  const removeCondition = useCallback((block, side, index) => {
    setFilter(prev => ({
      ...prev,
      [block]: {
        ...prev[block],
        [side]: prev[block][side].filter((_, i) => i !== index),
      },
    }));
  }, []);
  const updateCondition = useCallback((block, side, index, patch) => {
    setFilter(prev => ({
      ...prev,
      [block]: {
        ...prev[block],
        [side]: prev[block][side].map((c, i) => i === index ? { ...c, ...patch } : c),
      },
    }));
  }, []);

  // ─── Apply / Cancel ────────────────────────────────────────────

  const handleApply = () => {
    // Roll-up (attribute or context tree) returns an aggregated (small) payload,
    // so the size guard doesn't apply.
    const anyRollup = !!filter.rollup || (filter.rollupKind === 'context' && !!filter.rollupContextId);
    if (matrixIsBlocked(filter, anyRollup, preview.assignmentCount)) {
      setError(`Matrix too large (${preview.assignmentCount.toLocaleString()} assignments) to load as a per-subject grid. Sort by Manager Hierarchy or roll up by an attribute, or add filters to reduce below ${BLOCK_ASSIGNMENTS.toLocaleString()}.`);
      return;
    }
    // Oversized but foldable on attributes → serve it as the layered,
    // server-aggregated attribute view (a fresh expand state each apply).
    const foldAttributes = servesViaAttrCut(filter, anyRollup, preview.assignmentCount);
    // Tag the applied matrix with the saved one it is, so the save bar names
    // the right one when two saved matrices share a filter.
    onApply(tagWithSavedMatrix(commitFilter(filter, foldAttributes), savedMatch), managed);
  };

  // ─── Save matrix ───────────────────────────────────────────────

  // Saving the change back to the matrix being edited, rather than under a
  // second name (#1202). Recipients of a shared matrix see the change — the
  // dialog says so before this runs.
  const handleUpdate = async () => {
    if (!editingSaved) return;
    setSaveError(null);
    setSaving(true);
    try {
      const res = await authFetch(`/api/matrix/saved-filters/${editingSaved.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: { ...filter, managed } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSaveOpen(false);
      setSaveName('');
      reloadSavedFilters();
    } catch (err) {
      setSaveError(err.message || 'Failed to save the matrix');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaveError(null);
    setSaving(true);
    try {
      const res = await authFetch('/api/matrix/saved-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Persist the toolbar's managed-state toggle alongside the wizard
        // filter so a saved matrix restores exactly what the user saw.
        body: JSON.stringify({ name: saveName.trim(), filter: { ...filter, managed } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const saved = await res.json();
      setSavedFilters(prev => [...prev.filter(f => f.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      setSaveOpen(false);
      setSaveName('');
      setEditingSaved(saved);
    } catch (err) {
      setSaveError(err.message || 'Failed to save filter');
    } finally {
      setSaving(false);
    }
  };

  // The warning — including "this is shared with N people" — is SavedMatrixMenu's,
  // because it is the component that knows each row's shared state.
  const handleDeleteSaved = async (id) => {
    await authFetch(`/api/matrix/saved-filters/${id}`, { method: 'DELETE' }).catch(() => {});
    setSavedFilters(prev => prev.filter(f => f.id !== id));
  };
  const handleLoadSaved = (id) => {
    const row = savedFilters.find(f => f.id === id);
    if (!row) return;
    setEditingSaved(row);
    // Normalise — older saves might be missing fields (e.g. orientation
    // didn't exist before). Loading a saved matrix always starts from a clean
    // view state, unlike adjusting the open one.
    const f = row.filter || {};
    setFilter({
      ...normalizeMatrixFilter(f),
      rollupExpanded: [],
      rollupCollapsed: [],
      foldAttributes: false,
    });
    setManaged(['all', 'managed', 'unmanaged', 'gaps'].includes(f.managed) ? f.managed : 'all');
    setStep('subjects');
  };

  if (!open) return null;

  const subjectColumns = filter.rowType === 'identity' ? identityColumns : principalColumns;
  // Dynamic, keyed steps + derived navigation position (see helpers file).
  const { steps, stepKeys, curPos, isLast, activeStep, rollupOn } = deriveSteps(filter, step, { canShare });
  const goNext = () => setStep(stepKeys[Math.min(curPos + 1, steps.length - 1)]);
  const goBack = () => setStep(stepKeys[Math.max(curPos - 1, 0)]);

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <Modal
      title={initialFilter ? 'Adjust matrix' : 'Create matrix'}
      subtitle="Pick the layout, then narrow the subjects and resources to compare. The matrix only loads once you apply."
      onClose={onClose}
      width={760}
    >
      {/* Saved filters loader + step indicator */}
      <div className="flex items-center justify-between gap-2 mb-3 pb-3 border-b border-gray-100 dark:border-gray-700">
        <SavedMatrixMenu
          savedFilters={savedFilters}
          onLoad={handleLoadSaved}
          onDelete={handleDeleteSaved}
          label="Saved matrices"
        />
        <StepIndicator steps={steps} current={activeStep} onJump={setStep} />
      </div>

      {/* Step content */}
      {activeStep === 'setup' && (
        <Step1Setup
          rowType={filter.rowType}
          onRowTypeChange={setRowType}
        />
      )}
      {activeStep === 'content' && (
        <Step2Content
          rollupContent={filter.rollupContent}
          rollupMetric={filter.rollupMetric}
          rollup={filter.rollup}
          onChange={(rollupContent) => setFilter(prev => ({ ...prev, rollupContent }))}
          onMetricChange={(rollupMetric) => setFilter(prev => ({ ...prev, rollupMetric }))}
        />
      )}
      {activeStep === 'subjects' && (
        <Step2Subject
          rowType={filter.rowType}
          subject={filter.subject}
          contextMeta={contextMeta}
          columns={subjectColumns}
          onContextResolved={(node) => setContextMeta(prev => new Map(prev).set(node.id, node))}
          onAdd={(side, cond) => addCondition('subject', side, cond)}
          onRemove={(side, idx) => removeCondition('subject', side, idx)}
          onUpdate={(side, idx, patch) => updateCondition('subject', side, idx, patch)}
        />
      )}
      {activeStep === 'resources' && (
        <>
          <Step3Resource
            resource={filter.resource}
            contextMeta={contextMeta}
            columns={resourceColumns}
            onContextResolved={(node) => setContextMeta(prev => new Map(prev).set(node.id, node))}
            onAdd={(side, cond) => addCondition('resource', side, cond)}
            onRemove={(side, idx) => removeCondition('resource', side, idx)}
            onUpdate={(side, idx, patch) => updateCondition('resource', side, idx, patch)}
          />
          <ResourceToggle
            label="Show business roles as foldable rows"
            checked={!!filter.includeBusinessRoles}
            onChange={(v) => setFilter(prev => ({ ...prev, includeBusinessRoles: v }))}
          >
            Business roles and access packages are governance intent, not actual access — they already
            appear as the business-role columns, so they are left off the rows by default. Tick this to
            put each role on a row of its own, with the resources it grants drawn underneath it and
            foldable into it — plus the markers that say where a subject holds more or less than the
            role assigns.
          </ResourceToggle>
          <ResourceToggle
            label="Include inherited access"
            checked={!!filter.includeInheritedAccess}
            onChange={(v) => setFilter(prev => ({ ...prev, includeInheritedAccess: v }))}
          >
            Also show access inherited from higher scopes — e.g. Owner on a subscription appears as
            an <strong>Indirect</strong> grant on every resource beneath it. Computed on demand, so
            it's slower; only meaningful once you've scoped to a set of resources above.
          </ResourceToggle>
        </>
      )}
      {activeStep === 'sort' && (
        <MatrixSortStep
          sortAttributes={filter.sortAttributes}
          columns={subjectColumns}
          disabled={false}
          onChange={(sortAttributes) => setFilter(prev => ({ ...prev, sortAttributes }))}
          foldOnLoad={filter.foldOnLoad}
          onFoldChange={(foldOnLoad) => setFilter(prev => ({ ...prev, foldOnLoad }))}
          assignmentCount={preview.assignmentCount || 0}
          sortHierarchy={filter.sortHierarchy}
          onHierarchyChange={(sortHierarchy) => setFilter(prev => ({ ...prev, sortHierarchy }))}
          showTrends={filter.showTrends}
          onShowTrendsChange={(showTrends) => setFilter(prev => ({ ...prev, showTrends }))}
        />
      )}
      {activeStep === 'share' && (
        <WizardShareStep
          // The committed shape, exactly as Apply would hand it to the matrix —
          // what gets shared must be the matrix that loads.
          filter={commitFilter(filter, servesViaAttrCut(filter, rollupOn, preview.assignmentCount))}
          managed={managed}
          // The saved matrix being edited, when there is one: the step shows its
          // shared state and manages it in place rather than offering to create
          // a second thing under a second name (#1202).
          saved={savedMatch}
          onSharingChanged={reloadSavedFilters}
          blocked={matrixIsBlocked(filter, rollupOn, preview.assignmentCount)}
        />
      )}
      <ErrorBox message={error} />

      {/* Live summary */}
      <LiveSummary preview={preview} loading={previewLoading} rowType={filter.rowType} rollup={filter.rollup} filter={filter} rollupOn={rollupOn} />

      {/* Footer buttons */}
      <WizardFooterButtons
        canSave={filterHasAnyCondition(filter)}
        onSave={() => setSaveOpen(true)}
        onCancel={onClose}
        onBack={goBack}
        onNext={goNext}
        onApply={handleApply}
        showBack={curPos > 0}
        showNext={!isLast}
        showApply={isLast}
        applyDisabled={matrixIsBlocked(filter, rollupOn, preview.assignmentCount)}
      />

      {/* Save dialog */}
      {saveOpen && (
        <SaveMatrixDialog
          name={saveName}
          onNameChange={setSaveName}
          onSave={handleSave}
          // Only offered when the open matrix has actually diverged from the one
          // it was loaded from — otherwise there is no change to save back.
          onUpdate={editingSaved && !savedMatch ? handleUpdate : null}
          target={editingSaved && !savedMatch ? editingSaved : null}
          onClose={() => { setSaveOpen(false); setSaveError(null); }}
          saving={saving}
          error={saveError}
        />
      )}
    </Modal>
  );
}

// ─── Footer buttons ────────────────────────────────────────────────

function WizardFooterButtons({ canSave, onSave, onCancel, onBack, onNext, onApply, showBack, showNext, showApply, applyDisabled }) {
  return (
    <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t border-gray-100 dark:border-gray-700">
      <div className="flex items-center gap-2">
        <SecondaryButton onClick={onSave} disabled={!canSave}>
          Save matrix…
        </SecondaryButton>
      </div>
      <div className="flex items-center gap-2">
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        {showBack && <SecondaryButton onClick={onBack}>Back</SecondaryButton>}
        {showNext && <PrimaryButton onClick={onNext}>Next</PrimaryButton>}
        {showApply && (
          <PrimaryButton onClick={onApply} disabled={applyDisabled}>
            Apply
          </PrimaryButton>
        )}
      </div>
    </div>
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

// ─── Step 2 — Roll-up content (what the roll-up shows) ──────────────
export function Step2Content({ rollupContent, rollupMetric, rollup, onChange, onMetricChange }) {
  const options = [
    { key: 'roles-only',          title: 'Business roles only',     description: 'Business roles go on the rows; each cell counts the subjects in that group who hold the role. The resource filter step is skipped.' },
    { key: 'resources-and-roles', title: 'Resources and business roles', description: 'Resources on the rows with the roll-up groups, plus a count column per business role (the default).' },
    { key: 'resources-only',      title: 'Resources only',          description: 'Resources on the rows with the roll-up groups, without the business-role columns.' },
  ];
  const metricOptions = [
    { key: 'count',   title: 'Count (#)',            description: 'Each cell shows the number of subjects in the group who hold it (the default).' },
    { key: 'percent', title: 'Percentage (%)',       description: 'Each cell shows the share of the group that holds it — e.g. 8 of 10 in a department shows as 80%.' },
  ];
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 mb-2">Roll-up content</h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          {rollup
            ? <>You rolled up by <span className="font-semibold">{attributeLabel(rollup) || friendlyLabel(String(rollup).replace(/^ext\./, ''))}</span>. Choose what to put in the matrix.</>
            : <>You rolled up by <span className="font-semibold">Manager Hierarchy</span>. Choose what to put in the matrix.</>}
        </p>
        <div className="space-y-2">
          {options.map(o => (
            <RadioCard
              key={o.key}
              active={(rollupContent || 'resources-and-roles') === o.key}
              onClick={() => onChange(o.key)}
              title={o.title}
              description={o.description}
            />
          ))}
        </div>
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 mb-2">Cell value</h4>
        <div className="space-y-2">
          {metricOptions.map(o => (
            <RadioCard
              key={o.key}
              active={(rollupMetric || 'count') === o.key}
              onClick={() => onMetricChange(o.key)}
              title={o.title}
              description={o.description}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Live summary footer ───────────────────────────────────────────

function LiveSummary({ preview, loading, rowType, rollup, filter, rollupOn }) {
  const subjectLabel = rowType === 'identity' ? 'identities' : 'users';
  const subjectPct = preview.subjectTotal > 0
    ? Math.round((preview.subjectCount / preview.subjectTotal) * 100)
    : 0;
  const resourcePct = preview.resourceTotal > 0
    ? Math.round((preview.resourceCount / preview.resourceTotal) * 100)
    : 0;

  // Server-aggregated views (roll-up / Manager-Hierarchy) return a compact
  // payload, so they load at any size. A flat per-subject matrix ships every
  // row — folding only collapses the render, not the fetch — so an oversized
  // flat matrix is hard-blocked regardless of fold.
  const aggregated = isServerAggregated(filter, rollupOn, preview.assignmentCount);
  const blocked   = matrixIsBlocked(filter, rollupOn, preview.assignmentCount);
  const bigAgg    = aggregated && preview.assignmentCount > WARN_ASSIGNMENTS;
  const large     = !aggregated && !blocked && preview.assignmentCount > WARN_ASSIGNMENTS;

  const countClass = blocked
    ? 'font-semibold text-red-700 dark:text-red-400'
    : large
      ? 'font-semibold text-amber-700 dark:text-amber-400'
      : 'font-semibold text-gray-800 dark:text-gray-200';

  return (
    <div className={`mt-3 text-xs bg-gray-50 dark:bg-gray-700/30 border rounded px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 ${
      blocked ? 'border-red-300 dark:border-red-700' : large ? 'border-amber-300 dark:border-amber-700' : 'border-gray-100 dark:border-gray-700'
    } text-gray-600 dark:text-gray-400`}>
      <div>
        <span className="font-semibold text-gray-800 dark:text-gray-200">{preview.subjectCount.toLocaleString()}</span>
        {' '}of {preview.subjectTotal.toLocaleString()} {subjectLabel}
        <span className="text-gray-600 dark:text-gray-400"> · {subjectPct}%</span>
      </div>
      <div className="text-gray-500 dark:text-gray-400">×</div>
      <div>
        <span className="font-semibold text-gray-800 dark:text-gray-200">{preview.resourceCount.toLocaleString()}</span>
        {' '}of {preview.resourceTotal.toLocaleString()} resources
        <span className="text-gray-600 dark:text-gray-400"> · {resourcePct}%</span>
      </div>
      <div className="text-gray-500 dark:text-gray-400">·</div>
      <div>
        <span className={countClass}>{preview.assignmentCount.toLocaleString()}</span>
        {' '}assignments
        {blocked && <span className="ml-1 text-red-700 dark:text-red-400">— too large to load as a per-subject grid (folding only collapses the view, not the load). Sort by Manager Hierarchy or roll up by an attribute, or add filters to get below {BLOCK_ASSIGNMENTS.toLocaleString()}.</span>}
        {large   && <span className="ml-1 text-amber-700 dark:text-amber-400">— large, consider narrowing</span>}
        {bigAgg  && <span className="ml-1 text-blue-700 dark:text-blue-400">— aggregated on the server, loads at any size</span>}
      </div>
      {loading && (
        <div className="ml-auto text-[10px] text-gray-600 dark:text-gray-400">updating…</div>
      )}
    </div>
  );
}

// ─── Step 1 — Setup (subject type + roll-up) ────────────────────────

function Step1Setup({ rowType, onRowTypeChange }) {
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 mb-2">Subject type</h4>
        <div className="space-y-2">
          <RadioCard
            active={rowType === 'principal'}
            onClick={() => onRowTypeChange('principal')}
            title="User accounts"
            description="Each subject is one Principal (a single account). Best when you want to see exactly which accounts have which access — clean-up sweeps and per-account audits."
          />
          <RadioCard
            active={rowType === 'identity'}
            onClick={() => onRowTypeChange('identity')}
            title="Identities"
            description="Each subject is one correlated person, unioning across their accounts. A cell is filled if any underlying account has the assignment. Best for role-mining and birthright analysis."
          />
        </div>
        <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
          Sort the columns by one or more attributes in the Sort step — then fold any group into a single count column right in the matrix.
        </p>
      </div>
    </div>
  );
}

function RadioCard({ active, onClick, title, description, visual }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left border rounded-lg p-3 transition-colors ${
        active
          ? 'border-blue-500 dark:border-blue-400 bg-blue-50/50 dark:bg-blue-900/20'
          : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
      }`}
    >
      <div className="flex items-start gap-2">
        <span className={`w-3 h-3 mt-1 rounded-full border-2 flex-shrink-0 ${
          active
            ? 'border-blue-500 dark:border-blue-400 bg-blue-500 dark:bg-blue-400'
            : 'border-gray-300 dark:border-gray-500'
        }`} />
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-gray-900 dark:text-white">{title}</h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{description}</p>
        </div>
        {visual && <div className="ml-2 flex-shrink-0">{visual}</div>}
      </div>
    </button>
  );
}

// ─── Steps 2 & 3 — Subjects / Resources ────────────────────────────
//
// One component, two steps: both narrow one side of the matrix with the same
// Include / Exclude condition lists, and differed only in their wording and in
// which contexts they accept. They were two copies of the same JSX until the
// duplication check caught them.

function ConditionStep({ intro, block, allowedTargets, entity, contextMeta, columns, onContextResolved, onAdd, onRemove, onUpdate, includeHint }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600 dark:text-gray-400">{intro}</p>
      {[
        { title: 'Include', side: 'include', emptyHint: includeHint },
        { title: 'Exclude', side: 'exclude', emptyHint: 'No exclude filters.' },
      ].map(({ title, side, emptyHint }) => (
        <ConditionList
          key={side}
          title={title}
          conditions={block[side]}
          allowedTargets={allowedTargets}
          contextMeta={contextMeta}
          columns={columns}
          entity={entity}
          onContextResolved={onContextResolved}
          onAdd={(c) => onAdd(side, c)}
          onRemove={(idx) => onRemove(side, idx)}
          onUpdate={(idx, patch) => onUpdate(side, idx, patch)}
          emptyHint={emptyHint}
        />
      ))}
    </div>
  );
}

function Step2Subject({ rowType, subject, ...rest }) {
  const identities = rowType === 'identity';
  return (
    <ConditionStep
      intro={`Narrow down the ${identities ? 'identities' : 'users'} that appear as rows. Includes are AND'd; excludes negate.`}
      block={subject}
      allowedTargets={identities ? ['Identity'] : ['Principal']}
      entity={identities ? 'Identity' : 'Principal'}
      includeHint="No include filters — every row matches."
      {...rest}
    />
  );
}

function Step3Resource({ resource, ...rest }) {
  return (
    <ConditionStep
      intro="Narrow down the resources that appear as columns. Includes are AND'd; excludes negate."
      block={resource}
      allowedTargets={['Resource', 'System']}
      entity="Resource"
      includeHint="No include filters — every resource matches."
      {...rest}
    />
  );
}

// One opt-in checkbox below the resource conditions (row visibility, inherited
// access): a real <label> so the box is reachable by its accessible name, with
// the explanation as help text under it.
function ResourceToggle({ label, checked, onChange, children }) {
  return (
    <label className="mt-5 flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
      <input
        type="checkbox"
        className="mt-0.5 rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        <span className="block text-xs text-gray-500 dark:text-gray-400">{children}</span>
      </span>
    </label>
  );
}

// ─── Condition list ────────────────────────────────────────────────

function ConditionList({ title, conditions, contextMeta, columns, entity, onContextResolved, onAdd, onRemove, onUpdate, emptyHint, allowedTargets }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attrOpen, setAttrOpen] = useState(false);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-gray-50 dark:bg-gray-700/30 border-b border-gray-100 dark:border-gray-700">
        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{title}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPickerOpen(true)}
            className="text-[11px] px-2 py-0.5 rounded border border-dashed border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
          >
            + Context
          </button>
          <button
            onClick={() => setAttrOpen(true)}
            className="text-[11px] px-2 py-0.5 rounded border border-dashed border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:border-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
          >
            + Attribute
          </button>
        </div>
      </div>
      <div className="p-2 space-y-1.5">
        {conditions.length === 0 ? (
          <p className="text-[11px] text-gray-600 dark:text-gray-400 italic">{emptyHint}</p>
        ) : (
          conditions.map((cond, idx) => (
            <ConditionRow
              key={idx}
              cond={cond}
              contextMeta={contextMeta}
              onRemove={() => onRemove(idx)}
              onUpdate={(patch) => onUpdate(idx, patch)}
            />
          ))
        )}
      </div>

      <ContextPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        targetTypes={allowedTargets}
        onPick={(node) => {
          onAdd({ kind: 'context', contextId: node.id, includeChildren: true });
          if (node) onContextResolved(node);
          setPickerOpen(false);
        }}
        title={`Pick a context for ${title.toLowerCase()}`}
        subtitle="Resource and System contexts apply to the resource side; Identity, Principal contexts to the subject side."
      />
      {attrOpen && (
        <AttributePicker
          entity={entity}
          columns={columns}
          onPick={(field, values) => {
            onAdd({ kind: 'attribute', field, values });
            setAttrOpen(false);
          }}
          onClose={() => setAttrOpen(false)}
        />
      )}
    </div>
  );
}

function ConditionRow({ cond, contextMeta, onRemove, onUpdate }) {
  if (cond.kind === 'context') {
    const meta = contextMeta.get(cond.contextId);
    const variant = meta ? variantMeta(meta.variant) : null;
    const target = meta ? targetTypeMeta(meta.targetType) : null;
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 bg-slate-50 dark:bg-gray-700/50 border border-slate-200 dark:border-gray-600 rounded px-2 py-1 flex-1 min-w-0">
          {variant && <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${variant.dotClass}`} aria-hidden="true" />}
          <span className="text-gray-500 dark:text-gray-400 font-medium uppercase text-[10px]">Context</span>
          <span className="truncate text-gray-800 dark:text-gray-200" title={meta ? meta.displayName : cond.contextId}>
            {meta ? meta.displayName : cond.contextId.slice(0, 8)}
          </span>
          {target && <span className={`text-[9px] px-1 rounded border flex-shrink-0 ${target.badgeClass}`}>{target.label}</span>}
          <label className="inline-flex items-center gap-1 text-slate-500 dark:text-gray-400 cursor-pointer ml-auto text-[10px]">
            <input
              type="checkbox"
              checked={!!cond.includeChildren}
              onChange={() => onUpdate({ includeChildren: !cond.includeChildren })}
              className="w-3 h-3"
            />
            <span>incl. descendants</span>
          </label>
        </span>
        <button onClick={onRemove} className="text-gray-600 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400" aria-label="Remove">×</button>
      </div>
    );
  }
  if (cond.kind === 'attribute') {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 bg-slate-50 dark:bg-gray-700/50 border border-slate-200 dark:border-gray-600 rounded px-2 py-1 flex-1 min-w-0">
          <span className="text-gray-500 dark:text-gray-400 font-medium uppercase text-[10px]">{cond.field}</span>
          <span className="text-gray-600 dark:text-gray-500">in</span>
          <span className="truncate text-gray-800 dark:text-gray-200 flex-1">
            {(cond.values || []).join(', ')}
          </span>
        </span>
        <button onClick={onRemove} className="text-gray-600 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400" aria-label="Remove">×</button>
      </div>
    );
  }
  return null;
}

// 3-step modal that builds a Matrix. The user must complete this before the
// matrix loads any data.
//
//   Step 1 — Setup              (subject type + orientation)
//   Step 2 — Subject conditions (which users/identities to include)
//   Step 3 — Resource conditions (which resources to include)
//
// Each step shows live counts so the analyst can see the size of the
// sub-selection grow/shrink as they tweak conditions. The final "Apply" button
// commits the matrix to the parent (which triggers the data fetch).
//
// Saved matrices are org-wide (any user can load/rename/delete any saved
// matrix) and live in the `SavedMatrixFilters` table (name retained for
// backward compat; the user-facing term is "matrix").

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useAuth } from '../../auth/AuthGate';
import Stepper from '../Stepper';
import { Modal, PrimaryButton, SecondaryButton, ErrorBox } from '../contexts/ModalPrimitives';
import ContextPicker from '../contexts/ContextPicker';
import { variantMeta, targetTypeMeta } from '../../utils/contextStyles';
import { friendlyLabel } from '../../utils/formatters';

// ─── Constants ──────────────────────────────────────────────────────

const WARN_ASSIGNMENTS  =  5_000;
const BLOCK_ASSIGNMENTS = 25_000;

const EMPTY_FILTER = {
  rowType: 'principal',
  // 'rows-as-resources' — resources on the row axis, subjects on the column
  //                      axis (current default, good when many resources +
  //                      few subjects, since vertical scroll is easier).
  // 'rows-as-subjects'  — subjects on the row axis, resources on the column
  //                      axis (rotated, good when few resources + many
  //                      subjects).
  orientation: 'rows-as-resources',
  subject:  { include: [], exclude: [] },
  resource: { include: [], exclude: [] },
  // Roll-up: aggregate the subject (column) axis by this attribute. null = off.
  rollup: null,
  // What the roll-up shows (only when rollup is set):
  //   'resources-and-roles' — resources as rows + business-role count columns (default)
  //   'resources-only'      — resources as rows, no business-role columns
  //   'roles-only'          — business roles as rows (resource filter is skipped)
  rollupContent: 'resources-and-roles',
  // How each roll-up cell is shown: 'count' (absolute, default) or 'percent'
  // (share of the in-scope subjects in that group who hold it).
  rollupMetric: 'count',
  // EXPERIMENTAL — aggregate by a Context tree (Manager Hierarchy) instead of an
  // attribute. 'attribute' uses `rollup`; 'context' uses rollupContextId (the
  // starting node) and rollupPath (the drill path from root to current focus).
  rollupKind: 'attribute',
  rollupContextId: null,
  rollupPath: [],
  // Subject-axis sort order — 1..6 attributes, applied client-side. Default
  // groups columns by department.
  sortAttributes: [{ attribute: 'department', dir: 'asc' }],
  // Sort the columns by a Manager-Hierarchy context tree instead of attributes.
  // { contextId } or null (attribute sort).
  sortHierarchy: null,
  // Whether the matrix opens with its top-level groups folded into count
  // columns. 'auto' folds only when the matrix is large (keeps load fast);
  // true/false force it.
  foldOnLoad: 'auto',
};

// Above this many assignments, 'auto' fold-on-load defaults to folded so the
// first render stays fast.
const FOLD_AUTO_THRESHOLD = 5000;

// Will this matrix open with its columns folded? Folding is client-side and
// collapses the un-virtualized subject columns, so a folded matrix renders fine
// at sizes that would otherwise be too heavy. Manager-Hierarchy sort always
// opens folded; otherwise fold-on-load decides (auto folds at the threshold).
function willLoadFolded(filter, assignmentCount) {
  if (filter?.sortHierarchy) return true;
  const fol = filter?.foldOnLoad ?? 'auto';
  if (fol === true) return true;
  if (fol === false) return false;
  return (assignmentCount || 0) >= FOLD_AUTO_THRESHOLD;
}

// Hard-block loading only when the matrix is both oversized AND would open
// unfolded (where the column blowup is real). Roll-up payloads are aggregated,
// so they're never blocked. Folded loads are allowed at any size.
function matrixIsBlocked(filter, anyRollup, assignmentCount) {
  if (anyRollup) return false;
  if ((assignmentCount || 0) <= BLOCK_ASSIGNMENTS) return false;
  return !willLoadFolded(filter, assignmentCount);
}

const DEFAULT_SORT = [{ attribute: 'department', dir: 'asc' }];

// Pull selectable attribute names out of a /matrix/columns response. Excludes
// the display-name column (every value is unique, useless to group/sort by).
// When realOnly, drops ext.* keys (the flat matrix payload can't sort by them).
function attributeOptions(columns, { realOnly = false } = {}) {
  if (!Array.isArray(columns)) return [];
  return columns
    .map(c => c.column)
    .filter(Boolean)
    .filter(name => name !== 'displayName')
    .filter(name => !realOnly || !name.startsWith('ext.'));
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
  const [step, setStep] = useState('setup');
  const [filter, setFilter] = useState(() => structuredClone(initialFilter || EMPTY_FILTER));
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

  // Save-filter dialog state.
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving]   = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Reset state when reopened.
  useEffect(() => {
    if (!open) return;
    setFilter(structuredClone(initialFilter || EMPTY_FILTER));
    setManaged(initialManaged);
    setStep('setup');
    setError(null);
  }, [open, initialFilter, initialManaged]);

  // Load saved filters and column schemas when the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    authFetch('/api/matrix/saved-filters')
      .then(r => r.ok ? r.json() : [])
      .then(rows => { if (!cancelled) setSavedFilters(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setSavedFilters([]); });
    return () => { cancelled = true; };
  }, [open, authFetch]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Schema-only first for a fast paint, then full values in the background.
    authFetch('/api/matrix/columns?entity=Principal&schema=true').then(r => r.ok ? r.json() : []).then(cols => { if (!cancelled) setPrincipalColumns(cols); });
    authFetch('/api/matrix/columns?entity=Resource&schema=true').then(r => r.ok ? r.json() : []).then(cols => { if (!cancelled) setResourceColumns(cols);  });
    authFetch('/api/matrix/columns?entity=Principal').then(r => r.ok ? r.json() : []).then(cols => { if (!cancelled) setPrincipalColumns(cols); });
    authFetch('/api/matrix/columns?entity=Resource').then(r => r.ok ? r.json() : []).then(cols => { if (!cancelled) setResourceColumns(cols);  });
    return () => { cancelled = true; };
  }, [open, authFetch]);

  // Lazy-load Identity columns when the user switches rowType=identity.
  useEffect(() => {
    if (!open) return;
    if (filter.rowType !== 'identity' || identityColumns) return;
    let cancelled = false;
    authFetch('/api/matrix/columns?entity=Identity&schema=true').then(r => r.ok ? r.json() : []).then(cols => { if (!cancelled) setIdentityColumns(cols); });
    authFetch('/api/matrix/columns?entity=Identity').then(r => r.ok ? r.json() : []).then(cols => { if (!cancelled) setIdentityColumns(cols); });
    return () => { cancelled = true; };
  }, [open, filter.rowType, identityColumns, authFetch]);

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
      setError(`Matrix too large (${preview.assignmentCount.toLocaleString()} assignments) to load unfolded. Add filters to reduce below ${BLOCK_ASSIGNMENTS.toLocaleString()}, or let it open folded (Sort step).`);
      return;
    }
    onApply(filter, managed);
  };

  // ─── Save filter ───────────────────────────────────────────────

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
    } catch (err) {
      setSaveError(err.message || 'Failed to save filter');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSaved = async (id) => {
    if (!confirm('Delete this saved filter? This affects everyone in the org.')) return;
    await authFetch(`/api/matrix/saved-filters/${id}`, { method: 'DELETE' }).catch(() => {});
    setSavedFilters(prev => prev.filter(f => f.id !== id));
  };
  const handleLoadSaved = (id) => {
    const row = savedFilters.find(f => f.id === id);
    if (!row) return;
    // Normalise — older saves might be missing fields (e.g. orientation
    // didn't exist before).
    const f = row.filter || EMPTY_FILTER;
    setFilter({
      rowType:     f.rowType === 'identity' ? 'identity' : 'principal',
      orientation: f.orientation === 'rows-as-subjects' ? 'rows-as-subjects' : 'rows-as-resources',
      subject:  {
        include: Array.isArray(f.subject?.include) ? f.subject.include : [],
        exclude: Array.isArray(f.subject?.exclude) ? f.subject.exclude : [],
      },
      resource: {
        include: Array.isArray(f.resource?.include) ? f.resource.include : [],
        exclude: Array.isArray(f.resource?.exclude) ? f.resource.exclude : [],
      },
      rollup: typeof f.rollup === 'string' && f.rollup ? f.rollup : null,
      rollupContent: ['resources-and-roles', 'resources-only', 'roles-only'].includes(f.rollupContent)
        ? f.rollupContent : 'resources-and-roles',
      rollupMetric: f.rollupMetric === 'percent' ? 'percent' : 'count',
      rollupKind: f.rollupKind === 'context' ? 'context' : 'attribute',
      rollupContextId: typeof f.rollupContextId === 'string' && f.rollupContextId ? f.rollupContextId : null,
      rollupPath: Array.isArray(f.rollupPath) ? f.rollupPath : [],
      sortAttributes: Array.isArray(f.sortAttributes) && f.sortAttributes.length
        ? f.sortAttributes.slice(0, 6) : DEFAULT_SORT,
      foldOnLoad: [true, false, 'auto'].includes(f.foldOnLoad) ? f.foldOnLoad : 'auto',
      sortHierarchy: (f.sortHierarchy && typeof f.sortHierarchy.contextId === 'string') ? f.sortHierarchy : null,
    });
    setManaged(['all', 'managed', 'unmanaged', 'gaps'].includes(f.managed) ? f.managed : 'all');
    setStep('subjects');
  };

  if (!open) return null;

  const subjectColumns = filter.rowType === 'identity' ? identityColumns : principalColumns;
  // Dynamic, keyed steps. Attribute roll-up inserts a "Content" step
  // (resources/roles shape); roles-only drops the Resources filter. Any roll-up
  // (attribute or context tree) drops the Sort step. The context-tree roll-up
  // has no Content step (it's always resources-as-rows).
  const contextRollup = filter.rollupKind === 'context' && !!filter.rollupContextId;
  const attrRollup = !!filter.rollup;
  const rollupOn = attrRollup || contextRollup;
  // The Content step (resources / +roles / roles-only) applies to BOTH attribute
  // and context roll-ups. roles-only drops the Resources filter and Sort steps.
  const rolesOnly = rollupOn && filter.rollupContent === 'roles-only';
  const steps = [
    { key: 'setup',       label: 'Setup' },
    rollupOn ? { key: 'content', label: 'Content' } : null,
    { key: 'subjects',    label: 'Subjects' },
    rolesOnly ? null : { key: 'resources', label: 'Resources' },
    rollupOn ? null : { key: 'sort', label: 'Sort' },
    { key: 'orientation', label: 'Orientation' },
  ].filter(Boolean);
  const stepKeys = steps.map(s => s.key);
  const curPos = Math.max(0, stepKeys.indexOf(step));
  const isLast = curPos === steps.length - 1;
  const goNext = () => setStep(stepKeys[Math.min(curPos + 1, steps.length - 1)]);
  const goBack = () => setStep(stepKeys[Math.max(curPos - 1, 0)]);
  // If the current step just became hidden (toggled roll-up / content), render
  // the nearest still-visible one so the body never goes blank.
  const activeStep = stepKeys.includes(step) ? step : stepKeys[Math.min(curPos, steps.length - 1)];

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
        <SavedFilterDropdown
          savedFilters={savedFilters}
          onLoad={handleLoadSaved}
          onDelete={handleDeleteSaved}
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
          columns={filter.rowType === 'identity' ? identityColumns : principalColumns}
          onContextResolved={(node) => setContextMeta(prev => new Map(prev).set(node.id, node))}
          onAdd={(side, cond) => addCondition('subject', side, cond)}
          onRemove={(side, idx) => removeCondition('subject', side, idx)}
          onUpdate={(side, idx, patch) => updateCondition('subject', side, idx, patch)}
        />
      )}
      {activeStep === 'resources' && (
        <Step3Resource
          resource={filter.resource}
          contextMeta={contextMeta}
          columns={resourceColumns}
          onContextResolved={(node) => setContextMeta(prev => new Map(prev).set(node.id, node))}
          onAdd={(side, cond) => addCondition('resource', side, cond)}
          onRemove={(side, idx) => removeCondition('resource', side, idx)}
          onUpdate={(side, idx, patch) => updateCondition('resource', side, idx, patch)}
        />
      )}
      {activeStep === 'sort' && (
        <Step5Sort
          sortAttributes={filter.sortAttributes}
          columns={subjectColumns}
          disabled={false}
          onChange={(sortAttributes) => setFilter(prev => ({ ...prev, sortAttributes }))}
          foldOnLoad={filter.foldOnLoad}
          onFoldChange={(foldOnLoad) => setFilter(prev => ({ ...prev, foldOnLoad }))}
          assignmentCount={preview.assignmentCount || 0}
          sortHierarchy={filter.sortHierarchy}
          onHierarchyChange={(sortHierarchy) => setFilter(prev => ({ ...prev, sortHierarchy }))}
        />
      )}
      {activeStep === 'orientation' && (
        <Step5Orientation
          orientation={filter.orientation}
          rollup={filter.rollup}
          onChange={(o) => setFilter(prev => ({ ...prev, orientation: o }))}
        />
      )}

      <ErrorBox message={error} />

      {/* Live summary */}
      <LiveSummary preview={preview} loading={previewLoading} rowType={filter.rowType} rollup={filter.rollup} filter={filter} rollupOn={rollupOn} />

      {/* Footer buttons */}
      <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <SecondaryButton onClick={() => setSaveOpen(true)} disabled={!filterHasAnyCondition(filter)}>
            Save matrix…
          </SecondaryButton>
        </div>
        <div className="flex items-center gap-2">
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          {curPos > 0 && <SecondaryButton onClick={goBack}>Back</SecondaryButton>}
          {!isLast && <PrimaryButton onClick={goNext}>Next</PrimaryButton>}
          {isLast && (
            <PrimaryButton onClick={handleApply} disabled={matrixIsBlocked(filter, rollupOn, preview.assignmentCount)}>
              Apply
            </PrimaryButton>
          )}
        </div>
      </div>

      {/* Save dialog */}
      {saveOpen && (
        <SaveFilterDialog
          name={saveName}
          onNameChange={setSaveName}
          onSave={handleSave}
          onClose={() => { setSaveOpen(false); setSaveError(null); }}
          saving={saving}
          error={saveError}
        />
      )}
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
            ? <>You rolled up by <span className="font-semibold">{friendlyLabel(String(rollup).replace(/^ext\./, ''))}</span>. Choose what to put in the matrix.</>
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

// ─── Step 5 — Sort ──────────────────────────────────────────────────
function Step5Sort({ sortAttributes, columns, disabled, onChange, foldOnLoad = 'auto', onFoldChange, assignmentCount = 0, sortHierarchy, onHierarchyChange }) {
  const { authFetch } = useAuth();
  // Any attribute can be sorted on, including ext.* extended attributes — the
  // matrix payload now carries extendedAttributes for the column sort.
  const options = attributeOptions(columns);
  const rows = sortAttributes.length ? sortAttributes : DEFAULT_SORT;
  const autoFold = assignmentCount >= FOLD_AUTO_THRESHOLD;
  const foldChecked = foldOnLoad === 'auto' ? autoFold : !!foldOnLoad;
  const isHierarchy = !!sortHierarchy; // an object (even with empty contextId) = hierarchy mode

  // Manager-Hierarchy roots to sort by.
  const [ctxRoots, setCtxRoots] = useState(null);
  useEffect(() => {
    if (!isHierarchy || ctxRoots !== null) return;
    let cancelled = false;
    authFetch('/api/contexts?contextType=ManagerHierarchy')
      .then(r => r.ok ? r.json() : { data: [] })
      .then(body => { if (!cancelled) setCtxRoots(Array.isArray(body.data) ? body.data : []); })
      .catch(() => { if (!cancelled) setCtxRoots([]); });
    return () => { cancelled = true; };
  }, [isHierarchy, ctxRoots, authFetch]);

  // Default to the first hierarchy once the list loads.
  useEffect(() => {
    if (isHierarchy && !sortHierarchy.contextId && Array.isArray(ctxRoots) && ctxRoots.length) {
      onHierarchyChange?.({ contextId: ctxRoots[0].id });
    }
  }, [isHierarchy, sortHierarchy, ctxRoots, onHierarchyChange]);

  const update = (i, patch) => onChange(rows.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const remove = (i) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => {
    const used = new Set(rows.map(r => r.attribute));
    const next = options.find(o => !used.has(o)) || options[0];
    if (next) onChange([...rows, { attribute: next, dir: 'asc' }]);
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">Sort columns</h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Order the columns by attributes, or by the Manager Hierarchy tree. The chosen levels appear as
          grouped header rows — click a header value to fold that group into a single count column.
        </p>
      </div>

      {/* Mode: attributes vs Manager Hierarchy */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onHierarchyChange?.(null)}
          className={`text-xs px-2 py-1 rounded border ${!isHierarchy ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}
        >By attributes</button>
        <button
          type="button"
          onClick={() => onHierarchyChange?.({ contextId: '' })}
          className={`text-xs px-2 py-1 rounded border ${isHierarchy ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}
        >By Manager Hierarchy</button>
      </div>

      {isHierarchy ? (
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Hierarchy</label>
          {ctxRoots === null ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">Loading hierarchies…</p>
          ) : ctxRoots.length === 0 ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">No Manager Hierarchy context found — run the manager-hierarchy plugin first.</p>
          ) : (
            <select
              value={sortHierarchy.contextId || ''}
              onChange={e => onHierarchyChange?.({ contextId: e.target.value })}
              className="w-full max-w-md border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
            >
              <option value="">Select a hierarchy…</option>
              {ctxRoots.map(c => <option key={c.id} value={c.id}>{c.displayName} ({c.totalMemberCount})</option>)}
            </select>
          )}
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            Columns are sorted by each subject's place in the org tree. Start folded at the top level, then
            unfold a group to reveal the next level — down to individual people.
          </p>
        </div>
      ) : disabled ? (
        <p className="text-xs text-gray-500 dark:text-gray-400 italic">
          Sorting doesn’t apply in roll-up mode — columns are the roll-up groups, ordered alphabetically.
        </p>
      ) : (
        <>
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 dark:text-gray-400 w-12">{i === 0 ? 'Sort by' : 'then by'}</span>
              <select
                value={r.attribute}
                onChange={e => update(i, { attribute: e.target.value })}
                className="flex-1 max-w-xs border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
              >
                {!options.includes(r.attribute) && <option value={r.attribute}>{r.attribute}</option>}
                {options.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              <button
                type="button"
                onClick={() => update(i, { dir: r.dir === 'asc' ? 'desc' : 'asc' })}
                className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                title="Toggle ascending / descending"
              >{r.dir === 'asc' ? 'A→Z' : 'Z→A'}</button>
              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-red-600 dark:hover:text-red-400 rounded shrink-0"
                  title="Remove"
                >×</button>
              )}
            </div>
          ))}
          {rows.length < 6 && options.length > rows.length && (
            <button type="button" onClick={add} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline">
              + Add attribute
            </button>
          )}
        </>
      )}

      {!disabled && !isHierarchy && (
        <label className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300 mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={foldChecked}
            onChange={e => onFoldChange?.(e.target.checked)}
          />
          <span>
            Open with the first group folded into count columns
            {foldOnLoad === 'auto' && (
              <span className="text-gray-500 dark:text-gray-400"> — auto ({autoFold ? 'on' : 'off'}: {assignmentCount.toLocaleString()} assignments, folds at {FOLD_AUTO_THRESHOLD.toLocaleString()}+ to keep loading fast)</span>
            )}
          </span>
        </label>
      )}
    </div>
  );
}

// ─── Saved-filter dropdown ─────────────────────────────────────────

function SavedFilterDropdown({ savedFilters, onLoad, onDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
      >
        Saved matrices ({savedFilters.length}) ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-10 w-72 max-h-80 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded shadow-lg">
          {savedFilters.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 italic">No saved matrices yet</div>
          ) : (
            savedFilters.map(f => (
              <div key={f.id} className="flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <button
                  onClick={() => { onLoad(f.id); setOpen(false); }}
                  className="flex-1 text-left text-xs text-gray-800 dark:text-gray-200 truncate"
                  title={f.description || f.name}
                >
                  {f.name}
                </button>
                <button
                  onClick={() => onDelete(f.id)}
                  className="text-[10px] text-gray-600 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                  title="Delete (org-wide)"
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      )}
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

  // Roll-up payloads are aggregated (small), so the size guard never applies.
  // Otherwise: over the block ceiling we only HARD-block when the matrix would
  // open unfolded — if it opens folded the un-virtualized columns collapse, so
  // it renders fine and we just note it instead of blocking.
  const oversized = !rollupOn && preview.assignmentCount > BLOCK_ASSIGNMENTS;
  const blocked   = matrixIsBlocked(filter, rollupOn, preview.assignmentCount);
  const foldsLarge = oversized && !blocked; // big but opens folded → allowed
  const large     = !rollupOn && !oversized && preview.assignmentCount > WARN_ASSIGNMENTS;

  const countClass = blocked
    ? 'font-semibold text-red-700 dark:text-red-400'
    : (large || foldsLarge)
      ? 'font-semibold text-amber-700 dark:text-amber-400'
      : 'font-semibold text-gray-800 dark:text-gray-200';

  return (
    <div className={`mt-3 text-xs bg-gray-50 dark:bg-gray-700/30 border rounded px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 ${
      blocked ? 'border-red-300 dark:border-red-700' : (large || foldsLarge) ? 'border-amber-300 dark:border-amber-700' : 'border-gray-100 dark:border-gray-700'
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
        {blocked    && <span className="ml-1 text-red-700 dark:text-red-400">— too large to load unfolded; add filters to reduce below {BLOCK_ASSIGNMENTS.toLocaleString()}, or let it open folded (Sort step)</span>}
        {foldsLarge && <span className="ml-1 text-amber-700 dark:text-amber-400">— large, but opens folded to keep loading fast</span>}
        {large      && <span className="ml-1 text-amber-700 dark:text-amber-400">— large, consider narrowing</span>}
        {rollup     && <span className="ml-1 text-blue-700 dark:text-blue-400">— roll-up mode: aggregated, size limit not applied</span>}
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

// ─── Step 5 — Orientation ───────────────────────────────────────────

function Step5Orientation({ orientation, rollup, onChange }) {
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 mb-2">Orientation</h4>
        <div className="grid grid-cols-2 gap-2">
          <RadioCard
            active={orientation === 'rows-as-resources'}
            onClick={() => onChange('rows-as-resources')}
            title="Resources as rows"
            description="Resources go on the rows, subjects as columns (the default). Good when you have many resources and few subjects — vertical scroll handles the long axis."
            visual={<OrientationVisual rowsLabel="Res" colsLabel="Subj" />}
          />
          <RadioCard
            active={orientation === 'rows-as-subjects'}
            onClick={() => onChange('rows-as-subjects')}
            title="Subjects as rows"
            description="Subjects go on the rows, resources as columns. Good when you have few resources and many subjects — vertical scroll handles the people, not the columns."
            visual={<OrientationVisual rowsLabel="Subj" colsLabel="Res" />}
          />
        </div>
      </div>
      {rollup && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400 italic">
          Roll-up uses its own resources-as-rows layout — orientation won’t change it.
        </p>
      )}
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

function OrientationVisual({ rowsLabel, colsLabel }) {
  // Tiny 2×3 grid that visually communicates which axis is rows / columns.
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="text-[8px] uppercase tracking-wider text-gray-600 dark:text-gray-400">{colsLabel}</div>
      <div className="flex items-center gap-1">
        <div className="text-[8px] uppercase tracking-wider text-gray-600 dark:text-gray-400" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>{rowsLabel}</div>
        <div className="grid grid-cols-3 gap-px bg-gray-300 dark:bg-gray-600 p-px rounded">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="w-2 h-2 bg-white dark:bg-gray-800" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Step 2 — Subjects ─────────────────────────────────────────────

function Step2Subject({ rowType, subject, contextMeta, columns, onContextResolved, onAdd, onRemove, onUpdate }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Narrow down the {rowType === 'identity' ? 'identities' : 'users'} that appear as rows. Includes are AND'd; excludes negate.
      </p>
      <ConditionList
        title="Include"
        conditions={subject.include}
        allowedTargets={rowType === 'identity' ? ['Identity'] : ['Principal']}
        contextMeta={contextMeta}
        columns={columns}
        onContextResolved={onContextResolved}
        onAdd={(c) => onAdd('include', c)}
        onRemove={(idx) => onRemove('include', idx)}
        onUpdate={(idx, patch) => onUpdate('include', idx, patch)}
        emptyHint="No include filters — every row matches."
      />
      <ConditionList
        title="Exclude"
        conditions={subject.exclude}
        allowedTargets={rowType === 'identity' ? ['Identity'] : ['Principal']}
        contextMeta={contextMeta}
        columns={columns}
        onContextResolved={onContextResolved}
        onAdd={(c) => onAdd('exclude', c)}
        onRemove={(idx) => onRemove('exclude', idx)}
        onUpdate={(idx, patch) => onUpdate('exclude', idx, patch)}
        emptyHint="No exclude filters."
      />
    </div>
  );
}

// ─── Step 3 — Resources ────────────────────────────────────────────

function Step3Resource({ resource, contextMeta, columns, onContextResolved, onAdd, onRemove, onUpdate }) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        Narrow down the resources that appear as columns. Includes are AND'd; excludes negate.
      </p>
      <ConditionList
        title="Include"
        conditions={resource.include}
        allowedTargets={['Resource', 'System']}
        contextMeta={contextMeta}
        columns={columns}
        onContextResolved={onContextResolved}
        onAdd={(c) => onAdd('include', c)}
        onRemove={(idx) => onRemove('include', idx)}
        onUpdate={(idx, patch) => onUpdate('include', idx, patch)}
        emptyHint="No include filters — every resource matches."
      />
      <ConditionList
        title="Exclude"
        conditions={resource.exclude}
        allowedTargets={['Resource', 'System']}
        contextMeta={contextMeta}
        columns={columns}
        onContextResolved={onContextResolved}
        onAdd={(c) => onAdd('exclude', c)}
        onRemove={(idx) => onRemove('exclude', idx)}
        onUpdate={(idx, patch) => onUpdate('exclude', idx, patch)}
        emptyHint="No exclude filters."
      />
    </div>
  );
}

// ─── Condition list ────────────────────────────────────────────────

function ConditionList({ title, conditions, contextMeta, columns, onContextResolved, onAdd, onRemove, onUpdate, emptyHint, allowedTargets }) {
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

// ─── Attribute picker dialog ───────────────────────────────────────

function AttributePicker({ columns, onPick, onClose }) {
  const [field, setField] = useState('');
  const [selectedValues, setSelectedValues] = useState([]);

  // Filter columns to ones with at least one distinct value AND a sensible
  // type (we hide UUID/ID-like columns since they're not useful filters).
  const filterable = useMemo(() => {
    if (!Array.isArray(columns)) return [];
    return columns
      .filter(c => !['id', 'principalId', 'resourceId', 'identityId', 'displayName'].includes(c.column))
      .filter(c => Array.isArray(c.values));
  }, [columns]);

  const selectedColumn = filterable.find(c => c.column === field);
  const valueOptions = selectedColumn?.values || [];

  const toggleValue = (v) => {
    setSelectedValues(prev => prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 dark:bg-black/70" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-4 w-[480px] max-w-full max-h-[80vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Add attribute filter</h3>

        <label className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1">Field</label>
        <select
          value={field}
          onChange={e => { setField(e.target.value); setSelectedValues([]); }}
          className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 mb-3"
        >
          <option value="">— select a field —</option>
          {filterable.map(c => (
            <option key={c.column} value={c.column}>
              {c.column} ({c.values.length})
            </option>
          ))}
        </select>

        {field && (
          <>
            <label className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1">
              Values <span className="text-gray-600 dark:text-gray-500">(any of these match — OR)</span>
            </label>
            <div className="border border-gray-200 dark:border-gray-700 rounded max-h-48 overflow-y-auto">
              {valueOptions.length === 0 ? (
                <p className="text-[11px] text-gray-600 dark:text-gray-500 italic px-2 py-1">No values available</p>
              ) : (
                valueOptions.map(v => (
                  <label key={v} className="flex items-center gap-1.5 px-2 py-1 hover:bg-gray-50 dark:hover:bg-gray-700/30 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedValues.includes(v)}
                      onChange={() => toggleValue(v)}
                      className="w-3 h-3"
                    />
                    <span className="text-gray-800 dark:text-gray-200 truncate">{v}</span>
                  </label>
                ))
              )}
            </div>
            <p className="text-[10px] text-gray-600 dark:text-gray-500 mt-1">{selectedValues.length} selected</p>
          </>
        )}

        <div className="flex justify-end gap-2 mt-3">
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton onClick={() => onPick(field, selectedValues)} disabled={!field || selectedValues.length === 0}>
            Add
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─── Save dialog ───────────────────────────────────────────────────

function SaveFilterDialog({ name, onNameChange, onSave, onClose, saving, error }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 dark:bg-black/70" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-4 w-[420px] max-w-full"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">Save matrix</h3>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-3">
          Saved matrices are visible to everyone in the org. Name must be unique.
        </p>
        <label className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder="e.g. HR users · M365 apps"
          autoFocus
          className="w-full px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200"
        />
        {error && <ErrorBox message={error} />}
        <div className="flex justify-end gap-2 mt-3">
          <SecondaryButton onClick={onClose} disabled={saving}>Cancel</SecondaryButton>
          <PrimaryButton onClick={onSave} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

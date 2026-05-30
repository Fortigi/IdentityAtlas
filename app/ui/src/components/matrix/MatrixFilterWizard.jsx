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
import { Modal, PrimaryButton, SecondaryButton, ErrorBox } from '../contexts/ModalPrimitives';
import ContextPicker from '../contexts/ContextPicker';
import { variantMeta, targetTypeMeta } from '../../utils/contextStyles';

// ─── Constants ──────────────────────────────────────────────────────

export const WARN_ASSIGNMENTS  =  5_000;
export const BLOCK_ASSIGNMENTS = 25_000;

export const EMPTY_FILTER = {
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
};

export function filterHasAnyCondition(f) {
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
  onApply,
  onClose,
}) {
  const { authFetch } = useAuth();
  const [step, setStep] = useState(1);
  const [filter, setFilter] = useState(() => structuredClone(initialFilter || EMPTY_FILTER));
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
    setStep(1);
    setError(null);
  }, [open, initialFilter]);

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
    if (preview.assignmentCount > BLOCK_ASSIGNMENTS) {
      setError(`Matrix too large (${preview.assignmentCount.toLocaleString()} assignments). Add filters to reduce below ${BLOCK_ASSIGNMENTS.toLocaleString()}.`);
      return;
    }
    onApply(filter);
  };

  // ─── Save filter ───────────────────────────────────────────────

  const handleSave = async () => {
    setSaveError(null);
    setSaving(true);
    try {
      const res = await authFetch('/api/matrix/saved-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: saveName.trim(), filter }),
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
    });
    setStep(3);
  };

  if (!open) return null;

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
        <StepIndicator step={step} onJump={setStep} />
      </div>

      {/* Step content */}
      {step === 1 && (
        <Step1Setup
          rowType={filter.rowType}
          orientation={filter.orientation}
          onRowTypeChange={setRowType}
          onOrientationChange={(o) => setFilter(prev => ({ ...prev, orientation: o }))}
        />
      )}
      {step === 2 && (
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
      {step === 3 && (
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

      <ErrorBox message={error} />

      {/* Live summary */}
      <LiveSummary preview={preview} loading={previewLoading} rowType={filter.rowType} />

      {/* Footer buttons */}
      <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <SecondaryButton onClick={() => setSaveOpen(true)} disabled={!filterHasAnyCondition(filter)}>
            Save matrix…
          </SecondaryButton>
        </div>
        <div className="flex items-center gap-2">
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          {step > 1 && <SecondaryButton onClick={() => setStep(s => s - 1)}>Back</SecondaryButton>}
          {step < 3 && <PrimaryButton onClick={() => setStep(s => s + 1)}>Next</PrimaryButton>}
          {step === 3 && (
            <PrimaryButton onClick={handleApply} disabled={preview.assignmentCount > BLOCK_ASSIGNMENTS}>
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

function StepIndicator({ step, onJump }) {
  const steps = [
    { n: 1, label: 'Setup' },
    { n: 2, label: 'Subjects' },
    { n: 3, label: 'Resources' },
  ];
  return (
    <div className="flex items-center gap-1 text-[11px]">
      {steps.map((s, idx) => (
        <span key={s.n} className="flex items-center gap-1">
          <button
            onClick={() => onJump(s.n)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${
              step === s.n
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
            }`}
          >
            <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-semibold ${
              step === s.n
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
            }`}>{s.n}</span>
            {s.label}
          </button>
          {idx < steps.length - 1 && <span className="text-gray-500 dark:text-gray-400">›</span>}
        </span>
      ))}
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

function LiveSummary({ preview, loading, rowType }) {
  const subjectLabel = rowType === 'identity' ? 'identities' : 'users';
  const subjectPct = preview.subjectTotal > 0
    ? Math.round((preview.subjectCount / preview.subjectTotal) * 100)
    : 0;
  const resourcePct = preview.resourceTotal > 0
    ? Math.round((preview.resourceCount / preview.resourceTotal) * 100)
    : 0;

  const tooLarge = preview.assignmentCount > BLOCK_ASSIGNMENTS;
  const large    = !tooLarge && preview.assignmentCount > WARN_ASSIGNMENTS;

  const countClass = tooLarge
    ? 'font-semibold text-red-700 dark:text-red-400'
    : large
      ? 'font-semibold text-amber-700 dark:text-amber-400'
      : 'font-semibold text-gray-800 dark:text-gray-200';

  return (
    <div className={`mt-3 text-xs bg-gray-50 dark:bg-gray-700/30 border rounded px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 ${
      tooLarge ? 'border-red-300 dark:border-red-700' : large ? 'border-amber-300 dark:border-amber-700' : 'border-gray-100 dark:border-gray-700'
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
        {tooLarge && <span className="ml-1 text-red-700 dark:text-red-400">— too large to load, add filters to reduce below {BLOCK_ASSIGNMENTS.toLocaleString()}</span>}
        {large    && <span className="ml-1 text-amber-700 dark:text-amber-400">— large, consider narrowing</span>}
      </div>
      {loading && (
        <div className="ml-auto text-[10px] text-gray-600 dark:text-gray-400">updating…</div>
      )}
    </div>
  );
}

// ─── Step 1 — Setup (subject type + orientation) ────────────────────

function Step1Setup({ rowType, orientation, onRowTypeChange, onOrientationChange }) {
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
      </div>

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-600 dark:text-gray-400 mb-2">Orientation</h4>
        <div className="grid grid-cols-2 gap-2">
          <RadioCard
            active={orientation === 'rows-as-resources'}
            onClick={() => onOrientationChange('rows-as-resources')}
            title="Resources as rows"
            description="Resources go on the rows, subjects as columns (the default). Good when you have many resources and few subjects — vertical scroll handles the long axis."
            visual={<OrientationVisual rowsLabel="Res" colsLabel="Subj" />}
          />
          <RadioCard
            active={orientation === 'rows-as-subjects'}
            onClick={() => onOrientationChange('rows-as-subjects')}
            title="Subjects as rows"
            description="Subjects go on the rows, resources as columns. Good when you have few resources and many subjects — vertical scroll handles the people, not the columns."
            visual={<OrientationVisual rowsLabel="Subj" colsLabel="Res" />}
          />
        </div>
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

function ConditionList({ title, conditions, contextMeta, columns, onContextResolved, onAdd, onRemove, onUpdate, emptyHint }) {
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

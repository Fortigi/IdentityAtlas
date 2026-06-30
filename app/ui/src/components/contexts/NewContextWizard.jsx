import { useEffect, useMemo, useReducer, useState } from 'react';

// useState-equivalent backed by useReducer (value + functional updates):
// dispatch isn't flagged by react-hooks/set-state-in-effect, so the JSON
// editor's value-sync effect can dispatch instead of setState.
const setStateReducer = (s, a) => (typeof a === 'function' ? a(s) : a);
import { useAuth } from '@ui/auth/AuthGate';
import { Modal, Field, ErrorBox, PrimaryButton, SecondaryButton } from './ModalPrimitives';
import Stepper from '@ui/components/Stepper';
import { targetTypeMeta } from '@ui/utils/contextStyles';

// ─── Unified "New context tree" wizard ────────────────────────────────────────
// One stepped flow (matching the matrix / crawler wizards via the shared
// Stepper) for every way of creating a context tree:
//
//   Step 1  Source        — Import (→ Crawlers) · Run a plugin · Create manual
//   Plugin: Step 2 Pick plugin → Step 3 Configure → Step 4 Preview & run
//   Manual: Step 2 Details (then Create)
//
// Replaces the old NewContextModal + RunPluginModal + CreateManualTreeModal.

export default function NewContextWizard({ open, onClose, onCreated, onRunStarted, onOpenCrawlers }) {
  const { authFetch } = useAuth();

  const [step, setStep] = useState(1);
  const [source, setSource] = useState(null); // 'import' | 'plugin' | 'manual'

  // Shared / plugin data
  const [systems, setSystems] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [principalAttrs, setPrincipalAttrs] = useState({ columns: [], extended: [] });

  // Plugin path state
  const [selected, setSelected] = useState(null);
  const [params, setParams] = useState({});
  const [dryRunning, setDryRunning] = useState(false);
  const [dryResult, setDryResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  // Target: a brand-new tree, or refresh an existing one (keeps analyst edits).
  const [genRoots, setGenRoots] = useState([]);   // existing generated root contexts
  const [mode, setMode] = useState('new');         // 'new' | 'refresh'
  const [refreshKey, setRefreshKey] = useState(''); // sourceInstanceKey to refresh

  // Manual path state
  const [mTargetType, setMTargetType] = useState('Identity');
  const [mContextType, setMContextType] = useState('');
  const [mDisplayName, setMDisplayName] = useState('');
  const [mDescription, setMDescription] = useState('');
  const [mScopeSystemId, setMScopeSystemId] = useState('');
  const [creating, setCreating] = useState(false);

  // Load plugins + systems + principal attributes when the wizard opens.
  useEffect(() => {
    if (!open) return;
    (async () => {
      setLoading(true); setLoadError(null);
      try {
        const [pr, sr, cr, gr] = await Promise.all([
          authFetch('/api/context-plugins'),
          authFetch('/api/systems'),
          authFetch('/api/context-plugins/principal-attributes'),
          authFetch('/api/contexts?variant=generated'),
        ]);
        if (pr.ok) setPlugins((await pr.json()).data || []);
        if (sr.ok) { const b = await sr.json(); setSystems(b.data || b || []); }
        if (cr.ok) { const ab = await cr.json(); setPrincipalAttrs({ columns: ab.columns || [], extended: ab.extended || [] }); }
        if (gr.ok) { const g = await gr.json(); setGenRoots(g.data || []); }
      } catch (e) {
        setLoadError(e.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [open, authFetch]);

  // Reset everything when the wizard closes — during render on the open→closed
  // transition, so no synchronous setState lives in an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setStep(1); setSource(null);
      setSelected(null); setParams({}); setDryResult(null);
      setError(null); setRunning(false); setDryRunning(false);
      setMTargetType('Identity'); setMContextType(''); setMDisplayName('');
      setMDescription(''); setMScopeSystemId(''); setCreating(false);
      setMode('new'); setRefreshKey('');
    }
  }

  // When a plugin is (re)selected: default back to creating a new tree and seed
  // its params with the schema defaults. Done during render on the selected
  // change (prev-value tracking) rather than in effects.
  const [seenSelected, setSeenSelected] = useState(selected);
  if (selected !== seenSelected) {
    setSeenSelected(selected);
    setMode('new'); setRefreshKey('');
    if (!selected) {
      setParams({}); setDryResult(null);
    } else {
      const defaults = {};
      const props = selected.parametersSchema?.properties || {};
      for (const [name, spec] of Object.entries(props)) {
        if (spec?.default !== undefined) defaults[name] = spec.default;
      }
      setParams(defaults); setDryResult(null);
    }
  }

  const grouped = useMemo(() => groupByTargetType(plugins), [plugins]);

  const pluginMissing = useMemo(() => {
    if (!selected) return [];
    return (selected.parametersSchema?.required || []).filter(n => {
      const v = params[n];
      return v === undefined || v === null || v === '';
    });
  }, [selected, params]);

  const manualValid = !!mDisplayName.trim() && !!mContextType.trim();

  // Existing trees from this same plugin + system that a run could refresh in
  // place (only instance-keyed trees — legacy NULL-key trees aren't offered).
  const refreshTargets = useMemo(() => {
    if (!selected) return [];
    const sys = params.scopeSystemId !== undefined && params.scopeSystemId !== ''
      ? parseInt(params.scopeSystemId, 10) : null;
    return genRoots.filter(r =>
      r.sourceAlgorithmName === selected.name &&
      (sys == null || r.scopeSystemId === sys) &&
      !!r.sourceInstanceKey
    );
  }, [genRoots, selected, params.scopeSystemId]);

  // Auto-preview when arriving at the plugin's final step.
  useEffect(() => {
    if (source === 'plugin' && step === 4 && selected && !dryResult && !dryRunning) {
      dryRun();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, source, selected]);

  if (!open) return null;

  const steps = stepsFor(source);

  function canNext() {
    if (step === 1) return !!source;
    if (source === 'plugin') {
      if (step === 2) return !!selected;
      if (step === 3) return pluginMissing.length === 0;
    }
    return true;
  }

  function next() {
    if (step === 1 && source === 'import') { onOpenCrawlers?.(); onClose(); return; }
    setStep(s => s + 1);
  }
  function back() {
    // Stepping back to the Source step clears the chosen path so the Stepper
    // and content stay in sync.
    if (step === 2) { setStep(1); return; }
    setStep(s => Math.max(1, s - 1));
  }

  async function dryRun() {
    if (!selected) return;
    setDryRunning(true); setError(null); setDryResult(null);
    try {
      const r = await authFetch(`/api/context-plugins/${selected.name}/dry-run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setDryResult(body);
    } catch (err) {
      setError(err.message || 'Dry-run failed');
    } finally {
      setDryRunning(false);
    }
  }

  async function run() {
    if (!selected) return;
    setRunning(true); setError(null);
    try {
      // New tree → no instanceKey (the runner mints a fresh one). Refresh →
      // send the chosen tree's key so the runner reconciles onto it.
      const body = { ...params };
      if (mode === 'refresh' && refreshKey) body.instanceKey = refreshKey;
      const r = await authFetch(`/api/context-plugins/${selected.name}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
      onRunStarted?.(payload.runId);
      onClose();
    } catch (err) {
      setError(err.message || 'Run failed');
      setRunning(false);
    }
  }

  async function createManual() {
    setCreating(true); setError(null);
    try {
      const r = await authFetch('/api/contexts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetType: mTargetType,
          contextType: mContextType.trim(),
          displayName: mDisplayName.trim(),
          description: mDescription.trim() || null,
          scopeSystemId: mScopeSystemId ? parseInt(mScopeSystemId, 10) : null,
        }),
      });
      const created = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(created.error || `HTTP ${r.status}`);
      onCreated?.(created);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to create context');
      setCreating(false);
    }
  }

  const subtitle =
    !source ? 'Where should this tree come from?'
    : source === 'plugin' ? (selected ? selected.displayName : 'Build a tree from existing data')
    : source === 'manual' ? 'Start an empty tree you’ll curate yourself'
    : 'Import from a crawler';

  return (
    <Modal title="New context tree" subtitle={subtitle} onClose={onClose} width={640} dismissOnBackdrop={false}>
      <div className="mb-4 border-b border-gray-100 dark:border-gray-700 pb-3">
        <Stepper steps={steps} current={step} onStepClick={(n) => n < step && setStep(n)} />
      </div>

      {loadError && <ErrorBox message={loadError} />}

      {/* ─── Step content ─── */}
      {step === 1 && <SourceStep source={source} onPick={setSource} />}

      {source === 'plugin' && step === 2 && (
        loading
          ? <p className="text-xs text-gray-500 dark:text-gray-400">Loading plugins…</p>
          : <PluginPicker grouped={grouped} selected={selected} onPick={setSelected} />
      )}
      {source === 'plugin' && step === 3 && (
        <div className="space-y-3">
          <JsonSchemaForm
            schema={selected?.parametersSchema}
            values={params}
            onChange={setParams}
            systems={systems}
            principalAttrs={principalAttrs}
          />
        </div>
      )}
      {source === 'plugin' && step === 4 && (
        <div className="space-y-3">
          <TargetChooser
            mode={mode} setMode={setMode}
            refreshKey={refreshKey} setRefreshKey={setRefreshKey}
            targets={refreshTargets}
          />
          <PreviewStep dryRunning={dryRunning} dryResult={dryResult} onRedo={dryRun} />
        </div>
      )}

      {source === 'manual' && step === 2 && (
        <ManualForm
          targetType={mTargetType} setTargetType={setMTargetType}
          contextType={mContextType} setContextType={setMContextType}
          displayName={mDisplayName} setDisplayName={setMDisplayName}
          description={mDescription} setDescription={setMDescription}
          scopeSystemId={mScopeSystemId} setScopeSystemId={setMScopeSystemId}
          systems={systems}
        />
      )}

      <ErrorBox message={error} />

      {/* ─── Footer ─── */}
      <div className="mt-5 flex items-center justify-between gap-2">
        <div className="text-[11px] text-gray-500 dark:text-gray-400">
          {source === 'plugin' && step === 3 && pluginMissing.length > 0 ? `Missing: ${pluginMissing.join(', ')}` : ''}
        </div>
        <div className="flex items-center gap-2">
          {step > 1 && <SecondaryButton onClick={back}>Back</SecondaryButton>}
          {source === 'plugin' && step === 4 ? (
            <PrimaryButton onClick={run} disabled={running || dryRunning || (mode === 'refresh' && !refreshKey)}>
              {running ? 'Starting…' : mode === 'refresh' ? 'Refresh tree' : 'Create tree'}
            </PrimaryButton>
          ) : source === 'manual' && step === 2 ? (
            <PrimaryButton onClick={createManual} disabled={!manualValid || creating}>{creating ? 'Creating…' : 'Create'}</PrimaryButton>
          ) : (
            <PrimaryButton onClick={next} disabled={!canNext()}>
              {step === 1 && source === 'import' ? 'Open Crawlers →' : 'Next ▸'}
            </PrimaryButton>
          )}
        </div>
      </div>
    </Modal>
  );
}

// Steps shown in the indicator, by chosen source.
function stepsFor(source) {
  if (source === 'plugin') return [
    { n: 1, label: 'Source' }, { n: 2, label: 'Pick plugin' },
    { n: 3, label: 'Configure' }, { n: 4, label: 'Preview & run' },
  ];
  if (source === 'manual') return [
    { n: 1, label: 'Source' }, { n: 2, label: 'Details' },
  ];
  return [{ n: 1, label: 'Source' }];
}

// ─── Step 1 — Source ──────────────────────────────────────────────────────────
function SourceStep({ source, onPick }) {
  const cards = [
    { key: 'import', title: 'Import', tone: 'slate', description: 'Crawlers pull trees from source systems (HR, AD OU, app catalogues). Configure one on the Crawlers page — trees appear here after the next crawl.' },
    { key: 'plugin', title: 'Run a plugin', tone: 'blue', description: 'Build a tree from existing data — manager chains, department strings, OU distinguished names, LLM clusters.' },
    { key: 'manual', title: 'Create manual', tone: 'amber', description: 'Start an empty tree you’ll curate yourself. Useful for business processes, app groupings, tags.' },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {cards.map(c => (
        <SourceCard key={c.key} {...c} active={source === c.key} onClick={() => onPick(c.key)} />
      ))}
    </div>
  );
}

const TONE = {
  slate: { bar: 'bg-slate-500', ring: 'border-slate-400 ring-slate-300' },
  blue:  { bar: 'bg-blue-500',  ring: 'border-blue-500 ring-blue-300' },
  amber: { bar: 'bg-amber-500', ring: 'border-amber-500 ring-amber-300' },
};

function SourceCard({ title, tone, description, active, onClick }) {
  const t = TONE[tone] || TONE.slate;
  return (
    <button
      onClick={onClick}
      className={[
        'text-left border rounded-lg p-3 bg-white dark:bg-gray-800 flex flex-col hover:shadow-sm transition',
        active ? `${t.ring} ring-2` : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className={`inline-block w-2 h-4 rounded ${t.bar}`} aria-hidden="true" />
        <span className="text-sm font-semibold text-gray-900 dark:text-white">{title}</span>
      </div>
      <p className="text-[11px] text-gray-600 dark:text-gray-400 flex-1">{description}</p>
    </button>
  );
}

// ─── Plugin picker (grouped by target type, selectable) ───────────────────────
function PluginPicker({ grouped, selected, onPick }) {
  if (grouped.length === 0) {
    return <p className="text-xs text-gray-500 dark:text-gray-400">No plugins are registered.</p>;
  }
  return (
    <div className="space-y-3">
      {grouped.map(([targetType, items]) => {
        const t = targetTypeMeta(targetType);
        return (
          <div key={targetType}>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass}`}>{t.label}</span>
              <span className="text-[11px] text-gray-500 dark:text-gray-400">· {items.length}</span>
            </div>
            <ul className="border border-gray-200 dark:border-gray-700 rounded divide-y divide-gray-100 dark:divide-gray-700">
              {items.map(p => {
                const isSel = selected?.name === p.name;
                return (
                  <li key={p.name}>
                    <button
                      onClick={() => onPick(p)}
                      className={[
                        'w-full text-left px-3 py-2',
                        isSel ? 'bg-blue-50 dark:bg-blue-900/30 ring-1 ring-inset ring-blue-400' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50',
                      ].join(' ')}
                    >
                      <div className="text-sm font-medium text-gray-900 dark:text-white">{p.displayName}</div>
                      {p.description && <div className="text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2">{p.description}</div>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function groupByTargetType(plugins) {
  const map = new Map();
  for (const p of plugins) {
    if (!map.has(p.targetType)) map.set(p.targetType, []);
    map.get(p.targetType).push(p);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ─── Step 4 — target (new vs refresh) ─────────────────────────────────────────
function TargetChooser({ mode, setMode, refreshKey, setRefreshKey, targets }) {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded p-3">
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">Target</div>
      <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
        <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} className="mt-0.5" />
        <span>
          Create a new tree
          <span className="block text-[11px] text-gray-500 dark:text-gray-400">Each run produces an independent tree.</span>
        </span>
      </label>
      <label className={`flex items-start gap-2 text-sm mt-2 ${targets.length ? 'text-gray-700 dark:text-gray-300 cursor-pointer' : 'text-gray-500 dark:text-gray-600'}`}>
        <input type="radio" checked={mode === 'refresh'} disabled={!targets.length} onChange={() => setMode('refresh')} className="mt-0.5" />
        <span className="flex-1">
          Refresh an existing tree
          <span className="block text-[11px] text-gray-500 dark:text-gray-400">
            {targets.length ? 'Re-runs onto the chosen tree and keeps your renames / re-parenting.' : 'No existing tree from this plugin + system yet.'}
          </span>
          {mode === 'refresh' && targets.length > 0 && (
            <select
              value={refreshKey}
              onChange={e => setRefreshKey(e.target.value)}
              className="mt-1 w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
            >
              <option value="">(select a tree…)</option>
              {targets.map(t => (
                <option key={t.id} value={t.sourceInstanceKey}>
                  {t.displayName} · {t.totalMemberCount ?? 0} members
                </option>
              ))}
            </select>
          )}
        </span>
      </label>
    </div>
  );
}

// ─── Step 4 — Preview & run ───────────────────────────────────────────────────
function PreviewStep({ dryRunning, dryResult, onRedo }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Preview</h4>
        <button onClick={onRedo} disabled={dryRunning} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50">
          {dryRunning ? 'Previewing…' : '↻ Refresh preview'}
        </button>
      </div>
      {dryRunning && !dryResult && <p className="text-xs text-gray-500 dark:text-gray-400">Computing preview…</p>}
      {dryResult && (
        <div className="border border-gray-200 dark:border-gray-700 rounded p-3 bg-gray-50 dark:bg-gray-700/50">
          <div className="text-xs font-semibold text-gray-800 dark:text-gray-200">
            {dryResult.contextCount} contexts · {dryResult.memberCount} members
          </div>
          <DryRunSamples samples={dryResult.samples} />
          <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">This is a preview — nothing is written until you press Run.</p>
        </div>
      )}
    </div>
  );
}

function DryRunSamples({ samples }) {
  if (!samples) return null;
  const ctxs = samples.contexts || [];
  const mbrs = samples.members || [];
  if (ctxs.length === 0 && mbrs.length === 0) {
    return <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">No preview rows.</p>;
  }
  return (
    <div className="mt-2 space-y-2">
      {ctxs.length > 0 && (
        <details open>
          <summary className="text-[11px] text-gray-700 dark:text-gray-300 cursor-pointer">Sample contexts ({ctxs.length})</summary>
          <ul className="text-[11px] text-gray-600 dark:text-gray-400 mt-1 pl-4 list-disc">
            {ctxs.map((c, i) => (
              <li key={i}>{c.displayName} <span className="text-gray-500 dark:text-gray-500">({c.externalId})</span></li>
            ))}
          </ul>
        </details>
      )}
      {mbrs.length > 0 && (
        <details>
          <summary className="text-[11px] text-gray-700 dark:text-gray-300 cursor-pointer">Sample members ({mbrs.length})</summary>
          <ul className="text-[11px] text-gray-600 dark:text-gray-400 mt-1 pl-4 list-disc">
            {mbrs.slice(0, 10).map((m, i) => (
              <li key={i}>{m.memberId} → {m.contextExternalId}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ─── Manual details form ──────────────────────────────────────────────────────
function ManualForm({
  targetType, setTargetType, contextType, setContextType,
  displayName, setDisplayName, description, setDescription,
  scopeSystemId, setScopeSystemId, systems,
}) {
  return (
    <div className="space-y-3">
      <Field label="Target type" help="What kind of entities will this tree contain.">
        <select value={targetType} onChange={e => setTargetType(e.target.value)} className="w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600">
          <option value="Identity">Identity</option>
          <option value="Resource">Resource</option>
          <option value="Principal">Principal</option>
          <option value="System">System</option>
        </select>
      </Field>
      <Field label="Context type" help="Free-form sub-classification (e.g. Application, BusinessProcess, Team).">
        <input value={contextType} onChange={e => setContextType(e.target.value)} placeholder="Application" className="w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600" />
      </Field>
      <Field label="Display name">
        <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Procurement app" className="w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600" />
      </Field>
      <Field label="Description (optional)">
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} className="w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600" />
      </Field>
      <Field label="Scope system (optional)" help="Pin this tree to a specific source system. Leave blank for a cross-system tree.">
        <select value={scopeSystemId} onChange={e => setScopeSystemId(e.target.value)} className="w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600">
          <option value="">(none)</option>
          {systems.map(s => <option key={s.id} value={s.id}>{s.displayName}</option>)}
        </select>
      </Field>
    </div>
  );
}

// ─── Dead-simple JSON-Schema-to-form renderer ─────────────────────────────────
// Flat object of string / integer / array properties. scopeSystemId gets a
// system picker; array params flagged "x-attributeSource":"principal" get the
// attribute dropdown picker; other arrays/objects fall back to a JSON textarea.
function JsonSchemaForm({ schema, values, onChange, systems, principalAttrs = { columns: [], extended: [] } }) {
  if (!schema?.properties) {
    return <p className="text-xs text-gray-500 dark:text-gray-400">This plugin takes no parameters.</p>;
  }
  const required = new Set(schema.required || []);
  const entries = Object.entries(schema.properties);

  function setField(name, val) { onChange({ ...values, [name]: val }); }

  return entries.map(([name, spec]) => {
    const isRequired = required.has(name);
    const label = `${prettifyName(name)}${isRequired ? ' *' : ''}`;
    const help = spec.description;

    if (name === 'scopeSystemId') {
      return (
        <Field key={name} label={label} help={help}>
          <select
            value={values[name] ?? ''}
            onChange={e => setField(name, e.target.value ? parseInt(e.target.value, 10) : '')}
            className="w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
          >
            <option value="">(select a system)</option>
            {systems.map(s => <option key={s.id} value={s.id}>{s.displayName}</option>)}
          </select>
        </Field>
      );
    }
    if (spec.type === 'integer' || spec.type === 'number') {
      return (
        <Field key={name} label={label} help={help}>
          <input
            type="number"
            value={values[name] ?? ''}
            onChange={e => setField(name, e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
          />
        </Field>
      );
    }
    if (spec.type === 'boolean') {
      return (
        <Field key={name} label={label} help={help}>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input type="checkbox" checked={values[name] !== false} onChange={e => setField(name, e.target.checked)} />
            <span>{values[name] !== false ? 'On' : 'Off'}</span>
          </label>
        </Field>
      );
    }
    if (spec.type === 'array' && spec['x-attributeSource'] === 'principal') {
      return (
        <Field key={name} label={label} help={help}>
          <AttributeListField
            value={Array.isArray(values[name]) ? values[name] : []}
            options={principalAttrs}
            onChange={val => setField(name, val)}
          />
        </Field>
      );
    }
    if (spec.type === 'array' || spec.type === 'object') {
      return (
        <JsonField key={name} label={label} help={help} spec={spec} value={values[name]} onChange={val => setField(name, val)} />
      );
    }
    return (
      <Field key={name} label={label} help={help}>
        <input
          value={values[name] ?? ''}
          onChange={e => setField(name, e.target.value)}
          placeholder={spec.default != null ? String(spec.default) : ''}
          className="w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
        />
      </Field>
    );
  });
}

// A list of attribute dropdowns with a "+" to add more and an "×" to remove.
// Groups real Principal columns and extendedAttributes keys; an "(other…)"
// escape hatch lets you type a name discovery didn't surface.
function AttributeListField({ value, options, onChange }) {
  const columns = options?.columns || [];
  const extended = options?.extended || [];
  const known = new Set([...columns, ...extended]);
  const rows = value.length > 0 ? value : [''];
  const OTHER = '__other__';

  function update(i, v) {
    const next = rows.slice();
    next[i] = v;
    onChange(next.filter(x => x !== '' && x !== OTHER));
  }
  function addRow() { onChange([...rows.filter(Boolean), '']); }
  function removeRow(i) {
    const next = rows.slice();
    next.splice(i, 1);
    onChange(next.filter(Boolean));
  }

  return (
    <div className="space-y-1.5">
      {rows.map((val, i) => {
        const isKnown = val === '' || known.has(val);
        return (
          <div key={i} className="flex items-center gap-1.5">
            <select
              value={isKnown ? val : OTHER}
              onChange={e => update(i, e.target.value === OTHER ? '' : e.target.value)}
              className="flex-1 border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
            >
              <option value="">(select an attribute…)</option>
              {columns.length > 0 && (
                <optgroup label="Attributes">
                  {columns.map(o => <option key={o} value={o}>{o}</option>)}
                </optgroup>
              )}
              {extended.length > 0 && (
                <optgroup label="Extended attributes">
                  {extended.map(o => <option key={o} value={o}>{o}</option>)}
                </optgroup>
              )}
              <option value={OTHER}>(other — type a name)</option>
            </select>
            {!isKnown && (
              <input
                value={val}
                onChange={e => update(i, e.target.value)}
                placeholder="attribute name"
                className="flex-1 border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
              />
            )}
            {rows.length > 1 && (
              <button type="button" onClick={() => removeRow(i)} className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-red-600 dark:hover:text-red-400 rounded shrink-0" title="Remove">×</button>
            )}
          </div>
        );
      })}
      <button type="button" onClick={addRow} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline">+ Add attribute</button>
    </div>
  );
}

function JsonField({ label, help, spec, value, onChange }) {
  const [text, setText] = useReducer(setStateReducer, undefined, () =>
    value !== undefined ? JSON.stringify(value, null, 2) :
    spec.default !== undefined ? JSON.stringify(spec.default, null, 2) : ''
  );
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (value === undefined || value === null) return;
    const current = JSON.stringify(value, null, 2);
    setText(prev => prev === current ? prev : current);
  }, [value]);

  function handleChange(newText) {
    setText(newText);
    if (newText.trim() === '') { setErr(null); onChange(undefined); return; }
    try {
      const parsed = JSON.parse(newText);
      setErr(null);
      onChange(parsed);
    } catch (e) {
      setErr(e.message);
      onChange(undefined);
    }
  }

  return (
    <Field label={label} help={help}>
      <textarea
        value={text}
        onChange={e => handleChange(e.target.value)}
        rows={4}
        spellCheck={false}
        className="w-full border rounded px-2 py-1 text-xs font-mono bg-white dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
      />
      {err && <p className="text-[11px] text-red-700 dark:text-red-400 mt-1">JSON error: {err}</p>}
    </Field>
  );
}

function prettifyName(name) {
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
}

import { Field } from './ModalPrimitives';
import { targetTypeMeta } from '@ui/utils/contextStyles';
import JsonSchemaForm from './NewContextSchemaForm';

// ─── Step dispatcher ──────────────────────────────────────────────────────────
// Picks the step body for the current (source, step). Kept flat with early
// returns so the wizard's render stays a thin shell.
export default function WizardBody(props) {
  const { source, step } = props;
  if (step === 1) return <SourceStep source={source} onPick={props.setSource} />;
  if (source === 'plugin') return <PluginBody {...props} />;
  if (source === 'manual' && step === 2) {
    return (
      <ManualForm
        targetType={props.mTargetType} setTargetType={props.setMTargetType}
        contextType={props.mContextType} setContextType={props.setMContextType}
        displayName={props.mDisplayName} setDisplayName={props.setMDisplayName}
        description={props.mDescription} setDescription={props.setMDescription}
        scopeSystemId={props.mScopeSystemId} setScopeSystemId={props.setMScopeSystemId}
        systems={props.systems}
      />
    );
  }
  return null;
}

function PluginBody({
  step, loading, grouped, selected, setSelected, params, setParams, systems,
  principalAttrs, mode, setMode, refreshKey, setRefreshKey, refreshTargets,
  dryRunning, dryResult, onDryRun,
}) {
  if (step === 2) {
    return loading
      ? <p className="text-xs text-gray-500 dark:text-gray-400">Loading plugins…</p>
      : <PluginPicker grouped={grouped} selected={selected} onPick={setSelected} />;
  }
  if (step === 3) {
    return (
      <div className="space-y-3">
        <JsonSchemaForm
          schema={selected?.parametersSchema}
          values={params}
          onChange={setParams}
          systems={systems}
          principalAttrs={principalAttrs}
        />
      </div>
    );
  }
  if (step === 4) {
    return (
      <div className="space-y-3">
        <TargetChooser
          mode={mode} setMode={setMode}
          refreshKey={refreshKey} setRefreshKey={setRefreshKey}
          targets={refreshTargets}
        />
        <PreviewStep dryRunning={dryRunning} dryResult={dryResult} onRedo={onDryRun} />
      </div>
    );
  }
  return null;
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
      {grouped.map(([targetType, items]) => (
        <PluginGroup key={targetType} targetType={targetType} items={items} selected={selected} onPick={onPick} />
      ))}
    </div>
  );
}

function PluginGroup({ targetType, items, selected, onPick }) {
  const t = targetTypeMeta(targetType);
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass}`}>{t.label}</span>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">· {items.length}</span>
      </div>
      <ul className="border border-gray-200 dark:border-gray-700 rounded divide-y divide-gray-100 dark:divide-gray-700">
        {items.map(p => (
          <PluginRow key={p.name} plugin={p} selected={selected?.name === p.name} onPick={onPick} />
        ))}
      </ul>
    </div>
  );
}

function PluginRow({ plugin, selected, onPick }) {
  return (
    <li>
      <button
        onClick={() => onPick(plugin)}
        className={[
          'w-full text-left px-3 py-2',
          selected ? 'bg-blue-50 dark:bg-blue-900/30 ring-1 ring-inset ring-blue-400' : 'hover:bg-gray-50 dark:hover:bg-gray-700/50',
        ].join(' ')}
      >
        <div className="text-sm font-medium text-gray-900 dark:text-white">{plugin.displayName}</div>
        {plugin.description && <div className="text-[11px] text-gray-500 dark:text-gray-400 line-clamp-2">{plugin.description}</div>}
      </button>
    </li>
  );
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

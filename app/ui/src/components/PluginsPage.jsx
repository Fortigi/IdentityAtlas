import { useState, useCallback, useMemo } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatRelativeTime as formatTimeAgo } from '@ui/utils/formatters';

const statusColors = {
  succeeded: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  queued: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

// Keys we manage outside the parameter form (they aren't plugin config).
const META_KEYS = new Set(['rootName', 'instanceKey', 'autoRefresh']);

// Summarise the non-meta plugin parameters for the list row.
function paramsSummary(params) {
  if (!params) return '';
  return Object.entries(params)
    .filter(([k, v]) => !META_KEYS.has(k) && v !== '' && v != null && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('  ·  ');
}

const th = 'text-left px-3 py-2 font-medium text-gray-700 dark:text-gray-300';

// Coloured run-status pill, shared by the list row and the detail stats line.
function StatusBadge({ status }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusColors[status] || 'bg-gray-100 dark:bg-gray-700'}`}>{status}</span>
  );
}

// One editable input for a single JSON-schema property.
function FieldInput({ prop, value, onChange }) {
  const cls = 'w-full text-sm px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100';
  if (Array.isArray(prop.enum)) {
    return (
      <select className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">— none —</option>
        {prop.enum.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (prop.type === 'boolean') {
    return (
      <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {value ? 'On' : 'Off'}
      </label>
    );
  }
  if (prop.type === 'integer' || prop.type === 'number') {
    return (
      <input type="number" className={cls} value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
    );
  }
  if (prop.type === 'array') {
    const text = Array.isArray(value) ? value.join(', ') : (value || '');
    return (
      <input type="text" className={cls} placeholder="comma, separated, values" value={text}
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
    );
  }
  return (
    <input type="text" className={cls} value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)} />
  );
}

// Editable form rendered from a plugin's parametersSchema, pre-filled with the
// tree's current parameters.
function ConfigForm({ schema, params, onChange }) {
  const props = schema?.properties || {};
  const keys = Object.keys(props);
  if (keys.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">This plugin has no configurable parameters.</p>;
  }
  return (
    <div className="space-y-3 max-w-xl">
      {keys.map((k) => {
        const p = props[k];
        return (
          <div key={k}>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">{p.title || k}</label>
            {p.description && <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-1">{p.description}</p>}
            <FieldInput prop={p} value={params[k]} onChange={(nv) => onChange({ ...params, [k]: nv })} />
          </div>
        );
      })}
    </div>
  );
}

// Save / re-run / remove controls for the detail view, with the two-step remove
// confirmation.
function DetailActions({ saving, removing, confirmRemove, setConfirmRemove, contextCount, onSaveRerun, onRunUnchanged, onRemove }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button onClick={onSaveRerun} disabled={saving || removing}
        className="px-3 py-1.5 text-sm rounded text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50">
        {saving ? 'Saving…' : 'Save & re-run'}
      </button>
      <button onClick={onRunUnchanged} disabled={saving || removing}
        className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50">
        Run now (unchanged)
      </button>
      <div className="flex-1" />
      {confirmRemove ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600 dark:text-gray-400">Remove this tree and its {contextCount} contexts?</span>
          <button onClick={onRemove} disabled={removing}
            className="px-3 py-1.5 text-sm rounded text-white bg-red-600 hover:bg-red-700 disabled:opacity-50">
            {removing ? 'Removing…' : 'Confirm remove'}
          </button>
          <button onClick={() => setConfirmRemove(false)} disabled={removing}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
            Cancel
          </button>
        </div>
      ) : (
        <button onClick={() => setConfirmRemove(true)} disabled={saving}
          className="px-3 py-1.5 text-sm rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20">
          Remove
        </button>
      )}
    </div>
  );
}

// Full-page detail for one configured tree: header, description, stats,
// configuration form and actions. `onRerun(params, label)` reconciles in place.
function PluginDetail({ selected, meta, draft, onDraftChange, saving, removing, confirmRemove, setConfirmRemove, notice, error, onClose, onRerun, onRemove }) {
  return (
    <div>
      <button onClick={onClose} className="text-sm text-blue-600 dark:text-blue-400 hover:underline mb-3">← Back to plugins</button>

      <div className="flex items-start justify-between gap-4 mb-1">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">{selected.rootName}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">{meta?.displayName || selected.algoDisplayName}</p>
        </div>
        {selected.targetType && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 whitespace-nowrap">{selected.targetType}</span>
        )}
      </div>

      {/* What it does */}
      {meta?.description && (
        <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">What it does</h4>
          <p className="text-sm text-gray-700 dark:text-gray-300">{meta.description}</p>
        </div>
      )}

      {/* Stats */}
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span className="text-gray-500 dark:text-gray-400">Contexts: <span className="text-gray-800 dark:text-gray-200 font-medium tabular-nums">{selected.contextCount}</span></span>
        <span className="text-gray-500 dark:text-gray-400">Last run: {selected.lastStatus
          ? <StatusBadge status={selected.lastStatus} />
          : '—'} {selected.lastRunAt && <span className="text-gray-500 dark:text-gray-400">{formatTimeAgo(selected.lastRunAt)}{selected.lastRunBy ? ` · ${selected.lastRunBy}` : ''}</span>}
        </span>
      </div>

      {/* Configuration */}
      <div className="mt-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-3">Configuration</h4>
        <ConfigForm schema={meta?.parametersSchema} params={draft} onChange={onDraftChange} />
      </div>

      {notice && <div className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">{notice}</div>}
      {error && <div className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</div>}

      <DetailActions
        saving={saving}
        removing={removing}
        confirmRemove={confirmRemove}
        setConfirmRemove={setConfirmRemove}
        contextCount={selected.contextCount}
        onSaveRerun={() => onRerun(draft, 'Configuration saved')}
        onRunUnchanged={() => onRerun(selected.params, 'Re-run started')}
        onRemove={onRemove}
      />
    </div>
  );
}

// One row of the configured-trees table.
function PluginRow({ tree, isBusy, onOpen, onRun }) {
  const summary = paramsSummary(tree.params);
  return (
    <tr onClick={() => onOpen(tree)}
        className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 align-top cursor-pointer">
      <td className="px-3 py-2 font-medium text-gray-900 dark:text-white whitespace-nowrap">{tree.algoDisplayName}</td>
      <td className="px-3 py-2">
        <span className="font-medium text-gray-800 dark:text-gray-200">{tree.rootName}</span>
        {summary && (
          <span className="block text-xs text-gray-500 dark:text-gray-400">{summary}</span>
        )}
      </td>
      <td className="px-3 py-2 text-right text-gray-700 dark:text-gray-300 tabular-nums">{tree.contextCount}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        {tree.lastStatus
          ? <StatusBadge status={tree.lastStatus} />
          : <span className="text-gray-500 dark:text-gray-400">—</span>}
        <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {tree.lastRunAt ? formatTimeAgo(tree.lastRunAt) : ''}{tree.lastRunBy ? ` · ${tree.lastRunBy}` : ''}
        </span>
      </td>
      <td className="px-3 py-2">
        <button
          onClick={(e) => { e.stopPropagation(); onRun(tree); }}
          disabled={isBusy}
          className="text-xs px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
        >
          {isBusy ? 'Running…' : 'Run now'}
        </button>
      </td>
    </tr>
  );
}

// The list view: header + configured-trees table (or loading / error / empty).
function PluginList({ trees, loading, error, busyKey, keyOf, onRefresh, onOpenDetail, onRunNow }) {
  return (
    <div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-white">Context plugins</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 max-w-2xl">
            Each generated context tree, its configuration, and its last run. Click a row to see what the plugin
            does and adjust or remove it. Trees refresh automatically after every crawl. Create new ones in Contexts → New.
          </p>
        </div>
        <button onClick={onRefresh} className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
          Refresh
        </button>
      </div>

      {loading && <div className="text-center text-gray-500 dark:text-gray-400 py-10">Loading…</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-4 text-red-700 dark:text-red-300 text-sm">{error.message}</div>}
      {!loading && !error && trees.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400 py-8">No context plugins configured yet. Create one in Contexts → New.</div>
      )}

      {!loading && !error && trees.length > 0 && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700 border-b border-gray-200 dark:border-gray-700">
                <th className={th}>Plugin</th>
                <th className={th}>Tree / configuration</th>
                <th className={`${th} text-right`}>Contexts</th>
                <th className={th}>Last run</th>
                <th className={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {trees.map((t) => (
                <PluginRow
                  key={keyOf(t)}
                  tree={t}
                  isBusy={busyKey === keyOf(t)}
                  onOpen={onOpenDetail}
                  onRun={onRunNow}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function PluginsPage() {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(null);

  // Detail view — keyed by tree so it survives reloads; draft holds edits.
  const [selKey, setSelKey] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [detailNotice, setDetailNotice] = useState(null);
  const [detailError, setDetailError] = useState(null);

  const key = (t) => `${t.algorithmId}:${t.instanceKey}`;

  // Trees drive the page's loading/error. The plugin catalog is best-effort —
  // its absence never blocks the trees list, so its own error is ignored.
  const { data: trees, loading, error, reload: reloadTrees } = useFetch('/api/context-plugins/trees', {
    authFetch, initialData: [], transform: (d) => d.data || [],
  });
  const { data: plugins, reload: reloadPlugins } = useFetch('/api/context-plugins', {
    authFetch, initialData: [], transform: (d) => d.data || [],
  });
  const load = useCallback(() => { reloadTrees(); reloadPlugins(); }, [reloadTrees, reloadPlugins]);

  const selected = useMemo(() => trees.find((t) => key(t) === selKey) || null, [trees, selKey]);
  const meta = useMemo(() => plugins.find((p) => p.name === selected?.algo) || null, [plugins, selected]);

  const openDetail = (t) => {
    setSelKey(key(t));
    setDraft({ ...t.params });
    setConfirmRemove(false);
    setDetailNotice(null);
    setDetailError(null);
  };
  const closeDetail = () => { setSelKey(null); setConfirmRemove(false); };

  // Quick run from the list (unchanged params).
  const runNow = async (t) => {
    setBusy(key(t));
    try {
      await authFetch(`/api/context-plugins/${encodeURIComponent(t.algo)}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...t.params, instanceKey: t.instanceKey }),
      });
      setTimeout(load, 1500);
    } finally {
      setBusy(null);
    }
  };

  // Re-run the selected tree with a given parameter set, reconciling in place
  // (same instanceKey → the runner updates the existing tree, keeping its id).
  const rerun = async (paramsToUse, label) => {
    setSaving(true); setDetailError(null); setDetailNotice(null);
    try {
      const res = await authFetch(`/api/context-plugins/${encodeURIComponent(selected.algo)}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...paramsToUse, instanceKey: selected.instanceKey }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setDetailNotice(`${label} — rebuilding the tree, refreshing shortly.`);
      setTimeout(load, 1600);
    } catch (e) {
      setDetailError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const removeTree = async () => {
    setRemoving(true); setDetailError(null);
    try {
      const res = await authFetch('/api/context-plugins/trees', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ algorithmId: selected.algorithmId, instanceKey: selected.instanceKey }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      closeDetail();
      load();
    } catch (e) {
      setDetailError(e.message);
      setRemoving(false);
    }
  };

  // ─── Detail view ───────────────────────────────────────────────────────────
  if (selected) {
    return (
      <PluginDetail
        selected={selected}
        meta={meta}
        draft={draft}
        onDraftChange={setDraft}
        saving={saving}
        removing={removing}
        confirmRemove={confirmRemove}
        setConfirmRemove={setConfirmRemove}
        notice={detailNotice}
        error={detailError}
        onClose={closeDetail}
        onRerun={rerun}
        onRemove={removeTree}
      />
    );
  }

  // ─── List view ───────────────────────────────────────────────────────────
  return (
    <PluginList
      trees={trees}
      loading={loading}
      error={error}
      busyKey={busy}
      keyOf={key}
      onRefresh={load}
      onOpenDetail={openDetail}
      onRunNow={runNow}
    />
  );
}

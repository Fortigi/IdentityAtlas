import { useMemo, useState } from 'react';
import { variantMeta, targetTypeMeta } from '../../utils/contextStyles';

function renderMemberCounts(n) {
  const d = typeof n.directMemberCount === 'number' ? n.directMemberCount : null;
  const t = typeof n.totalMemberCount  === 'number' ? n.totalMemberCount  : null;
  if (d == null && t == null) return null;
  if (t != null && d != null && t > d) {
    return <span className="text-[10px] text-gray-400 dark:text-gray-500">· {d}/{t}</span>;
  }
  return <span className="text-[10px] text-gray-400 dark:text-gray-500">· {d ?? t}</span>;
}

// Left pane of the Contexts tab. Lists every root context. Grouped by
// contextType so "all OrgUnit roots" cluster, "all ResourceCluster roots"
// cluster, etc. Within a group, each entry shows variant colour + target
// badge + scope-system chip (when applicable).
//
// Filter bar on top: target type, variant, system. Useful when there are
// dozens of trees.

export default function ContextTreeSelector({ roots, selectedRootId, onSelectRoot, onNewTree, loading }) {
  const [filterTarget, setFilterTarget] = useState('');
  const [filterVariant, setFilterVariant] = useState('');
  const [filterSystem, setFilterSystem] = useState('');

  const systems = useMemo(() => {
    const seen = new Map();
    for (const r of roots) {
      if (r.scopeSystemId && r.scopeSystemName && !seen.has(r.scopeSystemId)) {
        seen.set(r.scopeSystemId, r.scopeSystemName);
      }
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [roots]);

  const filtered = useMemo(() => {
    return roots.filter(r =>
      (!filterTarget  || r.targetType === filterTarget) &&
      (!filterVariant || r.variant    === filterVariant) &&
      (!filterSystem  || String(r.scopeSystemId) === filterSystem)
    );
  }, [roots, filterTarget, filterVariant, filterSystem]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      const key = `${r.contextType} (${r.targetType})`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700">
      <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-800 dark:text-gray-200">Trees</div>
        {onNewTree && (
          <button
            onClick={onNewTree}
            className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300"
          >+ New</button>
        )}
      </div>

      <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 space-y-2 text-xs">
        <div className="flex gap-2">
          <select value={filterTarget} onChange={e => setFilterTarget(e.target.value)} className="flex-1 border rounded px-1 py-0.5">
            <option value="">All targets</option>
            <option value="Identity">Identity</option>
            <option value="Resource">Resource</option>
            <option value="Principal">Principal</option>
            <option value="System">System</option>
          </select>
          <select value={filterVariant} onChange={e => setFilterVariant(e.target.value)} className="flex-1 border rounded px-1 py-0.5">
            <option value="">All variants</option>
            <option value="synced">Synced</option>
            <option value="generated">Generated</option>
            <option value="manual">Manual</option>
          </select>
        </div>
        {systems.length > 0 && (
          <select value={filterSystem} onChange={e => setFilterSystem(e.target.value)} className="w-full border rounded px-1 py-0.5">
            <option value="">All systems</option>
            {systems.map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}
          </select>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {loading && <div className="p-3 text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500">Loading…</div>}
        {!loading && filtered.length === 0 && (
          <div className="p-3 text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500">
            No trees match the current filters. Contexts arrive from a crawler (synced), from a plugin run (generated), or from the "+ New" button (manual).
          </div>
        )}
        {groups.map(([group, items]) => (
          <div key={group} className="mb-2">
            <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-700/50 border-y border-gray-100 dark:border-gray-700">
              {group} <span className="text-gray-400 dark:text-gray-500">· {items.length}</span>
            </div>
            <ul>
              {items.map(n => {
                const v = variantMeta(n.variant);
                const t = targetTypeMeta(n.targetType);
                const selected = n.id === selectedRootId;
                return (
                  <li key={n.id}>
                    <button
                      onClick={() => onSelectRoot(n.id)}
                      className={`w-full text-left px-3 py-2 text-xs border-l-4 ${v.borderClass} hover:bg-gray-50 dark:hover:bg-gray-700/50 dark:bg-gray-700/50 ${selected ? 'bg-blue-50' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-900 dark:text-white truncate">{n.displayName}</div>
                          <div className="flex items-center gap-1 mt-0.5">
                            <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border ${t.badgeClass}`}>{t.label}</span>
                            {n.scopeSystemName && (
                              <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-gray-700 text-slate-600 dark:text-gray-400 border border-slate-200 dark:border-gray-600" title="Scope system">
                                {n.scopeSystemName}
                              </span>
                            )}
                            {renderMemberCounts(n)}
                          </div>
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

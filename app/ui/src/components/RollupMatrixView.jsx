import { useMemo, useState, useCallback } from 'react';
import { useAuth } from '../auth/AuthGate';
import { friendlyLabel } from '../utils/formatters';
import MatrixCell from './matrix/MatrixCell';

// Roll-up matrix: the subject (column) axis is aggregated by an attribute (e.g.
// department). Rows are resources; each cell is the count of distinct subjects
// in that group with a DIRECT assignment to the resource. Click a group header
// to expand it into the underlying subjects (a normal per-subject query scoped
// to that attribute value), shown with their real D/I/O badges.

const MAX_ROWS = 300; // this view isn't virtualized — cap rendered resource rows

export default function RollupMatrixView({ rollup, filter, refreshing, onOpenDetail, onAdjustFilter }) {
  const { authFetch } = useAuth();
  const { attribute, resources, groupValues, counts } = rollup;
  const subjectWord = filter?.rowType === 'identity' ? 'identities' : 'users';

  // (resourceId|groupValue) -> directCount
  const countMap = useMemo(() => {
    const m = new Map();
    for (const c of counts) m.set(`${c.resourceId}|${c.groupValue}`, c.directCount);
    return m;
  }, [counts]);

  // Resources ordered by total direct assignments (busiest first), capped so the
  // un-virtualized table stays responsive on an unscoped roll-up.
  const orderedResources = useMemo(() => {
    const total = (rid) => groupValues.reduce((s, g) => s + (countMap.get(`${rid}|${g}`) || 0), 0);
    return [...resources]
      .map(r => ({ ...r, _total: total(r.resourceId) }))
      .sort((a, b) => b._total - a._total || (a.resourceDisplayName || '').localeCompare(b.resourceDisplayName || ''));
  }, [resources, groupValues, countMap]);
  const shownResources = orderedResources.slice(0, MAX_ROWS);
  const truncated = orderedResources.length - shownResources.length;

  // ── Drill-down: expand a group into its individual subjects ──
  const [expanded, setExpanded] = useState(() => new Set());
  const [cache, setCache] = useState(() => new Map());     // group -> { users, memberships }
  const [loadingGroup, setLoadingGroup] = useState(() => new Set());

  const toggleGroup = useCallback(async (group) => {
    if (group === '(none)') return; // synthetic group can't be expressed as an attribute filter
    if (expanded.has(group)) {
      setExpanded(prev => { const n = new Set(prev); n.delete(group); return n; });
      return;
    }
    if (!cache.has(group)) {
      setLoadingGroup(prev => new Set(prev).add(group));
      try {
        const drillFilter = {
          ...filter,
          rollup: null,
          subject: {
            include: [...(filter.subject?.include || []), { kind: 'attribute', field: attribute, values: [group] }],
            exclude: filter.subject?.exclude || [],
          },
        };
        const res = await authFetch('/api/matrix/data', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter: drillFilter }),
        });
        const body = await res.json();
        const userMap = new Map();
        const memberships = new Map();
        for (const d of (body.data || [])) {
          if (d.memberId && !userMap.has(d.memberId)) {
            userMap.set(d.memberId, { id: d.memberId, displayName: d.memberDisplayName || d.memberId, memberType: d.memberType });
          }
          const k = `${d.resourceId}|${d.memberId}`;
          if (!memberships.has(k)) memberships.set(k, new Set());
          memberships.get(k).add(d.membershipType);
        }
        const users = [...userMap.values()].sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
        setCache(prev => new Map(prev).set(group, { users, memberships }));
      } catch {
        setLoadingGroup(prev => { const n = new Set(prev); n.delete(group); return n; });
        return;
      }
      setLoadingGroup(prev => { const n = new Set(prev); n.delete(group); return n; });
    }
    setExpanded(prev => new Set(prev).add(group));
  }, [expanded, cache, filter, attribute, authFetch]);

  // Flatten groups (+ expanded subjects) into a single column list.
  const columns = useMemo(() => {
    const out = [];
    for (const g of groupValues) {
      out.push({ key: `g:${g}`, type: 'group', group: g });
      if (expanded.has(g)) {
        for (const u of (cache.get(g)?.users || [])) {
          out.push({ key: `u:${g}:${u.id}`, type: 'user', group: g, user: u });
        }
      }
    }
    return out;
  }, [groupValues, expanded, cache]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-3 px-1 py-2 text-xs">
        <div className="text-gray-600 dark:text-gray-300">
          Roll-up by <span className="font-semibold">{friendlyLabel(attribute)}</span> — each cell is the count of distinct {subjectWord} with a
          <span className="font-medium"> Direct</span> assignment. Click a column to expand it into the individual {subjectWord}.
          {refreshing && <span className="ml-2 text-gray-500 dark:text-gray-400">updating…</span>}
        </div>
        {onAdjustFilter && (
          <button onClick={onAdjustFilter} className="px-2 py-1 rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 whitespace-nowrap">
            Adjust matrix
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto border border-gray-200 dark:border-gray-700 rounded-lg">
        <table className="border-collapse text-xs">
          <thead className="sticky top-0 z-20">
            <tr>
              <th className="sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-gray-600 dark:text-gray-300 font-medium" style={{ minWidth: '280px' }}>
                Resource
              </th>
              {columns.map(col => {
                if (col.type === 'group') {
                  const isExp = expanded.has(col.group);
                  const loading = loadingGroup.has(col.group);
                  const canExpand = col.group !== '(none)';
                  return (
                    <th key={col.key} className="border-b border-r border-gray-300 dark:border-gray-600 px-1 py-1 align-bottom bg-gray-100 dark:bg-gray-800" style={{ minWidth: '40px', height: '130px' }}>
                      <div className="flex flex-col items-center justify-end h-full gap-1">
                        {canExpand && (
                          <button
                            onClick={() => toggleGroup(col.group)}
                            className="w-4 h-4 flex items-center justify-center text-[10px] leading-none text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0"
                            title={isExp ? `Collapse ${col.group}` : `Expand ${col.group} into ${subjectWord}`}
                          >{loading ? '⋯' : (isExp ? '▾' : '▸')}</button>
                        )}
                        <div className="text-[10px] font-semibold text-gray-700 dark:text-gray-300" style={{ writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)', maxHeight: '100px', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                          {col.group || '(none)'}
                        </div>
                      </div>
                    </th>
                  );
                }
                // user sub-column
                return (
                  <th key={col.key} className="border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center bg-blue-50 dark:bg-blue-900/20 align-bottom" style={{ width: '24px', minWidth: '24px', height: '130px' }} title={col.user.displayName}>
                    <div
                      className="text-[10px] font-medium text-blue-700 dark:text-blue-300 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 mx-auto"
                      style={{ writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)', maxHeight: '120px', overflow: 'hidden', whiteSpace: 'nowrap' }}
                      onClick={() => onOpenDetail?.(col.user.memberType === 'Identity' ? 'identity' : 'user', col.user.id, col.user.displayName)}
                    >
                      {col.user.displayName}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shownResources.map(r => (
              <tr key={r.resourceId} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="sticky left-0 z-10 bg-white dark:bg-gray-900 border-b border-r border-gray-200 dark:border-gray-700 px-2 py-1 text-gray-800 dark:text-gray-200" style={{ minWidth: '280px' }}>
                  <button className="text-left hover:text-blue-600 dark:hover:text-blue-400 truncate max-w-[260px] block" onClick={() => onOpenDetail?.('resource', r.resourceId, r.resourceDisplayName)} title={r.resourceDisplayName}>
                    {r.resourceDisplayName || r.resourceId}
                  </button>
                </td>
                {columns.map(col => {
                  if (col.type === 'group') {
                    const n = countMap.get(`${r.resourceId}|${col.group}`) || 0;
                    return (
                      <td key={col.key} className="border-b border-r border-gray-100 dark:border-gray-700 text-center px-1 py-0.5" style={{ minWidth: '40px' }}>
                        {n > 0 ? <span className="inline-block text-[11px] font-semibold text-gray-800 dark:text-gray-200">{n}</span> : <span className="text-gray-300 dark:text-gray-700">·</span>}
                      </td>
                    );
                  }
                  const types = cache.get(col.group)?.memberships.get(`${r.resourceId}|${col.user.id}`);
                  return <MatrixCell key={col.key} cellKey={col.key} membershipTypes={types} managed={false} />;
                })}
              </tr>
            ))}
            {orderedResources.length === 0 && (
              <tr><td colSpan={columns.length + 1} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">No assignments match the current filter.</td></tr>
            )}
            {truncated > 0 && (
              <tr><td colSpan={columns.length + 1} className="px-3 py-2 text-center text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20">
                Showing the top {MAX_ROWS} of {orderedResources.length} resources by Direct assignments — add resource filters to narrow.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

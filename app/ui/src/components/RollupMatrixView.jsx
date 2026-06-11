import { useMemo, useState, useCallback, useRef, useLayoutEffect } from 'react';
import { useAuth } from '../auth/AuthGate';
import { friendlyLabel } from '../utils/formatters';
import { getAccessPackageColor } from '../utils/colors';
import { useIsDark } from '../contexts/ThemeContext';
import MatrixCell from './matrix/MatrixCell';
import MatrixScopePanel from './matrix/MatrixScopePanel';
import MatrixLegend from './matrix/MatrixLegend';
import MatrixFilterSummary from './matrix/MatrixFilterSummary';
import MatrixToolbar from './matrix/MatrixToolbar';

// Roll-up matrix: the subject (column) axis is aggregated by an attribute (e.g.
// department). Rows are resources; each cell is the count of distinct subjects
// in that group with a DIRECT assignment to the resource. The All / Governed /
// Non-governed toggle picks total / governed / ungoverned. Click a group header
// to expand it into the underlying subjects (a normal per-subject query scoped
// to that attribute value), shown with their real D/I/O badges.

const MAX_ROWS = 300; // this view isn't virtualized — cap rendered resource rows

export default function RollupMatrixView({
  rollup, filter, counts, managedFilter, setManagedFilter, shareUrl,
  refreshing, onOpenDetail, onAdjustFilter, onFilterChange,
}) {
  const { authFetch } = useAuth();
  const isDark = useIsDark();
  const {
    attribute, rollupContent = 'resources-and-roles', resources, groupValues,
    counts: directCounts, businessRoles = [], roleCounts = [], roleRows = [], cells = [],
    groupTotals = [], rollupKind = 'attribute', nodes = [], childrenByNode = {},
  } = rollup;
  const subjectWord = filter?.rowType === 'identity' ? 'identities' : 'users';

  // ── Context-tree roll-up (e.g. Manager Hierarchy) ──
  // Columns are context nodes of the current frontier; drilling replaces a node
  // with its children. nodeMap carries display/total/childCount/parent.
  const contextMode = rollupKind === 'context';
  const nodeMap = useMemo(() => {
    const m = new Map();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);
  // The verbose plugin name is a full path "A · B · C (Manager, Name)" — show the
  // manager's name when present, else the last path segment.
  const ctxLabel = useCallback((id) => {
    const dn = nodeMap.get(id)?.displayName || id;
    const paren = dn.match(/\(([^)]+)\)\s*$/);
    if (paren) return paren[1];
    const segs = dn.split('·').map(s => s.trim()).filter(Boolean);
    return segs[segs.length - 1] || dn;
  }, [nodeMap]);

  // Cell value: absolute count (default) or % of the in-scope subjects in that
  // group who hold it. groupTotals provides the per-group denominator.
  const percentMode = (filter?.rollupMetric || 'count') === 'percent';
  const groupTotalMap = useMemo(() => {
    const m = new Map();
    for (const g of groupTotals) m.set(g.groupValue, g.total);
    return m;
  }, [groupTotals]);
  // Render text for a (row, group) cell: '·' when zero, else count or N%.
  const fmtCell = useCallback((n, group) => {
    if (!n) return null;
    if (!percentMode) return n;
    const total = groupTotalMap.get(group) || 0;
    return total > 0 ? `${Math.round((n / total) * 100)}%` : n;
  }, [percentMode, groupTotalMap]);

  // 'roles-only' puts business roles on the rows; otherwise resources are rows.
  const rolesOnly = rollupContent === 'roles-only';
  const rowNoun = rolesOnly ? 'Business role' : 'Resource';
  const rowDetailKind = rolesOnly ? 'access-package' : 'resource';

  // The Gaps view has no meaning for an aggregated count — fall back to All.
  const mode = managedFilter === 'gaps' ? 'all' : managedFilter;
  // Business-role columns only in the resources-and-roles view, governed-inclusive.
  const visibleRoles = (!rolesOnly && rollupContent !== 'resources-only' && mode !== 'unmanaged') ? businessRoles : [];

  // (resourceId|groupValue) -> { direct, governed } for the resources views.
  const countMap = useMemo(() => {
    const m = new Map();
    for (const c of directCounts) m.set(`${c.resourceId}|${c.groupValue}`, { direct: c.directCount || 0, governed: c.governedCount || 0 });
    return m;
  }, [directCounts]);

  // (roleId|groupValue) -> count for the roles-only view.
  const cellMap = useMemo(() => {
    const m = new Map();
    for (const c of cells) m.set(`${c.roleId}|${c.groupValue}`, c.count);
    return m;
  }, [cells]);

  // Pick the number to show for the current All / Governed / Non-governed mode.
  const pick = useCallback((cell) => {
    if (!cell) return 0;
    if (mode === 'managed') return cell.governed;
    if (mode === 'unmanaged') return Math.max(0, cell.direct - cell.governed);
    return cell.direct;
  }, [mode]);

  // The count in a (row, group) cell — roles-only reads the role cell map; the
  // resources views read the direct/governed map filtered by the toggle.
  const groupCount = useCallback(
    (rowId, group) => rolesOnly ? (cellMap.get(`${rowId}|${group}`) || 0) : pick(countMap.get(`${rowId}|${group}`)),
    [rolesOnly, cellMap, countMap, pick],
  );

  // (resourceId|roleId) -> governed count via that business role
  const roleCountMap = useMemo(() => {
    const m = new Map();
    for (const rc of roleCounts) m.set(`${rc.resourceId}|${rc.roleId}`, rc.count);
    return m;
  }, [roleCounts]);

  // Generic rows: resources or business roles.
  const rowItems = useMemo(() => rolesOnly
    ? roleRows.map(r => ({ id: r.id, displayName: r.displayName, description: r.description || '' }))
    : resources.map(r => ({ id: r.resourceId, displayName: r.resourceDisplayName, description: r.resourceDescription || '' })),
    [rolesOnly, roleRows, resources]);

  // Rows ordered by total (busiest first), capped so the un-virtualized table
  // stays responsive.
  const orderedResources = useMemo(() => {
    return rowItems
      .map(r => ({ ...r, _total: groupValues.reduce((s, g) => s + groupCount(r.id, g), 0) }))
      .sort((a, b) => b._total - a._total || (a.displayName || '').localeCompare(b.displayName || ''));
  }, [rowItems, groupValues, groupCount]);
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
        // Scope the drill to this one group. Attribute/roles roll-ups match on
        // the attribute value; context roll-ups match on membership of the node
        // (a leaf context) including its subtree.
        const scopeCond = contextMode
          ? { kind: 'context', contextId: group, includeChildren: true }
          : { kind: 'attribute', field: attribute, values: [group] };
        const scopedSubject = {
          include: [...(filter.subject?.include || []), scopeCond],
          exclude: filter.subject?.exclude || [],
        };
        // Roles-only puts business roles on the rows, so the drill returns which
        // role each subject holds; the resources/context views return resource
        // grants (flat per-subject data — clear the roll-up).
        const drillFilter = rolesOnly
          ? { ...filter, drill: true, subject: scopedSubject }
          : { ...filter, rollup: null, rollupKind: 'attribute', rollupContextId: null, rollupFrontier: [], subject: scopedSubject };
        const res = await authFetch('/api/matrix/data', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter: drillFilter }),
        });
        const body = await res.json();
        const userMap = new Map();
        const memberships = new Map();
        if (rolesOnly) {
          // memberships keyed (roleId|memberId) — mirrors the resources path's
          // (resourceId|memberId) so the body render is identical.
          for (const m of (body.drill?.members || [])) {
            if (m.memberId && !userMap.has(m.memberId)) {
              userMap.set(m.memberId, { id: m.memberId, displayName: m.memberDisplayName || m.memberId, memberType: m.memberType });
            }
            if (!m.roleId) continue;
            const k = `${m.roleId}|${m.memberId}`;
            if (!memberships.has(k)) memberships.set(k, new Set());
            memberships.get(k).add('Direct');
          }
        } else {
          for (const d of (body.data || [])) {
            if (d.memberId && !userMap.has(d.memberId)) {
              userMap.set(d.memberId, { id: d.memberId, displayName: d.memberDisplayName || d.memberId, memberType: d.memberType });
            }
            const k = `${d.resourceId}|${d.memberId}`;
            if (!memberships.has(k)) memberships.set(k, new Set());
            memberships.get(k).add(d.membershipType);
          }
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
  }, [expanded, cache, filter, attribute, authFetch, rolesOnly, contextMode]);

  // ── Context drill: replace a node column with its children (one level down).
  // Leaf nodes (no children) fall back to expanding into individual subjects.
  const drillContextNode = useCallback((nodeId) => {
    const kids = childrenByNode[nodeId];
    if (!kids || kids.length === 0) { toggleGroup(nodeId); return; }
    const next = [];
    for (const id of groupValues) {
      if (id === nodeId) next.push(...kids.map(k => k.id));
      else next.push(id);
    }
    onFilterChange?.({ ...filter, rollupFrontier: next });
  }, [childrenByNode, groupValues, filter, onFilterChange, toggleGroup]);

  // Collapse a node back up: replace every visible sibling that shares its
  // parent with the parent node itself.
  const collapseContextNode = useCallback((nodeId) => {
    const parent = nodeMap.get(nodeId)?.parent;
    if (!parent) return;
    const next = groupValues.filter(id => nodeMap.get(id)?.parent !== parent);
    if (!next.includes(parent)) next.unshift(parent);
    onFilterChange?.({ ...filter, rollupFrontier: next });
  }, [nodeMap, groupValues, filter, onFilterChange]);

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

  // Share + export (parity with the per-subject toolbar).
  const onShare = useCallback(async () => {
    try { await navigator.clipboard.writeText(shareUrl || window.location.href); return true; } catch { return false; }
  }, [shareUrl]);

  const onExportExcel = useCallback(() => {
    const header = [rowNoun, ...groupValues, ...visibleRoles.map(r => r.displayName), '#', 'Description'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [header.map(esc).join(',')];
    for (const r of orderedResources) {
      const row = [r.displayName || r.id];
      for (const g of groupValues) row.push(groupCount(r.id, g) || '');
      for (const role of visibleRoles) row.push(roleCountMap.get(`${r.id}|${role.id}`) || '');
      row.push(r._total, r.description || '');
      lines.push(row.map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `matrix-rollup-${attribute}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [rowNoun, groupValues, visibleRoles, orderedResources, groupCount, roleCountMap, attribute]);

  // Cap the grid height to the remaining viewport so only the grid scrolls
  // (matches MatrixView). overflow-auto then gives both scrollbars, including
  // the horizontal one when the columns are wider than the screen.
  const scrollRef = useRef(null);
  const [gridMaxH, setGridMaxH] = useState(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = scrollRef.current;
      if (!el) return;
      const footer = document.querySelector('footer');
      const below = (footer ? footer.getBoundingClientRect().height : 0) + 28;
      const vh = document.documentElement.clientHeight;
      const gridTop = el.getBoundingClientRect().top + window.scrollY;
      setGridMaxH(Math.max(240, vh - gridTop - below));
    };
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    let ro;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(document.body); }
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', measure); if (ro) ro.disconnect(); };
  }, [columns.length, visibleRoles.length]);

  const trailingCols = visibleRoles.length + 3; // resource + # + Description (+ roles handled separately)

  return (
    <div className="flex flex-col gap-3">
      {/* Filter summary chips + Adjust matrix — same toolbar as the per-subject view. */}
      {filter && <MatrixFilterSummary filter={filter} preview={counts} onAdjust={onAdjustFilter} />}

      {/* Scope Statistics — governed % etc. */}
      {filter && <MatrixScopePanel filter={filter} />}

      {/* All / Governed / Non-governed + Export + Share — same toolbar as the per-subject view. */}
      <MatrixToolbar
        managedFilter={managedFilter}
        setManagedFilter={setManagedFilter}
        onExportExcel={onExportExcel}
        onShare={onShare}
        hideGaps
      />

      <div className="px-1 text-[11px] text-gray-600 dark:text-gray-300">
        {(() => {
          const valueWord = percentMode
            ? <>the <span className="font-medium">percentage</span> of the {subjectWord} in that group</>
            : <>the count of distinct {subjectWord}</>;
          if (contextMode) return (
            <>Aggregated by the <span className="font-semibold">Manager Hierarchy</span> — columns are org units, and each cell is {valueWord} anywhere under that org with a <span className="font-medium">Direct</span> assignment. Click <span className="font-medium">▾</span> to drill into sub-teams, <span className="font-medium">▸</span> to expand a team into people, <span className="font-medium">▲</span> to go back up.</>
          );
          return rolesOnly ? (
            <>Business roles on the rows, grouped by <span className="font-semibold">{friendlyLabel(String(attribute).replace(/^ext\./, ''))}</span> — each cell is {valueWord} who hold the role.</>
          ) : (
            <>Roll-up by <span className="font-semibold">{friendlyLabel(String(attribute).replace(/^ext\./, ''))}</span> — each cell is {valueWord}
            {mode === 'managed' ? ' governed' : mode === 'unmanaged' ? ' non-governed' : ''} with a
            <span className="font-medium"> Direct</span> assignment. Click a column to expand it into the individual {subjectWord}.</>
          );
        })()}
        {contextMode && (
          <button
            onClick={() => onFilterChange?.({ ...filter, rollupFrontier: [] })}
            className="ml-2 text-blue-600 dark:text-blue-400 hover:underline"
          >Reset to top level</button>
        )}
        {refreshing && <span className="ml-2 text-gray-500 dark:text-gray-400">updating…</span>}
      </div>

      {/* How to read this matrix — same legend as the per-subject view. */}
      <MatrixLegend />

      <div ref={scrollRef} className="relative border border-gray-200 dark:border-gray-700 rounded-lg overflow-auto" style={{ maxHeight: gridMaxH ? `${gridMaxH}px` : undefined }}>
        <table className="border-collapse text-xs">
          <thead className="sticky top-0 z-20">
            <tr>
              <th className="sticky left-0 z-30 bg-gray-100 dark:bg-gray-800 border-b border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-left text-gray-600 dark:text-gray-300 font-medium" style={{ minWidth: '280px' }}>
                {rowNoun}
              </th>
              {columns.map(col => {
                if (col.type === 'group') {
                  const isExp = expanded.has(col.group);
                  const loading = loadingGroup.has(col.group);
                  const canExpand = col.group !== '(none)';
                  const grpTotal = groupTotalMap.get(col.group);
                  return (
                    <th key={col.key} className="border-b border-r border-gray-300 dark:border-gray-600 px-1 py-1 align-bottom bg-gray-100 dark:bg-gray-800" style={{ minWidth: '40px', height: '130px' }} title={grpTotal != null ? `${col.group || '(none)'} — ${grpTotal} ${subjectWord}` : undefined}>
                      <div className="flex flex-col items-center justify-end h-full gap-1">
                        {contextMode ? (() => {
                          const node = nodeMap.get(col.group);
                          const canDrill = (node?.childCount || 0) > 0;
                          const canCollapse = !!node?.parent;
                          const btn = 'w-4 h-4 flex items-center justify-center text-[10px] leading-none shrink-0';
                          return (
                            <>
                              {node?.total != null && (
                                <span className="text-[9px] leading-none text-gray-500 dark:text-gray-400 shrink-0" title={`${node.total} ${subjectWord} in this org (whole subtree)`}>{node.total}</span>
                              )}
                              {canCollapse && (
                                <button onClick={() => collapseContextNode(col.group)} className={`${btn} text-gray-500 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400`} title="Collapse — back up one level">▲</button>
                              )}
                              <button
                                onClick={() => drillContextNode(col.group)}
                                className={`${btn} text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400`}
                                title={canDrill ? `Drill into ${ctxLabel(col.group)} — show its sub-teams` : (isExp ? 'Collapse' : `Expand into the individual ${subjectWord}`)}
                              >{loading ? '⋯' : (canDrill ? '▾' : (isExp ? '▾' : '▸'))}</button>
                            </>
                          );
                        })() : (
                          <>
                            {percentMode && grpTotal != null && (
                              <span className="text-[9px] leading-none text-gray-500 dark:text-gray-400 shrink-0" title={`${grpTotal} ${subjectWord} in this group`}>{grpTotal}</span>
                            )}
                            {canExpand && (
                              <button
                                onClick={() => toggleGroup(col.group)}
                                className="w-4 h-4 flex items-center justify-center text-[10px] leading-none text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 shrink-0"
                                title={isExp ? `Collapse ${col.group}` : `Expand ${col.group} into ${subjectWord}`}
                              >{loading ? '⋯' : (isExp ? '▾' : '▸')}</button>
                            )}
                          </>
                        )}
                        <div className="text-[10px] font-semibold text-gray-700 dark:text-gray-300" style={{ writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)', maxHeight: '100px', overflow: 'hidden', whiteSpace: 'nowrap' }} title={contextMode ? nodeMap.get(col.group)?.displayName : undefined}>
                          {contextMode ? ctxLabel(col.group) : (col.group || '(none)')}
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

              {/* Business-role (SOLL) columns */}
              {visibleRoles.map((role, idx) => (
                <th
                  key={`role:${role.id}`}
                  className={`border-b border-r border-gray-200 dark:border-gray-600 px-0 py-0 align-bottom ${idx === 0 ? 'border-l-2 border-l-indigo-300 dark:border-l-indigo-500' : ''}`}
                  style={{ backgroundColor: getAccessPackageColor(idx, isDark), width: '40px', minWidth: '40px', height: '130px' }}
                  title={`Business role: ${role.displayName}`}
                >
                  <div
                    className="text-[10px] font-medium text-gray-700 dark:text-gray-200 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 mx-auto"
                    style={{ writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)', maxHeight: '120px', overflow: 'hidden', whiteSpace: 'nowrap' }}
                    onClick={() => onOpenDetail?.('access-package', role.id, role.displayName)}
                  >
                    {role.displayName}
                  </div>
                </th>
              ))}

              {/* Trailing # (total) + Description columns — like the per-subject matrix. */}
              <th className="border-b border-l-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-1 py-1 align-bottom text-[10px] text-gray-600 dark:text-gray-400 font-medium" style={{ minWidth: '40px' }} title="Total count for this resource">
                <div style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}># ▼</div>
              </th>
              <th className="border-b border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-2 py-1 align-bottom text-xs text-gray-600 dark:text-gray-400 font-medium text-left" style={{ minWidth: '420px' }}>
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            {shownResources.map(r => (
              <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                <td className="sticky left-0 z-10 bg-white dark:bg-gray-900 border-b border-r border-gray-200 dark:border-gray-700 px-2 py-1 text-gray-800 dark:text-gray-200" style={{ minWidth: '280px' }}>
                  <button className="text-left hover:text-blue-600 dark:hover:text-blue-400 truncate max-w-[260px] block" onClick={() => onOpenDetail?.(rowDetailKind, r.id, r.displayName)} title={r.displayName}>
                    {r.displayName || r.id}
                  </button>
                </td>
                {columns.map(col => {
                  if (col.type === 'group') {
                    const n = groupCount(r.id, col.group);
                    const disp = fmtCell(n, col.group);
                    return (
                      <td key={col.key} className="border-b border-r border-gray-100 dark:border-gray-700 text-center px-1 py-0.5" style={{ minWidth: '40px' }} title={percentMode && n > 0 ? `${n} of ${groupTotalMap.get(col.group) || 0} ${subjectWord}` : undefined}>
                        {disp ? <span className="inline-block text-[11px] font-semibold text-gray-800 dark:text-gray-200">{disp}</span> : <span className="text-gray-500 dark:text-gray-700">·</span>}
                      </td>
                    );
                  }
                  const types = cache.get(col.group)?.memberships.get(`${r.id}|${col.user.id}`);
                  return <MatrixCell key={col.key} cellKey={col.key} membershipTypes={types} managed={false} />;
                })}
                {visibleRoles.map((role, idx) => {
                  const n = roleCountMap.get(`${r.id}|${role.id}`) || 0;
                  return (
                    <td key={`role:${role.id}`} className={`border-b border-r border-gray-100 dark:border-gray-700 text-center px-1 py-0.5 ${idx === 0 ? 'border-l-2 border-l-indigo-200 dark:border-l-indigo-700' : ''}`} style={{ minWidth: '40px' }}>
                      {n > 0 ? <span className="inline-block text-[11px] font-semibold text-indigo-800 dark:text-indigo-300">{n}</span> : <span className="text-gray-500 dark:text-gray-700">·</span>}
                    </td>
                  );
                })}
                {/* # total */}
                <td className="border-b border-l-2 border-gray-200 dark:border-gray-700 text-center px-1 py-0.5 font-semibold text-gray-800 dark:text-gray-200" style={{ minWidth: '40px' }}>
                  {r._total || <span className="text-gray-500 dark:text-gray-700">·</span>}
                </td>
                {/* Description */}
                <td className="border-b border-gray-200 dark:border-gray-700 px-2 py-1 text-gray-600 dark:text-gray-400" style={{ minWidth: '420px' }} title={r.description || ''}>
                  <div className="truncate max-w-[420px]">{r.description || ''}</div>
                </td>
              </tr>
            ))}
            {orderedResources.length === 0 && (
              <tr><td colSpan={columns.length + trailingCols} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">No assignments match the current filter.</td></tr>
            )}
            {truncated > 0 && (
              <tr><td colSpan={columns.length + trailingCols} className="px-3 py-2 text-center text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20">
                Showing the top {MAX_ROWS} of {orderedResources.length} {rowNoun.toLowerCase()}s by count — add filters to narrow.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

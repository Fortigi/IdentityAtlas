import { useMemo, useState, useCallback, useRef } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import useViewportFitHeight from '@ui/hooks/useViewportFitHeight';
import { friendlyLabel } from '@ui/utils/formatters';
import { getAccessPackageColor } from '@ui/utils/colors';
import { exportRollupToExcel } from '@ui/utils/exportRollupToExcel';
import { useIsDark } from '@ui/contexts/ThemeContext';
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

// Matches the server's attribute-tuple key separator (chr(31)); a tuple key is
// its attribute values joined by it.
const TUPLE_SEP = String.fromCharCode(31);

// The manager-hierarchy plugin names nodes as a full path "A · B · C (Manager,
// Name)". Show the deepest org-unit segment as a compact label.
function orgShort(displayName) {
  const dn = String(displayName || '');
  const noMgr = dn.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const segs = noMgr.split('·').map(s => s.trim()).filter(Boolean);
  return segs[segs.length - 1] || noMgr || dn;
}

export default function RollupMatrixView({
  rollup, filter, counts, managedFilter, setManagedFilter, shareUrl,
  refreshing, onOpenDetail, onAdjustFilter, onFilterChange,
}) {
  const { authFetch } = useAuth();
  const isDark = useIsDark();
  const {
    attribute, rollupContent = 'resources-and-roles', resources, groupValues,
    counts: directCounts, businessRoles = [], roleCounts = [], roleRows = [], cells = [],
    groupTotals = [], rollupKind = 'attribute', nodes = [], breadcrumb = [],
    layered = false, layeredAttributes = false, maxDepth = 1,
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
  // Column label: the deepest org-unit segment; full path + manager stays in
  // the header tooltip.
  const ctxLabel = useCallback((id) => orgShort(nodeMap.get(id)?.displayName || id), [nodeMap]);

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
  const visibleRoles = useMemo(
    () => (!rolesOnly && rollupContent !== 'resources-only' && mode !== 'unmanaged') ? businessRoles : [],
    [rolesOnly, rollupContent, mode, businessRoles]
  );

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
          ? { kind: 'context', contextId: group, includeChildren: false } // direct members of this node
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
          : { ...filter, rollup: null, rollupKind: 'attribute', rollupContextId: null, rollupPath: [], sortHierarchy: null, subject: scopedSubject };
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

  // ── Context zoom: drill INTO a node (push it onto the drill path → the view
  // shows that node's children). Zooming OUT is via the breadcrumb. Expanding a
  // node's direct members is a separate control (toggleGroup), available on any
  // node, so you can see a team's people without leaving the current level.
  const zoomNode = useCallback((nodeId) => {
    onFilterChange?.({ ...filter, rollupPath: [...(filter.rollupPath || []), nodeId] });
  }, [filter, onFilterChange]);

  // ── Layered drill: expand an org IN PLACE — its sub-teams appear as a new
  // header row beneath it (vs. zoom, which replaces the columns). Collapsing an
  // org clicks its (now-merged) parent header. Both just edit rollupExpanded.
  const expandOrg = useCallback((nodeId) => {
    const cur = filter?.rollupExpanded || [];
    if (cur.includes(nodeId)) return;
    onFilterChange?.({ ...filter, rollupExpanded: [...cur, nodeId] });
  }, [filter, onFilterChange]);
  const collapseOrg = useCallback((nodeId) => {
    const cur = filter?.rollupExpanded || [];
    onFilterChange?.({ ...filter, rollupExpanded: cur.filter(id => id !== nodeId) });
  }, [filter, onFilterChange]);

  // ── Attribute fold (collapse model): all chosen attributes show as header
  // rows by default; folding a group (adding its tuple key to rollupCollapsed)
  // pulls its subjects up to that level, unfolding (removing it) drops them back.
  const foldToKey = useCallback((key) => {
    const cur = filter?.rollupCollapsed || [];
    if (cur.includes(key)) return;
    onFilterChange?.({ ...filter, rollupCollapsed: [...cur, key] });
  }, [filter, onFilterChange]);
  const unfoldKey = useCallback((key) => {
    const cur = filter?.rollupCollapsed || [];
    onFilterChange?.({ ...filter, rollupCollapsed: cur.filter(k => k !== key) });
  }, [filter, onFilterChange]);

  // Breadcrumb navigation: jump to a level. Index 0 = the root (path = []),
  // index i = the i-th drill step.
  const jumpToCrumb = useCallback((idx) => {
    onFilterChange?.({ ...filter, rollupPath: breadcrumb.slice(1, idx + 1).map(c => c.id) });
  }, [breadcrumb, filter, onFilterChange]);

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
    const columns = groupValues.map(g => {
      const node = nodeMap.get(g);
      // Layered views carry the full header trail; org names are shortened, plain
      // attribute values are kept as-is. Non-layered = a single header value.
      const path = (layered && node?.pathNames?.length)
        ? (layeredAttributes ? node.pathNames : node.pathNames.map(orgShort))
        : [contextMode ? ctxLabel(g) : (g || '(none)')];
      return { key: g, label: path[path.length - 1], path };
    });
    const roleColumns = visibleRoles.map(r => ({ id: r.id, label: r.displayName }));
    const rows = orderedResources.map(r => ({
      label: r.displayName || r.id,
      description: r.description || '',
      total: r._total,
      cell: (g) => groupCount(r.id, g) || 0,
      roleCell: (roleId) => roleCountMap.get(`${r.id}|${roleId}`) || 0,
    }));
    exportRollupToExcel({
      rowNoun,
      columns,
      roleColumns,
      rows,
      sheetName: rolesOnly ? 'Roll-up (roles)' : 'Roll-up',
      fileName: `matrix-rollup-${contextMode ? 'context' : String(attribute).replace(/[^\w.-]+/g, '_')}.xlsx`,
    }).catch(() => {});
  }, [rowNoun, groupValues, visibleRoles, orderedResources, groupCount, roleCountMap, attribute, contextMode, ctxLabel, rolesOnly, nodeMap, layered, layeredAttributes]);

  // Cap the grid height to the remaining viewport so only the grid scrolls
  // (matches MatrixView). overflow-auto then gives both scrollbars, including
  // the horizontal one when the columns are wider than the screen.
  const scrollRef = useRef(null);
  const gridMaxH = useViewportFitHeight(scrollRef, [columns.length, visibleRoles.length]);

  const trailingCols = visibleRoles.length + 3; // resource + # + Description (+ roles handled separately)

  // Context drill breadcrumb — rendered just above the grid (under the legend).
  const breadcrumbNav = contextMode && !layered && breadcrumb.length > 0 ? (
    <nav className="flex items-center flex-wrap gap-1 text-xs px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700">
      <span className="text-gray-500 dark:text-gray-400 mr-1">Drill path:</span>
      {breadcrumb.map((c, i) => {
        const last = i === breadcrumb.length - 1;
        return (
          <span key={c.id} className="flex items-center gap-1">
            {i > 0 && <span className="text-gray-600 dark:text-gray-500">›</span>}
            {last ? (
              <span className="font-semibold text-gray-800 dark:text-gray-100" title={c.displayName}>{orgShort(c.displayName)}</span>
            ) : (
              <button onClick={() => jumpToCrumb(i)} className="text-blue-600 dark:text-blue-400 hover:underline" title={`Zoom out to ${c.displayName}`}>
                {orgShort(c.displayName)}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  ) : null;

  // ── Layered hierarchy header: one merged row per org level. A node sits at
  // its own level (depth-1); ancestor levels above it are the expanded parents
  // (merged, click to collapse); levels below show the sub-team count (click to
  // expand). Member-expanded people (toggleGroup) ride along as rowSpan columns.
  const mergeKeyAt = (col, L) => {
    const n = nodeMap.get(col.group);
    if (!n) return `__n__${col.group}`;
    return L < (n.depth || 1) ? n.pathIds?.[L] : `__below__${col.group}`;
  };
  const vLabel = (text, extra = '') => (
    <div className={`text-[10px] font-semibold ${extra}`} style={{ writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)', maxHeight: '90px', overflow: 'hidden', whiteSpace: 'nowrap', margin: '0 auto' }}>{text}</div>
  );
  // Only the deepest header row is sticky, so when there are many levels the
  // upper org rows scroll away and the bottom row (the actual leaf columns)
  // stays pinned — you keep column context without the headers eating the grid.
  const spanAt = (col, L) => { let j = 1; while (col._i + j < columns.length && columns[col._i + j].type === 'group' && mergeKeyAt(columns[col._i + j], L) === mergeKeyAt(col, L)) j++; return j; };

  // Attribute fold cell (collapse model): every attribute is a header row.
  // Ancestor/leaf cells fold their group; a folded group's cell unfolds it.
  const layeredAttrCell = (col, L, isLast) => {
    const n = nodeMap.get(col.group);
    const span = spanAt(col, L);
    const sticky = isLast ? ' sticky top-0 z-20' : '';
    const baseTh = `border-b border-r border-gray-300 dark:border-gray-600 px-1 py-1 text-center${sticky}`;
    if (!n) return { span, th: <th key={`${col.key}-${L}`} colSpan={span} className={`${baseTh} bg-gray-100 dark:bg-gray-800`} /> };
    const ownLevel = (n.depth || 1) - 1;
    const isFolded = (n.depth || 1) < maxDepth; // pulled up by a fold
    const key = (d) => (n.pathIds || []).slice(0, d).join(TUPLE_SEP);
    if (L < ownLevel) {
      // ancestor value — click to fold this group to this level
      return { span, th: (
        <th key={`${col.key}-${L}`} colSpan={span} onClick={() => foldToKey(key(L + 1))}
            className={`${baseTh} align-middle bg-gray-100 dark:bg-gray-800 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30`}
            title={`Click to fold ${orgShort(n.pathNames?.[L] || '')}`}>
          <span className="text-[10px] font-semibold text-gray-700 dark:text-gray-300">{orgShort(n.pathNames?.[L] || '')}</span>
        </th>
      ) };
    }
    if (L === ownLevel) {
      if (isFolded) {
        return { span, th: (
          <th key={`${col.key}-${L}`} colSpan={span} onClick={() => unfoldKey(n.id)}
              className={`${baseTh} align-bottom bg-indigo-50 dark:bg-indigo-900/20 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30`}
              style={{ minWidth: '40px', height: '120px' }}
              title={`Folded — click to unfold ${orgShort(n.displayName)} into its ${n.childCount} values (${n.total} ${subjectWord})`}>
            <div className="flex flex-col items-center justify-end h-full gap-1">
              <span className="text-[9px] leading-none text-gray-500 dark:text-gray-400 shrink-0">{n.total}</span>
              {vLabel('▸ ' + orgShort(n.displayName), 'text-indigo-800 dark:text-indigo-200')}
            </div>
          </th>
        ) };
      }
      // leaf (deepest visible value) — click folds its parent group
      const parent = ownLevel > 0 ? key(ownLevel) : null;
      return { span, th: (
        <th key={`${col.key}-${L}`} colSpan={span} onClick={parent ? () => foldToKey(parent) : undefined}
            className={`${baseTh} align-bottom bg-gray-100 dark:bg-gray-800 ${parent ? 'cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30' : ''}`}
            style={{ minWidth: '40px', height: '120px' }}
            title={`${n.displayName} — ${n.total} ${subjectWord}${parent ? ' · click to fold this group' : ''}`}>
          <div className="flex flex-col items-center justify-end h-full gap-1">
            <span className="text-[9px] leading-none text-gray-500 dark:text-gray-400 shrink-0">{n.total}</span>
            {vLabel(orgShort(n.displayName), 'text-gray-700 dark:text-gray-300')}
          </div>
        </th>
      ) };
    }
    // below a folded group's own level — click to unfold; show name on the pinned row
    return { span, th: (
      <th key={`${col.key}-${L}`} colSpan={span} onClick={() => unfoldKey(n.id)}
          className={`${baseTh} align-bottom bg-indigo-50/40 dark:bg-indigo-900/10 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30`}
          title={`Folded — click to unfold ${orgShort(n.displayName)}`}>
        {isLast
          ? vLabel('▸ ' + orgShort(n.displayName), 'text-gray-600 dark:text-gray-400')
          : (L === (n.depth || 1) && n.childCount > 0 ? <span className="text-[9px] text-indigo-700 dark:text-indigo-300">{n.childCount}</span> : null)}
      </th>
    ) };
  };

  const layeredGroupCell = (col, L, isLast) => {
    if (layeredAttributes) return layeredAttrCell(col, L, isLast);
    const n = nodeMap.get(col.group);
    const span = spanAt(col, L);
    const sticky = isLast ? ' sticky top-0 z-20' : '';
    const baseTh = `border-b border-r border-gray-300 dark:border-gray-600 px-1 py-1 text-center${sticky}`;
    if (!n) return { span, th: <th key={`${col.key}-${L}`} colSpan={span} className={`${baseTh} bg-gray-100 dark:bg-gray-800`} /> };
    const ownLevel = (n.depth || 1) - 1;
    if (L < ownLevel) {
      // expanded ancestor — click to collapse this branch back into one column
      return { span, th: (
        <th key={`${col.key}-${L}`} colSpan={span} onClick={() => collapseOrg(n.pathIds[L])}
            className={`${baseTh} align-middle bg-indigo-50 dark:bg-indigo-900/20 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30`}
            title={`Collapse ${n.pathNames?.[L] || ''} back into one column`}>
          <span className="text-[10px] font-semibold text-indigo-800 dark:text-indigo-200">▾ {orgShort(n.pathNames?.[L] || '')}</span>
        </th>
      ) };
    }
    if (L === ownLevel) {
      const isMembersExp = expanded.has(col.group);
      const loadingM = loadingGroup.has(col.group);
      const canExpand = (n.childCount || 0) > 0;
      const hasMembers = (n.directMembers || 0) > 0;
      const btn = 'w-4 h-4 flex items-center justify-center text-[10px] leading-none shrink-0';
      // Clicking the team header expands it in place into its sub-teams (adds a
      // new header row). The small ▸ shows the team's direct people instead.
      return { span, th: (
        <th key={`${col.key}-${L}`} colSpan={span}
            onClick={canExpand ? () => expandOrg(col.group) : undefined}
            className={`${baseTh} align-bottom ${canExpand ? 'bg-indigo-50 dark:bg-indigo-900/20 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30' : 'bg-gray-100 dark:bg-gray-800'}`}
            style={{ minWidth: '40px', height: '120px' }}
            title={canExpand ? `Click to split ${orgShort(n.displayName)} into its ${n.childCount} sub-teams — ${n.total} ${subjectWord}` : `${n.displayName} — ${n.total} ${subjectWord}`}>
          <div className="flex flex-col items-center justify-end h-full gap-1">
            <span className="text-[9px] leading-none shrink-0 whitespace-nowrap" title={`${n.directMembers} ${subjectWord} directly in this team · ${n.total} in the whole subtree — counting only those with a Direct assignment to a shown resource`}>
              <span className="font-semibold text-sky-600 dark:text-sky-400">{n.directMembers}</span>
              <span className="text-gray-500 dark:text-gray-400">/{n.total}</span>
            </span>
            {hasMembers && (
              <button onClick={(e) => { e.stopPropagation(); toggleGroup(col.group); }} className={`${btn} ${isMembersExp ? 'text-sky-600 dark:text-sky-400' : 'text-gray-600 dark:text-gray-400'} hover:text-sky-600 dark:hover:text-sky-400`}
                title={isMembersExp ? 'Hide the people directly in this team' : `Show the ${n.directMembers} ${subjectWord} directly in this team with a Direct assignment`}>{loadingM ? '⋯' : (isMembersExp ? '▾' : '▸')}</button>
            )}
            {vLabel((canExpand ? '▸ ' : '') + orgShort(n.displayName), canExpand ? 'text-indigo-800 dark:text-indigo-200' : 'text-gray-700 dark:text-gray-300')}
          </div>
        </th>
      ) };
    }
    // below the node's own level — the collapsed column extends down; clicking
    // anywhere in it also splits it. On the pinned bottom row show the team name
    // so the column stays identifiable; otherwise just the sub-team count hint.
    return { span, th: (
      <th key={`${col.key}-${L}`} colSpan={span} onClick={n.childCount ? () => expandOrg(col.group) : undefined}
          className={`${baseTh} align-bottom ${n.childCount ? 'bg-indigo-50/40 dark:bg-indigo-900/10 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/30' : 'bg-gray-50 dark:bg-gray-800/40'}`}
          title={n.childCount ? `Click to split into ${n.childCount} sub-teams` : undefined}>
        {isLast
          ? vLabel(orgShort(n.displayName), 'text-gray-600 dark:text-gray-400')
          : (L === (n.depth || 1) && n.childCount > 0 ? <span className="text-[9px] text-indigo-700 dark:text-indigo-300">{n.childCount}</span> : null)}
      </th>
    ) };
  };
  const layeredHeader = () => {
    const indexed = columns.map((c, i) => ({ ...c, _i: i }));
    const rows = [];
    for (let L = 0; L < maxDepth; L++) {
      const isLast = L === maxDepth - 1;
      const stick = isLast ? ' sticky top-0' : '';
      const cells = [];
      // Resource-name corner — sticky-left every row; sticky-top + labelled only
      // on the pinned bottom row.
      cells.push(
        <th key={`corner-${L}`} className={`sticky left-0 ${isLast ? 'top-0 z-40' : 'z-30'} bg-gray-100 dark:bg-gray-800 border-r border-gray-300 dark:border-gray-600 px-2 py-1 text-left align-bottom text-gray-600 dark:text-gray-300 font-medium ${isLast ? 'border-b' : ''}`} style={{ minWidth: '280px' }}>{isLast ? rowNoun : ''}</th>
      );
      let i = 0;
      while (i < indexed.length) {
        const col = indexed[i];
        if (col.type === 'user') {
          // People columns ride along; the name shows on the pinned bottom row.
          cells.push(
            <th key={`${col.key}-${L}`} className={`border-r border-gray-200 dark:border-gray-600 px-0 py-0 text-center align-bottom bg-blue-50 dark:bg-blue-900/20${stick}${isLast ? ' z-20 border-b' : ''}`} style={{ width: '24px', minWidth: '24px', height: isLast ? '120px' : undefined }} title={col.user.displayName}>
              {isLast ? <div className="text-[10px] font-medium text-blue-700 dark:text-blue-300 cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 mx-auto" style={{ writingMode: 'vertical-lr', textOrientation: 'mixed', transform: 'rotate(180deg)', maxHeight: '110px', overflow: 'hidden', whiteSpace: 'nowrap' }} onClick={() => onOpenDetail?.(col.user.memberType === 'Identity' ? 'identity' : 'user', col.user.id, col.user.displayName)}>{col.user.displayName}</div> : null}
            </th>
          );
          i += 1; continue;
        }
        const { span, th } = layeredGroupCell(col, L, isLast);
        cells.push(th);
        i += span;
      }
      // Trailing # + Description — labelled + sticky only on the bottom row.
      cells.push(<th key={`num-${L}`} className={`border-l-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-1 py-1 align-bottom text-[10px] text-gray-600 dark:text-gray-400 font-medium${stick}${isLast ? ' z-20 border-b' : ''}`} style={{ minWidth: '40px' }} title="Total count for this resource">{isLast ? <div style={{ writingMode: 'vertical-lr', transform: 'rotate(180deg)' }}># ▼</div> : null}</th>);
      cells.push(<th key={`desc-${L}`} className={`border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-2 py-1 align-bottom text-xs text-gray-600 dark:text-gray-400 font-medium text-left${stick}${isLast ? ' z-20 border-b' : ''}`} style={{ minWidth: '420px' }}>{isLast ? 'Description' : ''}</th>);
      rows.push(<tr key={`hl${L}`}>{cells}</tr>);
    }
    return rows;
  };

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
          if (contextMode && layered && layeredAttributes) return (
            <>Aggregated by your fold attributes — every attribute is shown as a header row, and each cell is {valueWord} in that group with a <span className="font-medium">Direct</span> assignment. <span className="font-medium">Click a value</span> to fold its group into a single count column; click a folded column to unfold it again.</>
          );
          if (contextMode && layered) return (
            <>Aggregated by the <span className="font-semibold">Manager Hierarchy</span> — columns are org teams and each cell is {valueWord} in that team with a <span className="font-medium">Direct</span> assignment. The numbers above a team are its <span className="text-sky-600 dark:text-sky-400 font-medium">direct members</span> / total members (whole subtree) that hold one of the shown resources. <span className="font-medium">Click a team header</span> to split it into its sub-teams — they appear as a new header row beneath it; click the name in the row above to collapse it back. <span className="font-medium">▸</span> shows the people directly in a team.</>
          );
          if (contextMode) return (
            <>Aggregated by the <span className="font-semibold">Manager Hierarchy</span> — columns are the teams under the highlighted node, and each cell is {valueWord} anywhere under that team who {rolesOnly ? 'hold the business role on that row' : <>have a <span className="font-medium">Direct</span> assignment</>}. Click <span className="font-medium">⊕</span> to zoom into a team's sub-teams, <span className="font-medium">▸</span> to expand its direct people. Use the breadcrumb above to go back up.</>
          );
          return rolesOnly ? (
            <>Business roles on the rows, grouped by <span className="font-semibold">{friendlyLabel(String(attribute).replace(/^ext\./, ''))}</span> — each cell is {valueWord} who hold the role.</>
          ) : (
            <>Roll-up by <span className="font-semibold">{friendlyLabel(String(attribute).replace(/^ext\./, ''))}</span> — each cell is {valueWord}
            {mode === 'managed' ? ' governed' : mode === 'unmanaged' ? ' non-governed' : ''} with a
            <span className="font-medium"> Direct</span> assignment. Click a column to expand it into the individual {subjectWord}.</>
          );
        })()}
        {refreshing && <span className="ml-2 text-gray-500 dark:text-gray-400">updating…</span>}
      </div>

      {/* How to read this matrix — same legend as the per-subject view. */}
      <MatrixLegend />

      {/* Context drill breadcrumb — sits just above the column headers. */}
      {breadcrumbNav}

      <div ref={scrollRef} className="relative border border-gray-200 dark:border-gray-700 rounded-lg overflow-auto" style={{ maxHeight: gridMaxH ? `${gridMaxH}px` : undefined }}>
        <table className="border-collapse text-xs">
          <thead className={layered ? '' : 'sticky top-0 z-20'}>
            {layered ? layeredHeader() : (
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
                          const canZoom = (node?.childCount || 0) > 0;
                          const hasMembers = (node?.directMembers || 0) > 0;
                          const btn = 'w-4 h-4 flex items-center justify-center text-[10px] leading-none shrink-0';
                          return (
                            <>
                              {node?.total != null && (
                                <span className="text-[9px] leading-none text-gray-500 dark:text-gray-400 shrink-0" title={`${node.total} ${subjectWord} in this org (whole subtree)`}>{node.total}</span>
                              )}
                              {hasMembers && (
                                <button
                                  onClick={() => toggleGroup(col.group)}
                                  className={`${btn} ${isExp ? 'text-sky-600 dark:text-sky-400' : 'text-gray-600 dark:text-gray-400'} hover:text-sky-600 dark:hover:text-sky-400`}
                                  title={isExp ? 'Hide the people directly in this team' : `Show the ${node.directMembers} ${subjectWord} directly in this team`}
                                >{loading ? '⋯' : (isExp ? '▾' : '▸')}</button>
                              )}
                              {canZoom && (
                                <button
                                  onClick={() => zoomNode(col.group)}
                                  className={`${btn} text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400`}
                                  title={`Zoom into ${ctxLabel(col.group)} — show its sub-teams`}
                                >⊕</button>
                              )}
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
            )}
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

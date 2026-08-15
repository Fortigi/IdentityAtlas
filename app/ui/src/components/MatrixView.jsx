import { useMemo, useState, useReducer, useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// useState-equivalent backed by useReducer (supports value + functional
// updates): dispatch isn't flagged by react-hooks/set-state-in-effect, so the
// fold state reset/seed effects below stay clear of the rule.
const setStateReducer = (s, a) => (typeof a === 'function' ? a(s) : a);
import { useAuth } from '@ui/auth/AuthGate';
import { useMatrixRowOrder } from '@ui/hooks/useMatrixRowOrder';
import { useNestedGroupExpand } from '@ui/hooks/useNestedGroupExpand';
import MatrixToolbar from './matrix/MatrixToolbar';
import MatrixLegend from './matrix/MatrixLegend';
import MatrixFilterSummary from './matrix/MatrixFilterSummary';
import MatrixScopePanel from './matrix/MatrixScopePanel';
import MatrixColumnHeaders from './matrix/MatrixColumnHeaders';
import MatrixGroupRow from './matrix/MatrixGroupRow';
import { buildResourceContextMap } from '@ui/utils/resourceContexts';
import { AGG_SENTINEL, collapseKey, buildColumns } from './matrix/columnModel';
import { toggleCollapsedGroups } from './matrix/foldState';
import { buildMatrixModel } from './matrix/matrixModel';
import { buildAccessPackages, buildApSortedGroups } from './matrix/accessPackageModel';
import { buildDisplayGroups } from './matrix/nestedRows';
import InheritancePathModal from './matrix/InheritancePathModal';
import { useHierarchyReset } from './matrix/useHierarchyReset';

// Re-exported for consumers that key aggregate-column detection off this sentinel.
export { AGG_SENTINEL };

// Inline arrayMove so MatrixView doesn't depend on @dnd-kit
function arrayMove(arr, from, to) {
  const result = [...arr];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

// Empty state shown when the user hasn't created a matrix yet.
function EmptyFilterState({ onAdjustFilter, hasData }) {
  if (hasData === false) {
    return (
      <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-10 text-center bg-white dark:bg-gray-800">
        <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-1">No data available yet</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-xl mx-auto">
          Run a crawler first to import users and resources. Once data is loaded you can build a matrix here.
        </p>
      </div>
    );
  }
  if (hasData === null) return null;
  return (
    <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-10 text-center bg-white dark:bg-gray-800">
      <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-1">Pick a slice to inspect</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-xl mx-auto mb-4">
        The Matrix tab always operates on a defined sub-selection of subjects (users or
        identities) and resources. Open the wizard to set up which slice to compare.
      </p>
      <button
        onClick={onAdjustFilter}
        className="px-4 py-2 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600"
      >
        Create matrix
      </button>
    </div>
  );
}

// Above this many assignments, an 'auto' fold-on-load matrix opens folded.
const FOLD_AUTO_THRESHOLD = 5000;

// Short label for a manager-hierarchy node name ("A · B · C (Manager)" → "C").
function orgShort(name) {
  const noMgr = String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const segs = noMgr.split('·').map(s => s.trim()).filter(Boolean);
  return segs[segs.length - 1] || noMgr;
}

export default function MatrixView({
  data, accessPackageGroups = [], managedByPackages = [], resourceContexts,
  filter,
  counts,
  managedFilter, setManagedFilter,
  groupTagMap,
  refreshing,
  shareUrl,
  onOpenDetail,
  onAdjustFilter,
  hasData,
}) {
  // ─── Nested group expansion ─────────────────────────────────────
  const { authFetch } = useAuth();

  // ─── Inherited-access path explainer ────────────────────────────
  // Per-cell {nodeId, capabilityId, principalId} for engine-derived inherited
  // (Indirect) rows, so clicking the I badge can explain how it was inherited.
  const inheritedByCell = useMemo(() => {
    const m = new Map();
    for (const d of (data || [])) {
      if (d.inheritedNodeId && d.membershipType === 'Indirect') {
        m.set(`${d.resourceId}|${d.memberId}`, {
          nodeId: d.inheritedNodeId,
          capabilityId: d.inheritedCapabilityId,
          principalId: d.inheritedPrincipalId || d.memberId,
          resourceName: d.resourceDisplayName || d.groupDisplayName || '',
          memberName: d.memberDisplayName || d.memberId,
        });
      }
    }
    return m;
  }, [data]);
  const [pathExplain, setPathExplain] = useState(null);
  const onExplainInherited = useCallback(async (cellKey) => {
    const info = inheritedByCell.get(cellKey);
    if (!info) return;
    setPathExplain({ loading: true, resourceName: info.resourceName, memberName: info.memberName });
    try {
      const res = await authFetch('/api/matrix/inheritance-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: info.nodeId, capabilityId: info.capabilityId, principalId: info.principalId }),
      });
      const body = await res.json();
      setPathExplain({ loading: false, resourceName: info.resourceName, memberName: info.memberName, sources: body.sources || [], chain: body.chain || [] });
    } catch (e) {
      setPathExplain({ loading: false, error: e.message || 'Failed to load path', resourceName: info.resourceName, memberName: info.memberName });
    }
  }, [inheritedByCell, authFetch]);
  const explainHandler = inheritedByCell.size > 0 ? onExplainInherited : undefined;


  // ─── Identity column expansion (show per-account sub-columns) ────
  const [expandedIdentities, setExpandedIdentities] = useState(new Set());
  const [accountMatrixCache, setAccountMatrixCache] = useState(new Map()); // identityId → { accounts, memberships: Map }
  const [loadingIdentityCols, setLoadingIdentityCols] = useState(new Set());

  // ─── Attribute column folding ───────────────────────────────────
  // Collapse subject columns that share a sort-attribute value (e.g. a Division)
  // into ONE aggregate column showing counts. Folding/unfolding behaves like a
  // tree: unfolding a group drops to the NEXT sort level (still folded) rather
  // than jumping straight to individual subjects. (toggleCollapse is defined
  // below, where the sorted `users` list is available.)
  const [collapsedGroups, setCollapsedGroups] = useReducer(setStateReducer, undefined, () => new Set());
  // A folded aggregate column can instead be exploded into its individual member
  // columns AT this level (rather than drilling to the next sort level): Map of
  // collapseKey → 'all' (direct + indirect, the whole subtree) | 'direct' (only
  // subjects whose path ends at this level). Used mainly in Manager-Hierarchy
  // sort, where "drill" reveals the next org layer but you sometimes want to see
  // the people sitting at the current layer.
  const [memberExpanded, setMemberExpanded] = useReducer(setStateReducer, undefined, () => new Map());

  const toggleIdentityColumn = useCallback(async (identityId) => {
    if (expandedIdentities.has(identityId)) {
      setExpandedIdentities(prev => { const n = new Set(prev); n.delete(identityId); return n; });
      return;
    }
    if (!accountMatrixCache.has(identityId)) {
      setLoadingIdentityCols(prev => new Set(prev).add(identityId));
      try {
        const res = await authFetch(`/api/identities/${encodeURIComponent(identityId)}/account-matrix`);
        const data = await res.json();
        const mm = new Map();
        for (const m of (data.memberships || [])) {
          const key = `${m.resourceId}|${m.principalId}`;
          if (!mm.has(key)) mm.set(key, new Set());
          mm.get(key).add(m.membershipType);
        }
        setAccountMatrixCache(prev => new Map(prev).set(identityId, { accounts: data.accounts || [], memberships: mm }));
      } catch (err) {
        console.error('Failed to load account matrix:', err);
        setLoadingIdentityCols(prev => { const n = new Set(prev); n.delete(identityId); return n; });
        return;
      }
      setLoadingIdentityCols(prev => { const n = new Set(prev); n.delete(identityId); return n; });
    }
    setExpandedIdentities(prev => new Set(prev).add(identityId));
  }, [expandedIdentities, accountMatrixCache, authFetch]);

  // Build a stable storage key from the filter (matches per-filter row order)
  const storageKey = useMemo(() => {
    if (!filter) return '';
    return JSON.stringify(filter);
  }, [filter]);

  const rowOrderHook = useMatrixRowOrder(storageKey);

  // A (member, resource) membership is "governed" when it is covered by a
  // business role the user holds — i.e. it appears in managedByPackages, the
  // SAME signal that colours SOLL cells and feeds the scope-stats panel. We do
  // NOT use the per-row managedByAccessPackage flag here: that only flags the
  // rare directly-Governed assignment row, so it reads as ~0 governed on real
  // data and made the Governed toggle show an empty grid.
  const coveredPairSet = useMemo(() => {
    const s = new Set();
    for (const r of managedByPackages || []) {
      const rid = (r.resourceId || r.groupId || '').toLowerCase();
      const mid = (r.memberId || '').toLowerCase();
      if (rid && mid) s.add(`${rid}|${mid}`);
    }
    return s;
  }, [managedByPackages]);

  // Apply CLIENT-SIDE governed/non-governed toggle. Subject and resource filters
  // are already applied by the backend so the matrix data is "the right subset".
  const filteredData = useMemo(() => {
    if (managedFilter !== 'managed' && managedFilter !== 'unmanaged') return data;
    // Owner memberships are never provisioned through an access package (APs grant
    // Direct/Eligible/Member roles), so they are always non-governed.
    const isGoverned = d =>
      d.membershipType !== 'Owner' &&
      coveredPairSet.has(`${(d.resourceId || d.groupId || '').toLowerCase()}|${(d.memberId || '').toLowerCase()}`);
    return managedFilter === 'managed'
      ? data.filter(isGoverned)
      : data.filter(d => !isGoverned(d));
  }, [data, managedFilter, coveredPairSet]);

  // Subject-axis sort order (default: department). Drives both the user sort
  // and the merged attribute header rows.
  // ─── Sort by Manager Hierarchy ──────────────────────────────────
  // When the filter selects a hierarchy root, fetch each subject's ancestor org
  // path and use it as the column sort keys; the merged header rows become the
  // org levels and the existing fold reveals one level at a time.
  const sortHierarchyId = filter?.sortHierarchy?.contextId || null;
  const [hierPaths, setHierPaths] = useState(null); // Map subjectId → short label[]
  const [hierDepth, setHierDepth] = useState(0);
  // Clear the hierarchy paths when no hierarchy is selected — during render on
  // the transition, so the fetch effect body holds no synchronous setState.
  useHierarchyReset(sortHierarchyId, () => { setHierPaths(null); setHierDepth(0); });
  useEffect(() => {
    if (!sortHierarchyId) return undefined;
    let cancelled = false;
    authFetch('/api/matrix/hierarchy-paths', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootContextId: sortHierarchyId, rowType: filter?.rowType }),
    })
      .then(r => r.ok ? r.json() : { paths: {}, depth: 0 })
      .then(body => {
        if (cancelled) return;
        const m = new Map();
        let maxD = 0;
        for (const [sid, path] of Object.entries(body.paths || {})) {
          const short = [];
          for (const seg of path) { const s = orgShort(seg); if (!short.length || short[short.length - 1] !== s) short.push(s); }
          m.set(sid, short);
          if (short.length > maxD) maxD = short.length;
        }
        setHierPaths(m); setHierDepth(maxD);
      })
      .catch(() => { if (!cancelled) { setHierPaths(new Map()); setHierDepth(0); } });
    return () => { cancelled = true; };
  }, [sortHierarchyId, filter?.rowType, authFetch]);

  const hierActive = !!sortHierarchyId && hierDepth > 0;

  const sortAttrs = useMemo(() => {
    if (hierActive) return Array.from({ length: hierDepth }, (_, i) => ({ attribute: `Org level ${i + 1}`, dir: 'asc' }));
    return filter?.sortAttributes?.length ? filter.sortAttributes : [{ attribute: 'department', dir: 'asc' }];
  }, [filter, hierActive, hierDepth]);

  // Build matrix data structures
  // Owner memberships are split into separate synthetic rows (id: "groupId__owner",
  // realGroupId: original groupId, displayName suffixed with "(Owner)").
  // D/I/E memberships stay on the regular group row.
  // Contexts each resource belongs to (group category, tags, clusters, …),
  // keyed by uppercase resource id — rendered as the right-side Contexts column.
  const resourceContextMap = useMemo(
    () => buildResourceContextMap(resourceContexts), [resourceContexts]);

  const { users, groups, memberships, managedMap } = useMemo(
    () => buildMatrixModel(filteredData, {
      groupTagMap, resourceContextMap, sortAttrs, hierActive, hierDepth, hierPaths,
    }),
    [filteredData, groupTagMap, resourceContextMap, sortAttrs, hierActive, hierDepth, hierPaths]);

  // Seed the initial fold state from the wizard's foldOnLoad setting, once per
  // matrix (storageKey) when its subjects have loaded. 'auto' folds only for
  // large matrices so the first paint stays fast. User fold/unfold actions
  // afterwards aren't overridden (we only seed once per filter).
  const seededFoldRef = useRef(null);
  useEffect(() => { seededFoldRef.current = null; setCollapsedGroups(new Set()); setMemberExpanded(new Map()); }, [storageKey]);
  useEffect(() => {
    if (seededFoldRef.current === storageKey || users.length === 0) return;
    // A Manager-Hierarchy matrix has thousands of columns — always open folded.
    // Wait for the hierarchy paths to load so we fold on the right (org) keys.
    const wantsHierarchy = !!sortHierarchyId;
    if (wantsHierarchy && !hierActive) return;
    seededFoldRef.current = storageKey;
    const fol = filter?.foldOnLoad ?? 'auto';
    const shouldFold = wantsHierarchy
      ? true
      : (fol === 'auto' ? ((counts?.assignmentCount || 0) >= FOLD_AUTO_THRESHOLD) : !!fol);
    if (shouldFold) setCollapsedGroups(new Set(users.map(u => collapseKey(u.sortKeys, 0))));
  }, [storageKey, users, filter, counts, sortHierarchyId, hierActive]);

  // Build managed-by-AP map: cellKey (lowercase) -> accessPackageId[] (lowercase)
  // All keys and values normalized to lowercase for case-insensitive matching
  const managedApMap = useMemo(() => {
    const map = new Map();
    if (!managedByPackages || managedByPackages.length === 0) return map;
    for (const r of managedByPackages) {
      const rid = (r.resourceId || r.groupId || '').toLowerCase();
      const key = `${rid}|${(r.memberId || '').toLowerCase()}`;
      map.set(key, (r.accessPackageIds || []).map(id => id.toLowerCase()));
    }
    return map;
  }, [managedByPackages]);

  // Build access package data (SOLL matrix): which groups are in which access packages
  // Only include APs where at least one visible user actually has an assignment through that AP.
  const { accessPackages, apGroupMap } = useMemo(
    () => buildAccessPackages(accessPackageGroups, groups, users, managedApMap),
    [accessPackageGroups, groups, users, managedApMap]);

  // AP ID (lowercase) -> sorted index (for consistent color lookup)
  const apIdToIndex = useMemo(() => {
    const map = new Map();
    accessPackages.forEach((ap, idx) => map.set(ap.id.toLowerCase(), idx));
    return map;
  }, [accessPackages]);

  // Default sort: AP staircase pattern.
  // All groups in the leftmost AP first, then next AP, etc. Unmanaged at the bottom.
  const apSortedGroups = useMemo(
    () => buildApSortedGroups(groups, accessPackages, apGroupMap, managedFilter),
    [groups, accessPackages, apGroupMap, managedFilter]);

  // Apply custom drag-row order on top of the default AP staircase sort. All
  // subject/resource selection happens through the filter wizard, so there
  // are no per-column filters to apply here any more.
  const { getOrderedGroups } = rowOrderHook;
  const orderedGroups = useMemo(() => {
    return getOrderedGroups(apSortedGroups);
  }, [apSortedGroups, getOrderedGroups]);

  const groupIds = useMemo(() => orderedGroups.map(g => g.id), [orderedGroups]);

  // Nested-group expand state + fetches (opening a group row reveals the
  // resources its members inherit). Lives in its own hook so this component
  // stays focused on rendering the grid; see useNestedGroupExpand.
  const {
    groupsWithNested, expandedGroups, nestedDataCache, loadingNested,
    toggleExpand, expandAll, collapseAll,
  } = useNestedGroupExpand({ authFetch, filter, storageKey, orderedGroups });

  // ─── Inject nested sub-rows after expanded groups ───────────────
  const nestedMemberships = useMemo(() => {
    if (expandedGroups.size === 0) return new Map();
    const map = new Map();
    for (const [parentId, data] of nestedDataCache) {
      if (!expandedGroups.has(parentId)) continue;
      for (const m of data.memberships) {
        const key = `${parentId}__nested__${m.groupId}|${m.memberId}`;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(m.membershipType);
      }
    }
    return map;
  }, [nestedDataCache, expandedGroups]);

  const displayGroups = useMemo(
    () => buildDisplayGroups(orderedGroups, {
      expandedGroups, nestedDataCache, nestedMemberships, users, resourceContextMap,
    }),
    [orderedGroups, expandedGroups, nestedDataCache, nestedMemberships, users, resourceContextMap]);

  const displayMemberships = useMemo(() => {
    if (nestedMemberships.size === 0) return memberships;
    const merged = new Map(memberships);
    for (const [k, v] of nestedMemberships) merged.set(k, v);
    return merged;
  }, [memberships, nestedMemberships]);

  // When "gaps" filter is active, pre-filter groups so the virtualizer gets the correct count.
  // Previously this check lived inside MatrixGroupRow (returning null), which caused the
  // virtualizer to reserve space for rows that rendered nothing.
  const visibleGroups = useMemo(() => {
    if (managedFilter !== 'gaps') return displayGroups;
    return displayGroups.filter(group => {
      const isOwnerRow = !!group.realGroupId && !group.isNestedRow;
      const realGid = group.realGroupId || group.id;
      const lookupGid = realGid.toUpperCase();

      const groupAps = accessPackages.filter(ap => {
        const role = apGroupMap?.get(`${lookupGid}|${ap.id.toLowerCase()}`);
        if (!role) return false;
        const roleIsOwner = role.toLowerCase().includes('owner');
        return isOwnerRow ? roleIsOwner : !roleIsOwner;
      });
      if (groupAps.length === 0) return false;

      const groupApIdSetLower = new Set(groupAps.map(ap => ap.id.toLowerCase()));
      return users.some(user => {
        const cellKeyLower = `${realGid.toLowerCase()}|${user.id.toLowerCase()}`;
        const userApIds = (managedApMap?.get(cellKeyLower) || []).filter(id => groupApIdSetLower.has(id));
        if (userApIds.length === 0) return false;

        const cellKey = `${group.id}|${user.id}`;
        const cellTypes = displayMemberships.get(cellKey);
        return userApIds.some(apId => {
          const apObj = groupAps.find(a => a.id.toLowerCase() === apId);
          const role = apObj ? (apGroupMap?.get(`${lookupGid}|${apObj.id.toLowerCase()}`) || 'Member') : 'Member';
          const lower = role.toLowerCase();
          if (lower.includes('owner')) return !cellTypes?.has('Owner');
          if (lower.includes('eligible')) return !cellTypes?.has('Eligible');
          return !cellTypes?.has('Direct');
        });
      });
    });
  }, [displayGroups, managedFilter, accessPackages, apGroupMap, users, managedApMap, displayMemberships]);

  // Lazy-load SortableMatrixBody (contains @dnd-kit + @tanstack/react-virtual)
  const [SortableBody, setSortableBody] = useState(null);
  useEffect(() => {
    import('./matrix/SortableMatrixBody').then(m => setSortableBody(() => m.default));
  }, []);

  const handleRowDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = groupIds.indexOf(active.id);
    const newIndex = groupIds.indexOf(over.id);
    const newOrder = arrayMove(groupIds, oldIndex, newIndex);
    rowOrderHook.updateOrder(newOrder);
  }, [groupIds, rowOrderHook]);

  // Sort rows by member count descending (clears any custom drag order)
  const handleSortByCount = useCallback(() => {
    const sorted = [...orderedGroups].sort((a, b) => b.memberCount - a.memberCount);
    rowOrderHook.updateOrder(sorted.map(g => g.id));
  }, [orderedGroups, rowOrderHook]);

  // Excel export handler (lazy-loads ExcelJS ~200KB only when export is clicked)
  const handleExportExcel = useCallback(async () => {
    const { exportToExcel } = await import('../utils/exportToExcel');
    exportToExcel({
      users,
      orderedGroups,
      memberships,
      managedApMap,
      apIdToIndex,
      activeFilters: [],
      filterFields: [],
      accessPackages,
      apGroupMap,
      shareUrl,
      sortAttributes: sortAttrs,
    });
  }, [users, orderedGroups, memberships, managedApMap, apIdToIndex, accessPackages, apGroupMap, shareUrl, sortAttrs]);

  // Share: copy URL to clipboard
  const handleShare = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      return true;
    } catch {
      return false;
    }
  }, [shareUrl]);

  // Number of info columns on the left (drag handle + resource name + type)
  const infoColumnCount = 3;

  // The access-package (SOLL) columns represent governance, so they're hidden in
  // the Non-governed view — there they'd only show governed memberships, which is
  // what that view is meant to exclude. Kept for All / Governed / Gaps.
  const visibleAccessPackages = managedFilter === 'unmanaged' ? [] : accessPackages;

  // Columns rendered = identity/principal subjects with per-account sub-columns
  // spliced in after any expanded identity, AND collapsed attribute groups
  // replaced by a single aggregate column. Analytics above stay keyed on the
  // identity-only `users`; only rendering uses these augmented sets.
  const { cols: colUsers, userToAgg } = useMemo(
    () => buildColumns(users, {
      collapsedGroups, memberExpanded, sortAttrs, expandedIdentities, accountMatrixCache,
    }),
    [users, collapsedGroups, memberExpanded, sortAttrs, expandedIdentities, accountMatrixCache]);

  const colMemberships = useMemo(() => {
    if (expandedIdentities.size === 0) return displayMemberships;
    const merged = new Map(displayMemberships);
    for (const id of expandedIdentities) {
      const cache = accountMatrixCache.get(id);
      if (!cache) continue;
      for (const [k, v] of cache.memberships) merged.set(k, v);
    }
    return merged;
  }, [displayMemberships, expandedIdentities, accountMatrixCache]);

  // For each (resource-row, aggregate-column): how many of the folded users hold
  // a Direct assignment — the "count of D's" shown in the collapsed cell. Keyed
  // "<groupId> <aggColId>".
  const aggDirectCounts = useMemo(() => {
    if (collapsedGroups.size === 0) return null;
    const counts = new Map();
    for (const [k, types] of colMemberships) {
      if (!types || !types.has('Direct')) continue;
      const sep = k.lastIndexOf('|');
      if (sep < 0) continue;
      const aggId = userToAgg.get(k.slice(sep + 1));
      if (!aggId) continue;
      const ck = `${k.slice(0, sep)} ${aggId}`;
      counts.set(ck, (counts.get(ck) || 0) + 1);
    }
    return counts;
  }, [colMemberships, userToAgg, collapsedGroups]);

  // Fold every top-level (first sort attribute) group into one aggregate column;
  // unfold clears all collapses. There's something to fold only when the first
  // attribute has more than one distinct value.
  const distinctTopGroups = useMemo(() => new Set(users.map(u => collapseKey(u.sortKeys, 0))), [users]);
  const canFoldColumns = distinctTopGroups.size > 1;
  const foldAllColumns = useCallback(() => setCollapsedGroups(new Set(distinctTopGroups)), [distinctTopGroups]);
  const unfoldAllColumns = useCallback(() => setCollapsedGroups(new Set()), []);

  // Tree-aware fold toggle. Folding a group also clears any deeper sub-folds it
  // now hides; UNfolding it drops to the next sort level (its child groups stay
  // folded) unless it's already the deepest level.
  const toggleCollapse = useCallback((sortKeys, level) => {
    setCollapsedGroups(prev => toggleCollapsedGroups(prev, users, sortKeys, level, sortAttrs.length));
  }, [users, sortAttrs]);

  // Explode a folded aggregate column into its individual member columns at the
  // SAME level (vs. toggleCollapse, which drills to the next level). Clicking the
  // same mode again, or the org's own level header, collapses back to the count.
  const toggleMembers = useCallback((sortKeys, level, mode) => {
    const key = collapseKey(sortKeys, level);
    setMemberExpanded(prev => {
      const next = new Map(prev);
      if (next.get(key) === mode) next.delete(key);
      else if (mode) next.set(key, mode);
      else next.delete(key);
      return next;
    });
  }, []);

  // In Manager-Hierarchy sort, only show as many org-level header rows as have
  // actually been unfolded: a folded group reaches level+1, an unfolded subject
  // reaches its own path depth. Attribute sort always shows all chosen levels.
  const headerDepth = useMemo(() => {
    if (!hierActive) return sortAttrs.length;
    let d = 1;
    for (const c of colUsers) {
      const cd = c.isAggregateCol
        ? c.level + 1
        : (c.sortKeys || []).reduce((n, v, i) => (v ? i + 1 : n), 0) || 1;
      if (cd > d) d = cd;
    }
    return Math.min(d, sortAttrs.length);
  }, [hierActive, colUsers, sortAttrs.length]);

  // Shared column headers element (used by both sortable and static table)
  const columnHeaders = (
    <MatrixColumnHeaders
      users={colUsers}
      infoColumnCount={infoColumnCount}
      onSortByCount={handleSortByCount}
      accessPackages={visibleAccessPackages}
      sortAttributes={sortAttrs}
      maxHeaderDepth={headerDepth}
      onOpenDetail={onOpenDetail}
      expandedIdentities={expandedIdentities}
      onToggleIdentity={toggleIdentityColumn}
      loadingIdentityCols={loadingIdentityCols}
      onToggleCollapse={toggleCollapse}
      onToggleMembers={toggleMembers}
    />
  );

  // Ref for the scroll container (needed by virtualizer)
  const scrollRef = useRef(null);

  const filterIsApplied = filter !== null && filter !== undefined;

  // Cap the grid's height to the remaining viewport so ONLY the grid scrolls,
  // never the page too. A fixed viewport-minus-fixed-pixels max-height guesses
  // the chrome height; the real chrome (auth banner + scope stats + "How to
  // read") is taller, so the grid sat too low and the page got a second
  // scrollbar. Measure the grid's real document-top instead and re-measure on
  // any layout change (header content loads late, panels toggle).
  const rootRef = useRef(null);
  const [gridMaxH, setGridMaxH] = useState(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = scrollRef.current;
      if (!el) return;
      // Reserve room for the app footer (below <main>) + main's bottom padding.
      const footer = document.querySelector('footer');
      const below = (footer ? footer.getBoundingClientRect().height : 0) + 28;
      // clientHeight = real layout height; document-relative top (rect.top is
      // viewport-relative, so a scrolled page would read too small and cap the
      // grid too tall — a self-sustaining overflow). scrollY corrects that.
      const vh = document.documentElement.clientHeight;
      const gridTop = el.getBoundingClientRect().top + window.scrollY;
      // Fit the grid into the remaining viewport so ONLY the grid scrolls. Use
      // the available space directly (so the page never gets a second
      // scrollbar); a fixed 240px floor on a short viewport with tall chrome
      // (e.g. gridTop ~530 on an 800px viewport leaves ~206px) overflowed the
      // page by ~30px. A small 160px floor keeps the grid usable without
      // re-introducing the overflow in any realistic viewport.
      const avail = vh - gridTop - below;
      setGridMaxH(Math.max(160, avail));
    };
    measure();
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure); // body: anything above the grid shifts it down
      ro.observe(document.body);
    }
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', measure); if (ro) ro.disconnect(); };
  }, [filterIsApplied, users.length]);

  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      {filterIsApplied && (
        <MatrixFilterSummary
          filter={filter}
          preview={counts}
          onAdjust={onAdjustFilter}
        />
      )}

      {filterIsApplied && <MatrixScopePanel filter={filter} />}

      <MatrixToolbar
        managedFilter={managedFilter}
        setManagedFilter={setManagedFilter}
        onExportExcel={handleExportExcel}
        onShare={handleShare}
        onResetRowOrder={rowOrderHook.resetOrder}
        hasCustomRowOrder={rowOrderHook.hasCustomOrder}
        hasExpandableGroups={groupsWithNested.size > 0}
        hasExpandedGroups={expandedGroups.size > 0}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
        canFoldColumns={canFoldColumns}
        isFolded={collapsedGroups.size > 0}
        onFoldAllColumns={foldAllColumns}
        onUnfoldAllColumns={unfoldAllColumns}
      />

      {filterIsApplied && <MatrixLegend />}

      {!filterIsApplied ? (
        <EmptyFilterState onAdjustFilter={onAdjustFilter} hasData={hasData} />
      ) : users.length === 0 || orderedGroups.length === 0 ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">
          No assignments match the current filter. Adjust the subjects or resources to widen the view.
        </div>
      ) : (
        <div ref={scrollRef} className="relative border border-gray-200 dark:border-gray-700 rounded-lg overflow-auto" style={{ maxHeight: gridMaxH ? `${gridMaxH}px` : undefined }}>
          {refreshing && (
            <div className="absolute inset-0 bg-white/60 dark:bg-gray-900/60 z-10 flex items-center justify-center">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-4 py-2 shadow-sm flex items-center gap-2">
                <svg className="animate-spin h-4 w-4 text-blue-500" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm text-gray-600 dark:text-gray-300">Updating...</span>
              </div>
            </div>
          )}
          {SortableBody ? (
            <SortableBody
              scrollRef={scrollRef}
              orderedGroups={visibleGroups}
              groupIds={groupIds}
              onDragEnd={handleRowDragEnd}
              columnHeaders={columnHeaders}
              users={colUsers}
              memberships={colMemberships}
              aggDirectCounts={aggDirectCounts}
              managedMap={managedMap}
              managedApMap={managedApMap}
              apIdToIndex={apIdToIndex}
              accessPackages={visibleAccessPackages}
              apGroupMap={apGroupMap}
              managedFilter={managedFilter}
              onOpenDetail={onOpenDetail}
              onExplainInherited={explainHandler}
              groupsWithNested={groupsWithNested}
              expandedGroups={expandedGroups}
              onToggleExpand={toggleExpand}
              loadingNested={loadingNested}
            />
          ) : (
            <table className="border-collapse" style={{ tableLayout: 'fixed' }}>
              {columnHeaders}
              <tbody>
                {visibleGroups.map(group => (
                  <MatrixGroupRow
                    key={group.id}
                    group={group}
                    users={colUsers}
                    totalUsers={colUsers.length}
                    memberships={colMemberships}
                    aggDirectCounts={aggDirectCounts}
                    managedMap={managedMap}
                    managedApMap={managedApMap}
                    apIdToIndex={apIdToIndex}
                    accessPackages={visibleAccessPackages}
                    apGroupMap={apGroupMap}
                    managedFilter={managedFilter}
                    onOpenDetail={onOpenDetail}
                    onExplainInherited={explainHandler}
                    groupsWithNested={groupsWithNested}
                    expandedGroups={expandedGroups}
                    onToggleExpand={toggleExpand}
                    loadingNested={loadingNested}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      <InheritancePathModal pathExplain={pathExplain} onClose={() => setPathExplain(null)} />
    </div>
  );
}

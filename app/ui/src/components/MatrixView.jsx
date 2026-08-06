import { useMemo, useState, useReducer, useCallback, useEffect, useRef } from 'react';

// useState-equivalent backed by useReducer (supports value + functional
// updates): dispatch isn't flagged by react-hooks/set-state-in-effect, so the
// fold state reset/seed effects below stay clear of the rule.
const setStateReducer = (s, a) => (typeof a === 'function' ? a(s) : a);
import { useAuth } from '@ui/auth/AuthGate';
import { useMatrixRowOrder } from '@ui/hooks/useMatrixRowOrder';
import { useNestedGroupExpand, MAX_NEST_LEVEL } from '@ui/hooks/useNestedGroupExpand';
import { useBusinessRoleFold } from '@ui/hooks/useBusinessRoleFold';
import useResizableGridHeight from '@ui/hooks/useResizableGridHeight';
import GridResizeHandle from './matrix/GridResizeHandle';
import MatrixToolbar from './matrix/MatrixToolbar';
import MatrixLegend from './matrix/MatrixLegend';
import MatrixFilterSummary from './matrix/MatrixFilterSummary';
import MatrixScopePanel from './matrix/MatrixScopePanel';
import MatrixColumnHeaders from './matrix/MatrixColumnHeaders';
import { makeUserComparator, buildSortKeys } from './matrix/sortUsers';
import MatrixGroupRow from './matrix/MatrixGroupRow';
import { buildRoleDeviationCounts, cellDeviation, NO_ROLE_DEVIATIONS } from './matrix/coverageDeviation';

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

// Marks an aggregate column's sort-key values BELOW its collapse level, so the
// merged header renders a child-count there (and two aggregate columns never
// fuse into one span). Picked from the private-use area so it can't collide
// with real attribute values.
export const AGG_SENTINEL = '@@AGG@@';

// Above this many assignments, an 'auto' fold-on-load matrix opens folded.
const FOLD_AUTO_THRESHOLD = 5000;

// The AP-staircase bucket a resource row falls into: the leftmost access-package
// column that grants it, or accessPackages.length ("unmanaged") when none does.
// Owner rows only match AP columns whose role is Owner.
function leftmostApBucket(group, accessPackages, apGroupMap) {
  const gidUpper = (group.realGroupId || group.id).toUpperCase();
  const isOwnerRow = !!group.realGroupId;
  for (let i = 0; i < accessPackages.length; i++) {
    const role = apGroupMap.get(`${gidUpper}|${accessPackages[i].id.toLowerCase()}`);
    if (!role) continue;
    if (isOwnerRow === role.toLowerCase().includes('owner')) return i;
  }
  return accessPackages.length;
}

// Short label for a manager-hierarchy node name ("A · B · C (Manager)" → "C").
function orgShort(name) {
  const noMgr = String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const segs = noMgr.split('·').map(s => s.trim()).filter(Boolean);
  return segs[segs.length - 1] || noMgr;
}

// Key identifying a collapsed attribute group: the level plus the sort-key
// prefix up to and including `level`. Each segment is length-prefixed so two
// different value sequences can never collide.
function collapseKey(sortKeys, level) {
  const seg = (sortKeys || []).slice(0, level + 1).map(v => `${String(v).length}:${v}`).join('|');
  return `${level}|${seg}`;
}

// A per-account sub-column spliced in under an expanded identity (or member),
// inheriting the parent's sort-keys so the merged attribute headers stay contiguous.
function makeAccountCol(parent, acc, sortKeys) {
  return {
    id: acc.id,
    displayName: acc.displayName || acc.id,
    jobTitle: parent.jobTitle || '',
    department: parent.department || '',
    upn: '',
    memberType: 'Principal',
    isAccountCol: true,
    parentId: parent.id,
    accountType: acc.accountType || null,
    isPrimary: !!acc.isPrimary,
    sortKeys: [...(sortKeys || [])],
  };
}

// Which business role grants which resource row, from the (role, resource)
// payload — the SOLL side of the grid. Two things earn a role a column: it
// grants a resource that is on screen, or its OWN row is (holding the role IS a
// governed Direct assignment on it, which is not a `Contains` relationship and
// so can never arrive as a pair — without this the role's column was blank on
// its own row). Returns the roles keyed by id plus a "RESOURCE|role" → roleName
// mapping.
function buildApMapping(accessPackageGroups, visibleGroupIds) {
  const apMap = new Map();
  const mapping = new Map();
  for (const row of accessPackageGroups) {
    const gid = (row.resourceId || row.groupId)?.toUpperCase();
    const selfGid = row.accessPackageId?.toUpperCase();
    const selfVisible = !!selfGid && visibleGroupIds.has(selfGid);
    const childVisible = !!gid && visibleGroupIds.has(gid);
    if (!selfVisible && !childVisible) continue;
    if (!apMap.has(row.accessPackageId)) {
      apMap.set(row.accessPackageId, {
        id: row.accessPackageId,
        displayName: row.accessPackageName,
        catalogName: row.catalogName,
        totalAssignments: row.totalAssignments || 0,
        categoryName: row.categoryName || null,
        categoryColor: row.categoryColor || null,
      });
    }
    const apKey = row.accessPackageId.toLowerCase();
    if (selfVisible) mapping.set(`${selfGid}|${apKey}`, 'Member');
    if (childVisible) mapping.set(`${gid}|${apKey}`, row.roleName || 'Member');
  }
  return { apMap, mapping };
}

// Column order: by category name, then by total assignments descending within
// each category; uncategorized roles go last.
function compareAccessPackages(a, b) {
  const aCat = a.categoryName;
  const bCat = b.categoryName;
  if (aCat && !bCat) return -1;
  if (!aCat && bCat) return 1;
  if (aCat && bCat && aCat !== bCat) return aCat.localeCompare(bCat);
  return b.totalAssignments - a.totalAssignments || a.displayName.localeCompare(b.displayName);
}

export default function MatrixView({
  data, accessPackageGroups = [], managedByPackages = [],
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
  const [seenHierId, setSeenHierId] = useState(sortHierarchyId);
  if (sortHierarchyId !== seenHierId) {
    setSeenHierId(sortHierarchyId);
    if (!sortHierarchyId) { setHierPaths(null); setHierDepth(0); }
  }
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
  const { users, groups, memberships, managedMap } = useMemo(() => {
    const userMap = new Map();
    const groupMap = new Map();
    const membershipMap = new Map();
    const managed = new Map();

    filteredData.forEach(d => {
      // Users
      if (d.memberId && !userMap.has(d.memberId)) {
        const u = {
          id: d.memberId,
          displayName: d.memberDisplayName || d.memberId,
          jobTitle: d.jobTitle || '',
          department: d.department || '',
          upn: d.memberUPN || '',
          memberType: d.memberType || '',
        };
        // Precompute the sort values (attribute order) for multi-key sort +
        // merged headers. Stored under a static `sortKeys` key — the user-derived
        // attribute names are only read, never used as a write target.
        u.sortKeys = hierActive
          ? Array.from({ length: hierDepth }, (_, i) => (hierPaths.get(d.memberId)?.[i] ?? ''))
          : buildSortKeys(d, sortAttrs);
        userMap.set(d.memberId, u);
      }

      // Always create the base group/resource entry
      const gid = d.resourceId || d.groupId;
      if (gid && !groupMap.has(gid)) {
        const name = d.resourceDisplayName || d.groupDisplayName || gid;
        const tags = groupTagMap?.get(gid.toUpperCase()) || [];

        groupMap.set(gid, {
          id: gid,
          displayName: name,
          tags,
          description: d.resourceDescription || d.groupDescription || '',
          groupType: d.resourceType || d.groupTypeCalculated || '',
          systemName: d.systemName || '',
        });
      }

      // Group ownership is its own resource now (resourceType='GroupOwnership',
      // shown as a normal row), so every membership lands on its real resource
      // row — no client-side owner-row simulation. (See "Fix at the source" in
      // the root CLAUDE.md.)
      const key = `${gid}|${d.memberId}`;
      if (!membershipMap.has(key)) {
        membershipMap.set(key, new Set());
      }
      membershipMap.get(key).add(d.membershipType);

      // Track managedByAccessPackage per cell (boolean from view, used for filtering)
      if (d.managedByAccessPackage) {
        managed.set(key, true);
      }
    });

    // Sort users by the configured sort attributes (default department), with
    // displayName as the final tiebreak.
    const users = [...userMap.values()].sort(makeUserComparator(sortAttrs));

    // Compute member counts per group (for default sort and % column)
    // Per-type counts enable priority sorting: Direct > Eligible > Owner > Indirect
    const userList = [...userMap.values()];
    for (const group of groupMap.values()) {
      let memberCount = 0, directCount = 0, eligibleCount = 0, nonIndirectCount = 0;
      for (const u of userList) {
        const types = membershipMap.get(`${group.id}|${u.id}`);
        if (!types || types.size === 0) continue;
        memberCount++;
        if (types.has('Direct'))   directCount++;
        if (types.has('Eligible')) eligibleCount++;
        for (const t of types) { if (t !== 'Indirect') { nonIndirectCount++; break; } }
      }
      group.memberCount = memberCount;
      group.directCount = directCount;
      group.eligibleCount = eligibleCount;
      group.nonIndirectCount = nonIndirectCount;
    }

    // Sort groups by member count descending; filter out groups with 0 members.
    // Priority: Direct > Eligible > Indirect-only
    const groups = [...groupMap.values()]
      .filter(g => g.memberCount > 0)
      .sort((a, b) => {
        // Direct members first
        const directCmp = (b.directCount || 0) - (a.directCount || 0);
        if (directCmp !== 0) return directCmp;
        // Then eligible
        const eligibleCmp = (b.eligibleCount || 0) - (a.eligibleCount || 0);
        if (eligibleCmp !== 0) return eligibleCmp;
        // Then total member count (indirect as tiebreaker)
        return b.memberCount - a.memberCount;
      });

    return { users, groups, memberships: membershipMap, managedMap: managed };
  }, [filteredData, groupTagMap, sortAttrs, hierActive, hierDepth, hierPaths]);

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
  const { accessPackages, apGroupMap } = useMemo(() => {
    if (!accessPackageGroups || accessPackageGroups.length === 0) {
      return { accessPackages: [], apGroupMap: new Map() };
    }
    const visibleGroupIds = new Set(groups.map(g => (g.realGroupId || g.id).toUpperCase()));
    const visibleUserIds = new Set(users.map(u => u.id.toLowerCase()));
    const { apMap, mapping } = buildApMapping(accessPackageGroups, visibleGroupIds);

    // Filter to APs that have at least one visible user assignment
    const apIdsWithAssignments = new Set();
    for (const [cellKey, apIds] of managedApMap) {
      const [gid, uid] = cellKey.split('|');
      if (visibleGroupIds.has(gid.toUpperCase()) && visibleUserIds.has(uid)) {
        for (const apId of apIds) {
          apIdsWithAssignments.add(apId);
        }
      }
    }
    for (const apId of [...apMap.keys()]) {
      if (!apIdsWithAssignments.has(apId.toLowerCase())) {
        apMap.delete(apId);
      }
    }

    return { accessPackages: [...apMap.values()].sort(compareAccessPackages), apGroupMap: mapping };
  }, [accessPackageGroups, groups, users, managedApMap]);

  // AP ID (lowercase) -> sorted index (for consistent color lookup)
  const apIdToIndex = useMemo(() => {
    const map = new Map();
    accessPackages.forEach((ap, idx) => map.set(ap.id.toLowerCase(), idx));
    return map;
  }, [accessPackages]);

  // Default sort: AP staircase pattern.
  // All groups in the leftmost AP first, then next AP, etc. Unmanaged at the bottom.
  const apSortedGroups = useMemo(() => {
    // Non-governed view hides the AP columns, so the AP-staircase ordering is
    // meaningless there — fall back to the member-count sort already applied to
    // `groups` (Direct count desc, then Eligible, Owner, total).
    if (managedFilter === 'unmanaged') return groups;
    if (accessPackages.length === 0) return groups; // no APs, keep member count sort

    // Assign each group to the AP bucket of its leftmost AP column. A business
    // role's OWN row is promoted into its own bucket so it sits directly above
    // the resources it grants — folding is only coherent when a parent row is
    // adjacent to the children it hides.
    const groupApBucket = new Map();
    const roleRowIds = new Set();
    for (const g of groups) {
      const selfBucket = g.realGroupId ? undefined : apIdToIndex.get(g.id.toLowerCase());
      if (selfBucket != null) roleRowIds.add(g.id);
      groupApBucket.set(g.id, selfBucket ?? leftmostApBucket(g, accessPackages, apGroupMap));
    }

    return [...groups].sort((a, b) => {
      const aBucket = groupApBucket.get(a.id);
      const bBucket = groupApBucket.get(b.id);
      if (aBucket !== bBucket) return aBucket - bBucket;
      // Same bucket: the business role row itself comes first, above its resources
      const aRole = roleRowIds.has(a.id);
      if (aRole !== roleRowIds.has(b.id)) return aRole ? -1 : 1;
      // Then by type priority (Direct > Eligible > Indirect)
      const directCmp = (b.directCount || 0) - (a.directCount || 0);
      if (directCmp !== 0) return directCmp;
      const eligibleCmp = (b.eligibleCount || 0) - (a.eligibleCount || 0);
      if (eligibleCmp !== 0) return eligibleCmp;
      return b.memberCount - a.memberCount;
    });
  }, [groups, accessPackages, apGroupMap, apIdToIndex, managedFilter]);

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

  const displayGroups = useMemo(() => {
    if (expandedGroups.size === 0) return orderedGroups;
    const result = [];

    const addGroupWithNested = (group, level) => {
      result.push(group);
      if (level >= MAX_NEST_LEVEL) return;
      const realGid = group.realGroupId || group.id;
      if (!expandedGroups.has(realGid) || !nestedDataCache.has(realGid)) return;

      for (const ng of nestedDataCache.get(realGid).groups) {
        const syntheticId = `${realGid}__nested__${ng.groupId}`;
        let memberCount = 0;
        let nonIndirectCount = 0;
        for (const u of users) {
          const types = nestedMemberships.get(`${syntheticId}|${u.id}`);
          if (types && types.size > 0) {
            memberCount++;
            for (const t of types) {
              if (t !== 'Indirect') { nonIndirectCount++; break; }
            }
          }
        }
        const nestedGroup = {
          id: syntheticId,
          realGroupId: ng.resourceId || ng.groupId,
          displayName: ng.displayName || ng.resourceId || ng.groupId,
          groupType: ng.resourceType || ng.groupTypeCalculated || '',
          description: ng.description || '',
          systemName: ng.systemName || '',
          tags: [],
          isNestedRow: true,
          nestLevel: level + 1,
          parentGroupId: realGid,
          memberCount,
          nonIndirectCount,
        };
        // Recurse: nested groups can themselves be expanded
        addGroupWithNested(nestedGroup, level + 1);
      }
    };

    for (const group of orderedGroups) {
      addGroupWithNested(group, 0);
    }
    return result;
  }, [orderedGroups, expandedGroups, nestedDataCache, nestedMemberships, users]);

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

      // A row is a gap row when some subject is short of what a role covering
      // this cell assigns — the same comparison the cell markers use, so the
      // Gaps view and the amber "!" can never disagree.
      const groupApIdSetLower = new Set(groupAps.map(ap => ap.id.toLowerCase()));
      return users.some(user => {
        const cellKeyLower = `${realGid.toLowerCase()}|${user.id.toLowerCase()}`;
        const apIds = (managedApMap?.get(cellKeyLower) || []).filter(id => groupApIdSetLower.has(id));
        const types = displayMemberships.get(`${group.id}|${user.id}`);
        return cellDeviation({ types, apIds, apGroupMap, resourceKey: lookupGid }).missing.length > 0;
      });
    });
  }, [displayGroups, managedFilter, accessPackages, apGroupMap, users, managedApMap, displayMemberships]);

  // ─── Business-role fold ─────────────────────────────────────────
  // Folding a business role hides the rows of the resources it grants, so the
  // grid can be reduced to "business roles + resources no role covers". Applied
  // last in the row pipeline, so it composes with the All/Governed/Non-governed/
  // Gaps toggles and with the injected nested sub-rows.
  const {
    visibleRows: foldedGroups, foldedChildRows,
    foldableRoles, foldedRoles, roleFoldInfo,
    toggleRoleFold, foldAllRoles, unfoldAllRoles, canFoldRoles, hasFoldedRoles,
  } = useBusinessRoleFold({ accessPackageGroups, rows: visibleGroups, storageKey });

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
  const { cols: colUsers, userToAgg } = useMemo(() => {
    const collapsed = collapsedGroups;
    const nAttr = sortAttrs.length;
    const out = [];
    const userToAgg = new Map();
    const emitted = new Set();
    for (const u of users) {
      // Shallowest collapsed level whose sort-key prefix covers this user.
      let lvl = -1;
      for (let L = 0; L < nAttr; L++) {
        if (collapsed.has(collapseKey(u.sortKeys, L))) { lvl = L; break; }
      }
      if (lvl >= 0) {
        const key = collapseKey(u.sortKeys, lvl);
        if (!emitted.has(key)) {
          emitted.add(key);
          const members = users.filter(x => collapseKey(x.sortKeys, lvl) === key);
          // Member-expanded: show the individual subjects at this level instead
          // of one aggregate. Truncate their sort-keys to this level so they sit
          // under the current org header and don't sprout deeper org rows.
          const memMode = memberExpanded.get(key);
          if (memMode) {
            const picked = memMode === 'direct'
              ? members.filter(m => !(m.sortKeys?.[lvl + 1])) // path ends here
              : members;
            for (const m of picked) {
              const sk = [];
              for (let i = 0; i < nAttr; i++) sk[i] = i <= lvl ? (m.sortKeys?.[i] ?? '') : '';
              out.push({ ...m, sortKeys: sk, isMemberCol: true, aggKey: key, memberLevel: lvl });
              if (m.memberType === 'Identity' && expandedIdentities.has(m.id)) {
                const cache = accountMatrixCache.get(m.id);
                for (const acc of (cache?.accounts || [])) out.push(makeAccountCol(m, acc, sk));
              }
            }
            continue;
          }
          const aggId = `agg ${key}`;
          // Distinct child-value count for each level below the collapse level.
          const childCounts = {};
          for (let i = lvl + 1; i < nAttr; i++) {
            childCounts[i] = new Set(members.map(m => (m.sortKeys?.[i] ?? ''))).size;
          }
          // sortKeys: real values up to the collapse level; a unique sentinel
          // below so the merged header spans never fuse two aggregate columns.
          const sk = [];
          for (let i = 0; i < nAttr; i++) sk[i] = i <= lvl ? (u.sortKeys?.[i] ?? '') : `${AGG_SENTINEL}${aggId} ${i}`;
          out.push({
            id: aggId, isAggregateCol: true, level: lvl,
            value: u.sortKeys?.[lvl] ?? '', childCounts, userCount: members.length,
            sortKeys: sk, memberType: 'Aggregate', displayName: u.sortKeys?.[lvl] || '(none)',
          });
          for (const m of members) userToAgg.set(m.id, aggId);
        }
        continue; // individual user (and its account expansion) is folded away
      }
      out.push(u);
      if (u.memberType === 'Identity' && expandedIdentities.has(u.id)) {
        const cache = accountMatrixCache.get(u.id);
        for (const acc of (cache?.accounts || [])) out.push(makeAccountCol(u, acc, u.sortKeys));
      }
    }
    return { cols: out, userToAgg };
  }, [users, collapsedGroups, memberExpanded, sortAttrs, expandedIdentities, accountMatrixCache]);

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

  // Per (folded role, subject column): how the rows a role folded away deviate
  // from what the role assigns — more than it grants (red) and fewer (amber).
  // Folding a role otherwise hides exactly what a role-mining review is looking
  // for, in both directions, so the folded row keeps both counts. Coverage comes
  // from managedApMap (the server's business-role → cell mapping), never from a
  // client-side guess at what a role ought to grant.
  const roleDeviations = useMemo(() => buildRoleDeviationCounts({
    foldedChildRows, users, memberships: colMemberships, managedApMap, apGroupMap, userToAgg,
  }) || NO_ROLE_DEVIATIONS, [foldedChildRows, users, colMemberships, managedApMap, apGroupMap, userToAgg]);

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
    const key = collapseKey(sortKeys, level);
    const nAttr = sortAttrs.length;
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        if (level + 1 < nAttr) {
          for (const u of users) {
            if (collapseKey(u.sortKeys, level) === key) next.add(collapseKey(u.sortKeys, level + 1));
          }
        }
      } else {
        next.add(key);
        for (const u of users) {
          if (collapseKey(u.sortKeys, level) !== key) continue;
          for (let L = level + 1; L < nAttr; L++) next.delete(collapseKey(u.sortKeys, L));
        }
      }
      return next;
    });
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
  // never the page too — until the analyst drags the grip below the grid to a
  // height of their own, which then wins and is remembered.
  const rootRef = useRef(null);
  const gridHeight = useResizableGridHeight(scrollRef, [filterIsApplied, users.length]);
  const gridMaxH = gridHeight.height;

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
        canFoldRoles={canFoldRoles}
        hasFoldedRoles={hasFoldedRoles}
        onFoldAllRoles={foldAllRoles}
        onUnfoldAllRoles={unfoldAllRoles}
      />

      {filterIsApplied && <MatrixLegend />}

      {!filterIsApplied ? (
        <EmptyFilterState onAdjustFilter={onAdjustFilter} hasData={hasData} />
      ) : users.length === 0 || orderedGroups.length === 0 ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">
          No assignments match the current filter. Adjust the subjects or resources to widen the view.
        </div>
      ) : (
        <>
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
              orderedGroups={foldedGroups}
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
              foldableRoles={foldableRoles}
              foldedRoles={foldedRoles}
              roleFoldInfo={roleFoldInfo}
              roleExtraCounts={roleDeviations.extra}
              roleMissingCounts={roleDeviations.missing}
              onToggleRoleFold={toggleRoleFold}
            />
          ) : (
            <table className="border-collapse" style={{ tableLayout: 'fixed' }}>
              {columnHeaders}
              <tbody>
                {foldedGroups.map(group => (
                  <MatrixGroupRow
                    key={group.rowKey || group.id}
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
                    foldableRoles={foldableRoles}
                    foldedRoles={foldedRoles}
                    roleFoldInfo={roleFoldInfo}
                    roleExtraCounts={roleDeviations.extra}
                    roleMissingCounts={roleDeviations.missing}
                    onToggleRoleFold={toggleRoleFold}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
        <GridResizeHandle
          isCustom={gridHeight.isCustom}
          onStartDrag={gridHeight.startDrag}
          onResizeBy={gridHeight.resizeBy}
          onReset={gridHeight.reset}
        />
        </>
      )}
      {pathExplain && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setPathExplain(null)}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full mx-4 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                How this inherited access arose
              </h3>
              <button
                onClick={() => setPathExplain(null)}
                className="text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none"
                aria-label="Close"
              >×</button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-3">
              <strong>{pathExplain.memberName}</strong> reaches <strong>{pathExplain.resourceName}</strong> through a
              grant higher in the scope hierarchy:
            </p>
            {pathExplain.loading && <p className="text-sm text-gray-500">Computing path…</p>}
            {pathExplain.error && <p className="text-sm text-red-600">{pathExplain.error}</p>}
            {pathExplain.sources?.length > 0 && (
              <div className="mb-3 text-sm rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2">
                <span className="font-medium text-amber-800 dark:text-amber-300">Granted: </span>
                {pathExplain.sources.map((s, i) => (
                  <span key={i}>{i > 0 ? ', ' : ''}{s.role} on {s.label}:<strong> {s.name}</strong></span>
                ))}
              </div>
            )}
            {pathExplain.chain?.length > 0 && (
              <ol className="space-y-1">
                {pathExplain.chain.map((c, i) => (
                  <li key={c.id} className="flex items-center gap-2 text-sm" style={{ paddingLeft: `${i * 18}px` }}>
                    <span className="text-gray-500 dark:text-gray-500">{i === 0 ? '•' : '└'}</span>
                    <span className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">{c.label}</span>
                    <span className={c.isSource ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}>{c.name}</span>
                    {c.isSource && <span className="text-[10px] text-amber-600 dark:text-amber-400">← granted here</span>}
                  </li>
                ))}
              </ol>
            )}
            {!pathExplain.loading && !pathExplain.error && !(pathExplain.sources?.length) && (
              <p className="text-sm text-gray-500">No scope-inheritance path found — this may be a directly-declared indirect grant.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

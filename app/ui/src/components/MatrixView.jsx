import { useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthGate';
import { useMatrixRowOrder } from '../hooks/useMatrixRowOrder';
import MatrixToolbar from './matrix/MatrixToolbar';
import MatrixLegend from './matrix/MatrixLegend';
import MatrixFilterSummary from './matrix/MatrixFilterSummary';
import MatrixScopePanel from './matrix/MatrixScopePanel';
import MatrixColumnHeaders from './matrix/MatrixColumnHeaders';
import { makeUserComparator, buildSortKeys } from './matrix/sortUsers';
import MatrixGroupRow from './matrix/MatrixGroupRow';

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
  const [groupsWithNested, setGroupsWithNested] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [nestedDataCache, setNestedDataCache] = useState(new Map());
  const [loadingNested, setLoadingNested] = useState(new Set());

  // ─── Identity column expansion (show per-account sub-columns) ────
  const [expandedIdentities, setExpandedIdentities] = useState(new Set());
  const [accountMatrixCache, setAccountMatrixCache] = useState(new Map()); // identityId → { accounts, memberships: Map }
  const [loadingIdentityCols, setLoadingIdentityCols] = useState(new Set());

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

  // Fetch which groups have nested groups (once on mount)
  useEffect(() => {
    let cancelled = false;
    authFetch('/api/groups-with-nested')
      .then(r => r.ok ? r.json() : { groupIds: [] })
      .then(d => { if (!cancelled) setGroupsWithNested(new Set(d.groupIds || [])); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authFetch]);

  const MAX_NEST_LEVEL = 4;

  const toggleExpand = useCallback(async (groupId) => {
    if (expandedGroups.has(groupId)) {
      setExpandedGroups(prev => { const next = new Set(prev); next.delete(groupId); return next; });
      return;
    }
    if (!nestedDataCache.has(groupId)) {
      setLoadingNested(prev => new Set(prev).add(groupId));
      try {
        const res = await authFetch(`/api/group/${encodeURIComponent(groupId)}/nested-groups`);
        const data = await res.json();
        setNestedDataCache(prev => new Map(prev).set(groupId, data));
      } catch (err) {
        console.error('Failed to load nested groups:', err);
        setLoadingNested(prev => { const next = new Set(prev); next.delete(groupId); return next; });
        return;
      }
      setLoadingNested(prev => { const next = new Set(prev); next.delete(groupId); return next; });
    }
    setExpandedGroups(prev => new Set(prev).add(groupId));
  }, [expandedGroups, nestedDataCache, authFetch]);

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
  const sortAttrs = useMemo(
    () => (filter?.sortAttributes?.length ? filter.sortAttributes : [{ attribute: 'department', dir: 'asc' }]),
    [filter],
  );

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
        u.sortKeys = buildSortKeys(d, sortAttrs);
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

      // Owner memberships go to a separate synthetic group row
      const isOwner = d.membershipType === 'Owner';
      if (isOwner && gid) {
        const ownerGroupId = `${gid}__owner`;
        if (!groupMap.has(ownerGroupId)) {
          const name = d.resourceDisplayName || d.groupDisplayName || gid;
          const tags = groupTagMap?.get(gid.toUpperCase()) || [];
          groupMap.set(ownerGroupId, {
            id: ownerGroupId,
            realGroupId: gid,
            displayName: `${name} (Owner)`,
            tags,
            description: d.resourceDescription || d.groupDescription || '',
            groupType: d.resourceType || d.groupTypeCalculated || '',
            systemName: d.systemName || '',
          });
        }
      }

      // Memberships: Owner -> synthetic owner group, others -> real group
      const effectiveGroupId = isOwner ? `${gid}__owner` : gid;
      const key = `${effectiveGroupId}|${d.memberId}`;
      if (!membershipMap.has(key)) {
        membershipMap.set(key, new Set());
      }
      membershipMap.get(key).add(d.membershipType);

      // Track managedByAccessPackage per cell (boolean from view, used for filtering)
      // Owner rows are NOT managed by APs — the managedByAccessPackage flag from the
      // SQL view checks AP→Direct membership, which doesn't apply to Owner relationships.
      if (d.managedByAccessPackage && !isOwner) {
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
      let memberCount = 0, directCount = 0, eligibleCount = 0, ownerCount = 0, nonIndirectCount = 0;
      for (const u of userList) {
        const types = membershipMap.get(`${group.id}|${u.id}`);
        if (!types || types.size === 0) continue;
        memberCount++;
        if (types.has('Direct'))   directCount++;
        if (types.has('Eligible')) eligibleCount++;
        if (types.has('Owner'))    ownerCount++;
        for (const t of types) { if (t !== 'Indirect') { nonIndirectCount++; break; } }
      }
      group.memberCount = memberCount;
      group.directCount = directCount;
      group.eligibleCount = eligibleCount;
      group.ownerCount = ownerCount;
      group.nonIndirectCount = nonIndirectCount;
    }

    // Sort groups by member count descending; filter out groups with 0 members
    // (e.g., a base group with only Owner memberships will have 0 members since
    // those went to the __owner synthetic row)
    // Priority: Direct > Eligible > Owner > Indirect-only
    const groups = [...groupMap.values()]
      .filter(g => g.memberCount > 0)
      .sort((a, b) => {
        // Direct members first
        const directCmp = (b.directCount || 0) - (a.directCount || 0);
        if (directCmp !== 0) return directCmp;
        // Then eligible
        const eligibleCmp = (b.eligibleCount || 0) - (a.eligibleCount || 0);
        if (eligibleCmp !== 0) return eligibleCmp;
        // Then owner
        const ownerCmp = (b.ownerCount || 0) - (a.ownerCount || 0);
        if (ownerCmp !== 0) return ownerCmp;
        // Then total member count (indirect as tiebreaker)
        return b.memberCount - a.memberCount;
      });

    return { users, groups, memberships: membershipMap, managedMap: managed };
  }, [filteredData, groupTagMap, sortAttrs]);

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
    const apMap = new Map();
    const mapping = new Map(); // "groupId|apId" -> roleName

    for (const row of accessPackageGroups) {
      const gid = (row.resourceId || row.groupId)?.toUpperCase();
      if (!gid || !visibleGroupIds.has(gid)) continue;
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
      mapping.set(`${gid}|${row.accessPackageId.toLowerCase()}`, row.roleName || 'Member');
    }

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

    // Sort access packages: by category name first, then by total assignments
    // descending within each category. Uncategorized APs go at the end.
    const accessPackages = [...apMap.values()].sort((a, b) => {
      const aCat = a.categoryName;
      const bCat = b.categoryName;
      // Uncategorized after all categorized
      if (aCat && !bCat) return -1;
      if (!aCat && bCat) return 1;
      // Both categorized: sort by category name
      if (aCat && bCat && aCat !== bCat) return aCat.localeCompare(bCat);
      // Same category (or both uncategorized): sort by total assignments descending
      return b.totalAssignments - a.totalAssignments || a.displayName.localeCompare(b.displayName);
    });
    return { accessPackages, apGroupMap: mapping };
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

    // Assign each group to the AP bucket of its leftmost AP column
    const groupApBucket = new Map();
    for (const g of groups) {
      let bucket = accessPackages.length; // unmanaged = after all APs
      const gidUpper = (g.realGroupId || g.id).toUpperCase(); // use realGroupId for owner rows
      const isOwnerRow = !!g.realGroupId;
      for (let i = 0; i < accessPackages.length; i++) {
        const mapKey = `${gidUpper}|${accessPackages[i].id.toLowerCase()}`;
        if (apGroupMap.has(mapKey)) {
          // Owner rows only match AP buckets where the role is Owner
          const role = apGroupMap.get(mapKey);
          const roleIsOwner = (role || '').toLowerCase().includes('owner');
          if (isOwnerRow ? roleIsOwner : !roleIsOwner) {
            bucket = i;
            break;
          }
        }
      }
      groupApBucket.set(g.id, bucket);
    }

    return [...groups].sort((a, b) => {
      const aBucket = groupApBucket.get(a.id);
      const bBucket = groupApBucket.get(b.id);
      if (aBucket !== bBucket) return aBucket - bBucket;
      // Same bucket: sort by type priority (Direct > Eligible > Owner > Indirect)
      const directCmp = (b.directCount || 0) - (a.directCount || 0);
      if (directCmp !== 0) return directCmp;
      const eligibleCmp = (b.eligibleCount || 0) - (a.eligibleCount || 0);
      if (eligibleCmp !== 0) return eligibleCmp;
      const ownerCmp = (b.ownerCount || 0) - (a.ownerCount || 0);
      if (ownerCmp !== 0) return ownerCmp;
      return b.memberCount - a.memberCount;
    });
  }, [groups, accessPackages, apGroupMap, managedFilter]);

  // Apply custom drag-row order on top of the default AP staircase sort. All
  // subject/resource selection happens through the filter wizard, so there
  // are no per-column filters to apply here any more.
  const orderedGroups = useMemo(() => {
    return rowOrderHook.getOrderedGroups(apSortedGroups);
  }, [apSortedGroups, rowOrderHook.getOrderedGroups]);

  const groupIds = useMemo(() => orderedGroups.map(g => g.id), [orderedGroups]);

  const expandAll = useCallback(async () => {
    const newCache = new Map(nestedDataCache);
    const toExpand = new Set();

    // Start with visible groups that have nested groups
    let currentLevel = orderedGroups
      .map(g => g.realGroupId || g.id)
      .filter(id => groupsWithNested.has(id));

    for (let level = 0; level < MAX_NEST_LEVEL && currentLevel.length > 0; level++) {
      // Fetch data for groups not yet cached
      const toFetch = currentLevel.filter(id => !newCache.has(id));
      if (toFetch.length > 0) {
        setLoadingNested(new Set(toFetch));
        const results = await Promise.all(
          toFetch.map(id =>
            authFetch(`/api/group/${encodeURIComponent(id)}/nested-groups`)
              .then(r => r.json())
              .then(data => ({ id, data }))
              .catch(() => ({ id, data: { groups: [], memberships: [] } }))
          )
        );
        for (const { id, data } of results) newCache.set(id, data);
      }

      for (const id of currentLevel) toExpand.add(id);

      // Find next level: nested groups that are themselves expandable
      const nextLevel = [];
      for (const id of currentLevel) {
        const data = newCache.get(id);
        if (data) {
          for (const ng of data.groups) {
            if (groupsWithNested.has(ng.groupId) && !toExpand.has(ng.groupId)) {
              nextLevel.push(ng.groupId);
            }
          }
        }
      }
      currentLevel = nextLevel;
    }

    setNestedDataCache(newCache);
    setExpandedGroups(toExpand);
    setLoadingNested(new Set());
  }, [orderedGroups, groupsWithNested, nestedDataCache, authFetch]);

  const collapseAll = useCallback(() => {
    setExpandedGroups(new Set());
  }, []);

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
    });
  }, [users, orderedGroups, memberships, managedApMap, apIdToIndex, accessPackages, apGroupMap, shareUrl]);

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
  // spliced in after any expanded identity. Analytics above stay keyed on the
  // identity-only `users`; only rendering uses these augmented sets.
  const colUsers = useMemo(() => {
    if (expandedIdentities.size === 0) return users;
    const out = [];
    for (const u of users) {
      out.push(u);
      if (u.memberType === 'Identity' && expandedIdentities.has(u.id)) {
        const cache = accountMatrixCache.get(u.id);
        for (const acc of (cache?.accounts || [])) {
          const accCol = {
            id: acc.id,
            displayName: acc.displayName || acc.id,
            jobTitle: u.jobTitle || '',     // inherit so the merged title header stays contiguous
            department: u.department || '',
            upn: '',
            memberType: 'Principal',
            isAccountCol: true,
            parentId: u.id,
            accountType: acc.accountType || null,
            isPrimary: !!acc.isPrimary,
          };
          // Inherit the parent identity's sort values so the merged attribute
          // header rows stay contiguous across an expanded identity.
          accCol.sortKeys = [...(u.sortKeys || [])];
          out.push(accCol);
        }
      }
    }
    return out;
  }, [users, expandedIdentities, accountMatrixCache, sortAttrs]);

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

  // Shared column headers element (used by both sortable and static table)
  const columnHeaders = (
    <MatrixColumnHeaders
      users={colUsers}
      infoColumnCount={infoColumnCount}
      onSortByCount={handleSortByCount}
      accessPackages={visibleAccessPackages}
      sortAttributes={sortAttrs}
      onOpenDetail={onOpenDetail}
      expandedIdentities={expandedIdentities}
      onToggleIdentity={toggleIdentityColumn}
      loadingIdentityCols={loadingIdentityCols}
    />
  );

  // Ref for the scroll container (needed by virtualizer)
  const scrollRef = useRef(null);

  const filterIsApplied = filter !== null && filter !== undefined;

  // Cap the grid's height to the remaining viewport so ONLY the grid scrolls,
  // never the page too. A fixed max-h-[calc(100vh-280px)] guesses the chrome
  // height; the real chrome (auth banner + scope stats + "How to read") is
  // taller, so the grid sat too low and the page got a second scrollbar.
  // Measure the grid's real document-top instead and re-measure on any layout
  // change (header content loads late, panels toggle).
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
      setGridMaxH(Math.max(240, vh - gridTop - below));
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
              managedMap={managedMap}
              managedApMap={managedApMap}
              apIdToIndex={apIdToIndex}
              accessPackages={visibleAccessPackages}
              apGroupMap={apGroupMap}
              managedFilter={managedFilter}
              onOpenDetail={onOpenDetail}
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
                    managedMap={managedMap}
                    managedApMap={managedApMap}
                    apIdToIndex={apIdToIndex}
                    accessPackages={visibleAccessPackages}
                    apGroupMap={apGroupMap}
                    managedFilter={managedFilter}
                    onOpenDetail={onOpenDetail}
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
    </div>
  );
}

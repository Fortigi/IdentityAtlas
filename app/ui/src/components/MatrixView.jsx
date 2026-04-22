import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthGate';
import { useMatrixRowOrder } from '../hooks/useMatrixRowOrder';
import MatrixToolbar from './matrix/MatrixToolbar';
import MatrixColumnHeaders, { BLANK_TAG } from './matrix/MatrixColumnHeaders';
import MatrixGroupRow from './matrix/MatrixGroupRow';

// Inline arrayMove so MatrixView doesn't depend on @dnd-kit
function arrayMove(arr, from, to) {
  const result = [...arr];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

// Fields to exclude from filter (IDs, display names used as labels, not useful for filtering)
const EXCLUDE_FIELDS = new Set(['groupId', 'resourceId', 'memberId', 'memberDisplayName', 'memberUPN', 'memberType', 'managedByAccessPackage', 'systemId', 'systemName', 'resourceDisplayName', 'groupDisplayName', 'resourceType', 'groupTypeCalculated', 'resourceDescription', 'groupDescription']);
// Friendly labels for known fields
const FIELD_LABELS = {
  // User columns
  department: 'Department',
  jobTitle: 'Job Title',
  companyName: 'Company',
  accountEnabled: 'Account Enabled',
  userType: 'User Type',
  employeeType: 'Employee Type',
  officeLocation: 'Office Location',
  city: 'City',
  country: 'Country',
  state: 'State',
  usageLocation: 'Usage Location',
  mail: 'Mail',
  manager: 'Manager',
  onPremisesSamAccountName: 'SAM Account',
  onPremisesSyncEnabled: 'On-Prem Sync',
  __userTag: 'User Tag',
  // Relationship fields
  membershipType: 'Membership Type',
};

export default function MatrixView({
  data, accessPackageGroups = [], managedByPackages = [], totalUsers: serverTotalUsers,
  userLimit, setUserLimit,
  activeFilters, setActiveFilters,
  managedFilter, setManagedFilter,
  filterText, setFilterText,
  contextFilters, setContextFilters,
  userColumns,
  groupTagMap,
  refreshing,
  shareUrl,
  onOpenDetail,
}) {
  const [groupTypeFilter, setGroupTypeFilter] = useState(null); // null = all, Set = selected types
  const [groupTagFilter, setGroupTagFilter] = useState(null); // null = all, Set = selected tag names
  const [systemNameFilter, setSystemNameFilter] = useState(null); // null = all, Set = selected system names

  // ─── Nested group expansion ─────────────────────────────────────
  const { authFetch } = useAuth();
  const [groupsWithNested, setGroupsWithNested] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [nestedDataCache, setNestedDataCache] = useState(new Map());
  const [loadingNested, setLoadingNested] = useState(new Set());

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

  // Build a stable storage key from all active filters (sorted for consistency)
  const storageKey = useMemo(() => {
    if (activeFilters.length === 0) return '';
    return activeFilters
      .map(f => `${f.field}:${f.value}`)
      .sort()
      .join('|');
  }, [activeFilters]);

  const rowOrderHook = useMatrixRowOrder(storageKey);

  // Sets of column names (for knowing which filters are server-side)
  const userColumnNames = useMemo(() => {
    if (!userColumns) return new Set();
    return new Set(userColumns.map(c => c.column));
  }, [userColumns]);

  // Auto-discover filterable fields from data + merge server-provided user columns.
  // Data-derived fields appear even if not in server columns (e.g., membershipType).
  // Server-provided columns appear even if all values are null in the current page.
  const filterFields = useMemo(() => {
    const fieldMap = new Map(); // key -> { key, label, dataKey }

    // 1. Discover from data (current page)
    if (data && data.length > 0) {
      const sample = data[0];
      for (const key of Object.keys(sample)) {
        if (EXCLUDE_FIELDS.has(key)) continue;
        const values = new Set();
        for (const d of data) {
          const val = d[key];
          if (val != null && val !== '') values.add(String(val));
          if (values.size > 500) break;
        }
        if (values.size >= 1 && values.size <= 500) {
          fieldMap.set(key, {
            key,
            label: FIELD_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim(),
            dataKey: key,
          });
        }
      }
    }

    // 2. Add server-provided user columns that aren't already discovered
    if (userColumns) {
      for (const col of userColumns) {
        if (EXCLUDE_FIELDS.has(col.column)) continue;
        if (!fieldMap.has(col.column) && col.values && col.values.length > 0) {
          fieldMap.set(col.column, {
            key: col.column,
            label: FIELD_LABELS[col.column] || col.column.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim(),
            dataKey: col.column,
          });
        }
      }
    }

    return [...fieldMap.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [data, userColumns]);

  // User filter fields = columns known to the server from GraphUsers table + __userTag.
  // __userTag is always included when the backend supports it, even if no tags exist yet
  // (col.values.length > 0 guard in filterFields step 2 would otherwise drop it).
  const userFilterFields = useMemo(() => {
    const fields = filterFields.filter(f => userColumnNames.has(f.key));
    if (userColumnNames.has('__userTag') && !fields.some(f => f.key === '__userTag')) {
      fields.push({ key: '__userTag', label: 'User Tag', dataKey: '__userTag' });
    }
    return fields;
  }, [filterFields, userColumnNames]);

  // Get available values for a specific field.
  // Server-provided columns: use server values (full dataset, not just current page).
  // Other fields: derive from loaded data with cross-filter logic.
  const getOptionsForField = useCallback((fieldKey) => {
    // For user columns, return server-provided values (from full dataset)
    if (userColumns) {
      const serverCol = userColumns.find(c => c.column === fieldKey);
      if (serverCol && serverCol.values && serverCol.values.length > 0) {
        return serverCol.values;
      }
    }
    // For non-server columns (membershipType, etc.), derive from loaded data
    const field = filterFields.find(f => f.key === fieldKey);
    if (!field) return [];
    // Apply all OTHER active filters first to show contextual values
    let filtered = data;
    for (const af of activeFilters) {
      if (af.field === fieldKey) continue;
      const f = filterFields.find(ff => ff.key === af.field);
      if (f) {
        filtered = filtered.filter(d => String(d[f.dataKey] ?? '') === af.value);
      }
    }
    const values = new Set();
    filtered.forEach(d => {
      const val = d[field.dataKey];
      if (val != null && val !== '') values.add(String(val));
    });
    return [...values].sort();
  }, [data, activeFilters, filterFields, userColumns]);

  const addFilter = useCallback((field, value) => {
    setActiveFilters(prev => [...prev.filter(f => f.field !== field), { field, value }]);
  }, [setActiveFilters]);

  const removeFilter = useCallback((field) => {
    setActiveFilters(prev => prev.filter(f => f.field !== field));
  }, [setActiveFilters]);

  const clearAllFilters = useCallback(() => {
    setActiveFilters([]);
  }, [setActiveFilters]);

  // Apply CLIENT-SIDE filters only (server-side user & group attribute filters already applied by backend).
  // Client-side: text search, managed toggle, non-server-column structured filters (e.g., membershipType).
  const filteredData = useMemo(() => {
    let result = data;
    // Only apply non-server filters client-side
    for (const af of activeFilters) {
      if (userColumnNames.has(af.field)) continue; // already applied server-side
      const field = filterFields.find(f => f.key === af.field);
      if (field) {
        result = result.filter(d => String(d[field.dataKey] ?? '') === af.value);
      }
    }
    if (filterText) {
      const lower = filterText.toLowerCase();
      result = result.filter(d =>
        (d.memberDisplayName || '').toLowerCase().includes(lower) ||
        (d.resourceDisplayName || d.groupDisplayName || '').toLowerCase().includes(lower) ||
        (d.memberUPN || '').toLowerCase().includes(lower)
      );
    }
    if (managedFilter === 'managed') {
      result = result.filter(d => !!d.managedByAccessPackage);
    } else if (managedFilter === 'unmanaged') {
      result = result.filter(d => !d.managedByAccessPackage);
    }
    return result;
  }, [data, activeFilters, filterFields, filterText, managedFilter, userColumnNames]);

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
        userMap.set(d.memberId, {
          id: d.memberId,
          displayName: d.memberDisplayName || d.memberId,
          jobTitle: d.jobTitle || '',
          department: d.department || '',
          upn: d.memberUPN || '',
        });
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

    // Sort users by job title then name
    const users = [...userMap.values()].sort((a, b) => {
      const titleCmp = (a.jobTitle || '').localeCompare(b.jobTitle || '');
      if (titleCmp !== 0) return titleCmp;
      return (a.displayName || '').localeCompare(b.displayName || '');
    });

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
  }, [filteredData, groupTagMap]);

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

  // Unique group types for filter dropdown
  const uniqueGroupTypes = useMemo(() => {
    const types = new Set();
    groups.forEach(g => { if (g.groupType) types.add(g.groupType); });
    return [...types].sort();
  }, [groups]);

  // Unique system names for filter dropdown
  const uniqueSystemNames = useMemo(() => {
    const names = new Set();
    groups.forEach(g => { if (g.systemName) names.add(g.systemName); });
    return [...names].sort();
  }, [groups]);

  // Unique group tags for filter dropdown (derived from groups which already have tags attached)
  const uniqueGroupTags = useMemo(() => {
    const tagMap = new Map(); // name -> { name, color }
    groups.forEach(g => {
      (g.tags || []).forEach(t => {
        if (!tagMap.has(t.name)) tagMap.set(t.name, { name: t.name, color: t.color });
      });
    });
    return [...tagMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [groups]);

  const hasGroupsWithoutTags = useMemo(() => groups.some(g => !g.tags || g.tags.length === 0), [groups]);

  // Default: exclude Distribution and Dynamic group types (user can change)
  const groupTypeDefaultsApplied = useRef(false);
  useEffect(() => {
    if (groupTypeDefaultsApplied.current || uniqueGroupTypes.length === 0) return;
    groupTypeDefaultsApplied.current = true;
    const excluded = /distribution|dynamic/i;
    const defaults = new Set(uniqueGroupTypes.filter(t => !excluded.test(t)));
    if (defaults.size > 0 && defaults.size < uniqueGroupTypes.length) {
      setGroupTypeFilter(defaults);
    }
  }, [uniqueGroupTypes]);

  // Default sort: AP staircase pattern.
  // All groups in the leftmost AP first, then next AP, etc. Unmanaged at the bottom.
  const apSortedGroups = useMemo(() => {
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
  }, [groups, accessPackages, apGroupMap]);

  // Apply custom row order (drag), then filter by group type, tags, and system
  const orderedGroups = useMemo(() => {
    let result = rowOrderHook.getOrderedGroups(apSortedGroups);
    if (groupTypeFilter && groupTypeFilter.size > 0) {
      result = result.filter(g => groupTypeFilter.has(g.groupType));
    }
    if (groupTagFilter && groupTagFilter.size > 0) {
      const wantBlank = groupTagFilter.has(BLANK_TAG);
      result = result.filter(g => {
        const tags = g.tags || [];
        if (tags.length === 0) return wantBlank;
        return tags.some(t => groupTagFilter.has(t.name));
      });
    }
    if (systemNameFilter && systemNameFilter.size > 0) {
      result = result.filter(g => systemNameFilter.has(g.systemName));
    }
    return result;
  }, [apSortedGroups, rowOrderHook.getOrderedGroups, groupTypeFilter, groupTagFilter, systemNameFilter]);

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
      activeFilters,
      filterFields,
      accessPackages,
      apGroupMap,
      shareUrl,
    });
  }, [users, orderedGroups, memberships, managedApMap, apIdToIndex, activeFilters, filterFields, accessPackages, apGroupMap, shareUrl]);

  // Share: copy URL to clipboard
  const handleShare = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      return true;
    } catch {
      return false;
    }
  }, [shareUrl]);

  const stats = {
    users: users.length,
    totalUsers: serverTotalUsers,
    groups: orderedGroups.length,
    memberships: memberships.size,
  };

  // Number of info columns on the left (drag handle + resource name + type)
  const infoColumnCount = 3;

  // Shared column headers element (used by both sortable and static table)
  const columnHeaders = (
    <MatrixColumnHeaders
      users={users}
      infoColumnCount={infoColumnCount}
      onSortByCount={handleSortByCount}
      accessPackages={accessPackages}
      uniqueGroupTypes={uniqueGroupTypes}
      groupTypeFilter={groupTypeFilter}
      onGroupTypeFilterChange={setGroupTypeFilter}
      uniqueGroupTags={uniqueGroupTags}
      groupTagFilter={groupTagFilter}
      onGroupTagFilterChange={setGroupTagFilter}
      hasGroupsWithoutTags={hasGroupsWithoutTags}
      onOpenDetail={onOpenDetail}
    />
  );

  // Ref for the scroll container (needed by virtualizer)
  const scrollRef = useRef(null);

  return (
    <div className="flex flex-col gap-3">
      <MatrixToolbar
        filterFields={filterFields}
        userFilterFields={userFilterFields}
        activeFilters={activeFilters}
        getOptionsForField={getOptionsForField}
        onAddFilter={addFilter}
        onRemoveFilter={removeFilter}
        filterText={filterText}
        setFilterText={setFilterText}
        contextFilters={contextFilters}
        setContextFilters={setContextFilters}
        managedFilter={managedFilter}
        setManagedFilter={setManagedFilter}
        userLimit={userLimit}
        setUserLimit={setUserLimit}
        onExportExcel={handleExportExcel}
        onShare={handleShare}
        onResetRowOrder={rowOrderHook.resetOrder}
        hasCustomRowOrder={rowOrderHook.hasCustomOrder}
        stats={stats}
        hasExpandableGroups={groupsWithNested.size > 0}
        hasExpandedGroups={expandedGroups.size > 0}
        onExpandAll={expandAll}
        onCollapseAll={collapseAll}
      />

      {users.length === 0 || orderedGroups.length === 0 ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-12">
          {activeFilters.length > 0
            ? 'No data found for the current filters. Try removing some filters.'
            : 'No permission data available. Add a filter to narrow down the view.'}
        </div>
      ) : (
        <div ref={scrollRef} className="relative border border-gray-200 dark:border-gray-700 rounded-lg overflow-auto max-h-[calc(100vh-280px)]">
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
              users={users}
              memberships={displayMemberships}
              managedMap={managedMap}
              managedApMap={managedApMap}
              apIdToIndex={apIdToIndex}
              accessPackages={accessPackages}
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
                    users={users}
                    totalUsers={users.length}
                    memberships={displayMemberships}
                    managedMap={managedMap}
                    managedApMap={managedApMap}
                    apIdToIndex={apIdToIndex}
                    accessPackages={accessPackages}
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

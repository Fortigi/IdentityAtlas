// Pure builders for the access-package (SOLL) axis: which APs have a visible
// assignment, the group→AP role mapping, and the AP-staircase row ordering.
// Extracted from MatrixView so the loops are unit-testable and stay under the gate.

import { compareGroupsByPriority } from './matrixModel';

function makeApEntry(row) {
  return {
    id: row.accessPackageId,
    displayName: row.accessPackageName,
    catalogName: row.catalogName,
    totalAssignments: row.totalAssignments || 0,
    categoryName: row.categoryName || null,
    categoryColor: row.categoryColor || null,
  };
}

// Collect AP entries + the "groupId|apId" -> roleName mapping for visible groups.
function collectAccessPackages(accessPackageGroups, visibleGroupIds) {
  const apMap = new Map();
  const mapping = new Map();
  for (const row of accessPackageGroups) {
    const gid = (row.resourceId || row.groupId)?.toUpperCase();
    if (!gid || !visibleGroupIds.has(gid)) continue;
    if (!apMap.has(row.accessPackageId)) apMap.set(row.accessPackageId, makeApEntry(row));
    mapping.set(`${gid}|${row.accessPackageId.toLowerCase()}`, row.roleName || 'Member');
  }
  return { apMap, mapping };
}

// AP ids (lowercase) that at least one visible user actually holds.
function collectAssignedApIds(managedApMap, visibleGroupIds, visibleUserIds) {
  const ids = new Set();
  for (const [cellKey, apIds] of managedApMap) {
    const [gid, uid] = cellKey.split('|');
    if (!visibleGroupIds.has(gid.toUpperCase()) || !visibleUserIds.has(uid)) continue;
    for (const apId of apIds) ids.add(apId);
  }
  return ids;
}

// Drop APs with no visible user assignment.
function pruneUnassignedPackages(apMap, managedApMap, visibleGroupIds, visibleUserIds) {
  const assigned = collectAssignedApIds(managedApMap, visibleGroupIds, visibleUserIds);
  for (const apId of [...apMap.keys()]) {
    if (!assigned.has(apId.toLowerCase())) apMap.delete(apId);
  }
}

// AP order: by category name, then total assignments desc; uncategorized last.
function compareAccessPackages(a, b) {
  const aCat = a.categoryName;
  const bCat = b.categoryName;
  if (aCat && !bCat) return -1;
  if (!aCat && bCat) return 1;
  if (aCat && bCat && aCat !== bCat) return aCat.localeCompare(bCat);
  return b.totalAssignments - a.totalAssignments || a.displayName.localeCompare(b.displayName);
}

// Build { accessPackages, apGroupMap } — only APs where at least one visible user
// actually has an assignment through that AP.
export function buildAccessPackages(accessPackageGroups, groups, users, managedApMap) {
  if (!accessPackageGroups || accessPackageGroups.length === 0) {
    return { accessPackages: [], apGroupMap: new Map() };
  }
  const visibleGroupIds = new Set(groups.map(g => (g.realGroupId || g.id).toUpperCase()));
  const visibleUserIds = new Set(users.map(u => u.id.toLowerCase()));
  const { apMap, mapping } = collectAccessPackages(accessPackageGroups, visibleGroupIds);
  pruneUnassignedPackages(apMap, managedApMap, visibleGroupIds, visibleUserIds);
  const accessPackages = [...apMap.values()].sort(compareAccessPackages);
  return { accessPackages, apGroupMap: mapping };
}

// The AP bucket for one group: index of its leftmost matching AP column, or
// `accessPackages.length` (unmanaged, sorted after all APs). Owner rows only match
// AP buckets whose role is Owner; non-owner rows only match non-Owner roles.
function apBucketFor(g, accessPackages, apGroupMap) {
  const gidUpper = (g.realGroupId || g.id).toUpperCase();
  const isOwnerRow = !!g.realGroupId;
  for (let i = 0; i < accessPackages.length; i++) {
    const mapKey = `${gidUpper}|${accessPackages[i].id.toLowerCase()}`;
    if (!apGroupMap.has(mapKey)) continue;
    const roleIsOwner = (apGroupMap.get(mapKey) || '').toLowerCase().includes('owner');
    if (isOwnerRow ? roleIsOwner : !roleIsOwner) return i;
  }
  return accessPackages.length;
}

// Within a bucket, fall back to membership priority.
function compareByBucket(a, b, buckets) {
  const d = buckets.get(a.id) - buckets.get(b.id);
  return d !== 0 ? d : compareGroupsByPriority(a, b);
}

// Default AP-staircase row order: all groups in the leftmost AP first, then the
// next AP, etc.; unmanaged at the bottom. Falls back to the member-count sort in
// the Non-governed view (APs hidden) or when there are no APs.
export function buildApSortedGroups(groups, accessPackages, apGroupMap, managedFilter) {
  if (managedFilter === 'unmanaged') return groups;
  if (accessPackages.length === 0) return groups;
  const groupApBucket = new Map();
  for (const g of groups) groupApBucket.set(g.id, apBucketFor(g, accessPackages, apGroupMap));
  return [...groups].sort((a, b) => compareByBucket(a, b, groupApBucket));
}

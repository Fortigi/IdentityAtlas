// Pure builder for the core matrix data structures (subjects, resource rows,
// membership map, managed-cell map) out of the flat assignment rows. Extracted
// from MatrixView so the aggregation loops are unit-testable and each stays under
// the complexity gate.

import { contextsFor } from '@ui/utils/resourceContexts';
import { makeUserComparator, buildSortKeys } from './sortUsers';

// Add one subject (deduped by memberId), precomputing its sort-key values.
function addUser(userMap, d, opts) {
  if (!d.memberId || userMap.has(d.memberId)) return;
  const u = {
    id: d.memberId,
    displayName: d.memberDisplayName || d.memberId,
    jobTitle: d.jobTitle || '',
    department: d.department || '',
    upn: d.memberUPN || '',
    memberType: d.memberType || '',
  };
  u.sortKeys = opts.hierActive
    ? Array.from({ length: opts.hierDepth }, (_, i) => (opts.hierPaths.get(d.memberId)?.[i] ?? ''))
    : buildSortKeys(d, opts.sortAttrs);
  userMap.set(d.memberId, u);
}

// Add one resource row (deduped by resource/group id).
function addGroup(groupMap, d, opts) {
  const gid = d.resourceId || d.groupId;
  if (!gid || groupMap.has(gid)) return;
  groupMap.set(gid, {
    id: gid,
    displayName: d.resourceDisplayName || d.groupDisplayName || gid,
    tags: opts.groupTagMap?.get(gid.toUpperCase()) || [],
    contexts: contextsFor(opts.resourceContextMap, gid),
    description: d.resourceDescription || d.groupDescription || '',
    groupType: d.resourceType || d.groupTypeCalculated || '',
    systemName: d.systemName || '',
  });
}

// Record a (resource, member) membership type and the managed-by-AP flag.
function recordMembership(membershipMap, managed, d) {
  const gid = d.resourceId || d.groupId;
  const key = `${gid}|${d.memberId}`;
  if (!membershipMap.has(key)) membershipMap.set(key, new Set());
  membershipMap.get(key).add(d.membershipType);
  if (d.managedByAccessPackage) managed.set(key, true);
}

// True when a membership-type set contains anything other than Indirect.
export function hasNonIndirect(types) {
  for (const t of types) { if (t !== 'Indirect') return true; }
  return false;
}

// Count per-type members for one resource row (drives default sort + % column).
function countGroupMembers(group, membershipMap, userList) {
  let memberCount = 0, directCount = 0, eligibleCount = 0, nonIndirectCount = 0;
  for (const u of userList) {
    const types = membershipMap.get(`${group.id}|${u.id}`);
    if (!types || types.size === 0) continue;
    memberCount++;
    if (types.has('Direct')) directCount++;
    if (types.has('Eligible')) eligibleCount++;
    if (hasNonIndirect(types)) nonIndirectCount++;
  }
  group.memberCount = memberCount;
  group.directCount = directCount;
  group.eligibleCount = eligibleCount;
  group.nonIndirectCount = nonIndirectCount;
}

// Resource-row order: Direct count desc, then Eligible, then total member count.
export function compareGroupsByPriority(a, b) {
  const directCmp = (b.directCount || 0) - (a.directCount || 0);
  if (directCmp !== 0) return directCmp;
  const eligibleCmp = (b.eligibleCount || 0) - (a.eligibleCount || 0);
  if (eligibleCmp !== 0) return eligibleCmp;
  return b.memberCount - a.memberCount;
}

// Count members for every resource row, then keep the non-empty rows sorted by
// membership priority.
function buildGroups(groupMap, membershipMap, userList) {
  for (const group of groupMap.values()) countGroupMembers(group, membershipMap, userList);
  return [...groupMap.values()].filter(g => g.memberCount > 0).sort(compareGroupsByPriority);
}

// Build { users, groups, memberships, managedMap } from the flat assignment rows.
// `opts`: { groupTagMap, resourceContextMap, sortAttrs, hierActive, hierDepth, hierPaths }.
export function buildMatrixModel(filteredData, opts) {
  const userMap = new Map();
  const groupMap = new Map();
  const membershipMap = new Map();
  const managed = new Map();
  for (const d of filteredData) {
    addUser(userMap, d, opts);
    addGroup(groupMap, d, opts);
    recordMembership(membershipMap, managed, d);
  }
  const users = [...userMap.values()].sort(makeUserComparator(opts.sortAttrs));
  const groups = buildGroups(groupMap, membershipMap, [...userMap.values()]);
  return { users, groups, memberships: membershipMap, managedMap: managed };
}

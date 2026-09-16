// Pure builder that injects nested sub-rows after expanded group rows (opening a
// group reveals the resources its members inherit). Extracted from MatrixView so
// the recursion is unit-testable and stays under the complexity gate.

import { MAX_NEST_LEVEL } from '@ui/hooks/useNestedGroupExpand';
import { contextsFor } from '@ui/utils/resourceContexts';
import { hasNonIndirect } from './matrixModel';

// Member + non-indirect counts for one synthetic nested row.
function countNestedMembers(syntheticId, ctx) {
  let memberCount = 0;
  let nonIndirectCount = 0;
  for (const u of ctx.users) {
    const types = ctx.nestedMemberships.get(`${syntheticId}|${u.id}`);
    if (!types || types.size === 0) continue;
    memberCount++;
    if (hasNonIndirect(types)) nonIndirectCount++;
  }
  return { memberCount, nonIndirectCount };
}

// Build the synthetic nested-row group object for a child group `ng`.
function makeNestedGroup(ng, realGid, level, ctx) {
  const syntheticId = `${realGid}__nested__${ng.groupId}`;
  const { memberCount, nonIndirectCount } = countNestedMembers(syntheticId, ctx);
  return {
    id: syntheticId,
    realGroupId: ng.resourceId || ng.groupId,
    displayName: ng.displayName || ng.resourceId || ng.groupId,
    groupType: ng.resourceType || ng.groupTypeCalculated || '',
    description: ng.description || '',
    systemName: ng.systemName || '',
    tags: [],
    contexts: contextsFor(ctx.resourceContextMap, ng.resourceId || ng.groupId),
    isNestedRow: true,
    nestLevel: level + 1,
    parentGroupId: realGid,
    memberCount,
    nonIndirectCount,
  };
}

// Append `group`, then (if expanded and within depth) each of its nested children,
// recursing so nested groups can themselves be expanded.
function addGroupWithNested(result, group, level, ctx) {
  result.push(group);
  if (level >= MAX_NEST_LEVEL) return;
  const realGid = group.realGroupId || group.id;
  if (!ctx.expandedGroups.has(realGid) || !ctx.nestedDataCache.has(realGid)) return;
  for (const ng of ctx.nestedDataCache.get(realGid).groups) {
    addGroupWithNested(result, makeNestedGroup(ng, realGid, level, ctx), level + 1, ctx);
  }
}

// Inject nested sub-rows after every expanded group. Returns `orderedGroups`
// unchanged when nothing is expanded. `ctx`: { expandedGroups, nestedDataCache,
// nestedMemberships, users, resourceContextMap }.
export function buildDisplayGroups(orderedGroups, ctx) {
  if (ctx.expandedGroups.size === 0) return orderedGroups;
  const result = [];
  for (const group of orderedGroups) addGroupWithNested(result, group, 0, ctx);
  return result;
}

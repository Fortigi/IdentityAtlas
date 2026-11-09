// Shared pieces of the adjustment handlers (apply.js, applySplit.js).

import { pickSuccessor } from './detect.js';

export const ok = Object.freeze({ status: 'active', statusDetail: null, suggestion: null });
export const outcome = (status, statusDetail, suggestion = null) => ({ status, statusDetail, suggestion });

// The subject unit is gone from the tree. Propose the unit that now holds most of
// the members it had (a re-keyed or renamed unit), else report it orphaned.
export async function missingSubject(runner, tree, adj) {
  const name = adj.snapshot?.name || 'The unit';
  const memberIds = adj.snapshot?.memberIds || [];
  if (memberIds.length && tree.ids.size) {
    const { rows } = await runner.query(`
      SELECT "contextId", COUNT(*)::int AS count FROM "ContextMembers"
       WHERE "memberId" = ANY($1::uuid[]) AND "contextId" = ANY($2::uuid[])
       GROUP BY "contextId"
    `, [memberIds, [...tree.ids]]);
    const best = pickSuccessor(memberIds.length, rows);
    const unit = best && tree.byId.get(best.contextId);
    if (unit) {
      return outcome('needsDecision',
        `"${name}" is no longer in the source. "${unit.name}" holds ${best.count} of its ${memberIds.length} members, so it is probably the same unit under a new name or key.`,
        { contextId: unit.id, name: unit.name });
    }
  }
  return outcome('orphaned', `"${name}" is no longer in the source.`);
}

// The unit an addUnit or splitUnit brings in, created when it is not there yet.
// An existing one is left where it is: a later moveUnit may have moved it.
export async function ensureUnit(runner, tree, { id, name, parentId, createdBy }) {
  const existing = tree.byId.get(id);
  if (existing) return existing;
  const template = (parentId && tree.byId.get(parentId)) || tree.units.find(u => u.variant !== 'manual') || {};
  const contextType = template.contextType || 'Group';
  await runner.query(`
    INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName",
                            "parentContextId", "scopeSystemId", "createdByUser")
    VALUES ($1, 'manual', $2, $3, $4, $5, $6, $7, $8)
  `, [id, tree.targetType, contextType, tree.contextCategory, name, parentId, tree.systemId, createdBy]);
  const unit = { id, parentId, rawParentId: parentId, name, variant: 'manual', contextType,
    contextCategory: tree.contextCategory, targetType: tree.targetType, memberCount: 0, totalMemberCount: 0 };
  tree.units.push(unit);
  tree.byId.set(id, unit);
  tree.ids.add(id);
  return unit;
}

// Applying adjustments to the stored tree.
//
// Each handler takes the tree as it is NOW (after the latest plugin run or sync),
// makes it say what the adjustment says, and returns the outcome:
//   { status: 'active' | 'needsDecision' | 'orphaned' | 'matches' | 'expired',
//     statusDetail?, suggestion? }
// Handlers are idempotent — applying an adjustment twice changes nothing the
// second time — because they run after every rebuild of the tree.
//
// `runner` is a transaction client (or the db module); `tree` comes from
// loadTree() and is updated in memory as units move or appear, so a later
// adjustment sees what an earlier one did.

import { MEMBER_TABLES, isSelfOrAncestor } from './treeStore.js';
import { ok, outcome, missingSubject, ensureUnit } from './applyCommon.js';
import { applySplit } from './applySplit.js';
import { dateText } from './ops.js';

async function setParent(runner, tree, unit, parentId) {
  if ((unit.rawParentId || null) !== parentId) {
    await runner.query(`UPDATE "Contexts" SET "parentContextId" = $2, "userReparented" = true WHERE id = $1`, [unit.id, parentId]);
  }
  unit.rawParentId = parentId;
  unit.parentId = parentId && tree.ids.has(parentId) ? parentId : null;
}

async function moveUnit(runner, tree, adj) {
  const unit = tree.byId.get(adj.subjectId);
  if (!unit) return missingSubject(runner, tree, adj);
  const to = adj.payload.toParentId || null;
  if (to && !tree.byId.has(to)) return outcome('orphaned', 'The unit it was moved under is no longer in the tree.');
  if (to && isSelfOrAncestor(tree, unit.id, to)) return outcome('orphaned', 'Applying it would put the unit inside itself.');
  await setParent(runner, tree, unit, to);
  return ok;
}

async function renameUnit(runner, tree, adj) {
  const unit = tree.byId.get(adj.subjectId);
  if (!unit) return missingSubject(runner, tree, adj);
  if (unit.name !== adj.payload.name) {
    await runner.query(`UPDATE "Contexts" SET "displayName" = $2, "userRenamed" = true WHERE id = $1`, [unit.id, adj.payload.name]);
    unit.name = adj.payload.name;
  }
  return ok;
}

async function memberStillExists(runner, tree, memberId) {
  const table = MEMBER_TABLES[tree.targetType];
  if (!table) return true;
  const { rows } = await runner.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [memberId]);
  return rows.length > 0;
}

// Rows to drop when moving a member: always its row in the unit it was moved
// from; in a generated tree also the plugin's row wherever the source now puts
// it (one place per person — the adjustment wins, like a manager override).
export function rowsToDrop(rows, { fromUnitId, toUnitId }, treeKind) {
  return rows.filter(r => r.contextId !== toUnitId
    && (r.contextId === fromUnitId || (treeKind === 'generated' && r.addedBy === 'algorithm')));
}

async function moveMember(runner, tree, adj, ctx) {
  const { fromUnitId, toUnitId } = adj.payload;
  if (!tree.byId.has(toUnitId)) return missingSubject(runner, tree, adj);
  if (!(await memberStillExists(runner, tree, adj.memberId))) return outcome('orphaned', 'The member is no longer in the source.');
  const { rows } = await runner.query(`
    SELECT "contextId", "addedBy" FROM "ContextMembers"
     WHERE "memberId" = $1 AND "contextId" = ANY($2::uuid[])
  `, [adj.memberId, [...tree.ids]]);
  const drop = rowsToDrop(rows, adj.payload, tree.kind);
  for (const r of drop) {
    await runner.query(`DELETE FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2`, [r.contextId, adj.memberId]);
    ctx.touched.add(r.contextId);
  }
  const inTarget = rows.filter(r => r.contextId === toUnitId);
  if (inTarget.length === 0) {
    await runner.query(`
      INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
      VALUES ($1, $2, $3, 'analyst') ON CONFLICT ("contextId", "memberId") DO NOTHING
    `, [toUnitId, tree.targetType, adj.memberId]);
    ctx.touched.add(toUnitId);
  }
  if (inTarget.some(r => r.addedBy !== 'analyst') && !rows.some(r => r.contextId === fromUnitId)) {
    return outcome('matches', 'The source now puts this member there too, so this adjustment is no longer needed.');
  }
  return ok;
}

async function addUnit(runner, tree, adj, ctx) {
  const { contextId, name, parentId } = adj.payload;
  const parentOk = !parentId || tree.byId.has(parentId);
  await ensureUnit(runner, tree, { id: contextId, name, parentId: parentOk ? parentId : null, createdBy: adj.createdBy });
  ctx.touched.add(contextId);
  return parentOk ? ok : outcome('orphaned', 'The unit it was added under is no longer in the tree; it now sits at the top level.');
}

async function currentAccountable(runner, contextId) {
  const { rows } = await runner.query(`
    SELECT "principalId", "identityId", "addedBy" FROM "ContextRoles"
     WHERE "contextId" = $1 AND role = 'Accountable'
  `, [contextId]);
  return rows[0] || null;
}

export async function restoreAccountable(runner, contextId, previous) {
  if (!previous || (!previous.principalId && !previous.identityId)) return;
  await runner.query(`
    INSERT INTO "ContextRoles" ("contextId", "principalId", "identityId", role, "addedBy")
    VALUES ($1, $2, $3, 'Accountable', $4) ON CONFLICT DO NOTHING
  `, [contextId, previous.principalId || null, previous.identityId || null, previous.addedBy || 'analyst']);
}

async function setManager(runner, tree, adj, ctx) {
  const unit = tree.byId.get(adj.subjectId);
  if (!unit) return missingSubject(runner, tree, adj);
  const { principalId } = adj.payload;
  const current = await currentAccountable(runner, unit.id);
  const until = dateText(adj.validUntil);
  if (until && until < ctx.today) {
    if (current?.principalId === principalId && current.addedBy === 'analyst') {
      await runner.query(`DELETE FROM "ContextRoles" WHERE "contextId" = $1 AND role = 'Accountable'`, [unit.id]);
      await restoreAccountable(runner, unit.id, adj.before?.accountable);
    }
    return outcome('expired', `Ended on ${until}. The manager from before is back.`);
  }
  if (!(await memberStillExists(runner, { targetType: 'Principal' }, principalId))) return outcome('orphaned', 'The manager is no longer in the source.');
  if (current?.principalId === principalId) return ok;
  await runner.query(`DELETE FROM "ContextRoles" WHERE "contextId" = $1 AND role = 'Accountable'`, [unit.id]);
  await runner.query(`
    INSERT INTO "ContextRoles" ("contextId", "principalId", role, "addedBy") VALUES ($1, $2, 'Accountable', 'analyst')
  `, [unit.id, principalId]);
  return ok;
}

const HANDLERS = { moveUnit, renameUnit, moveMember, addUnit, splitUnit: applySplit, setManager };

export async function applyAdjustment(runner, tree, adj, ctx) {
  const handler = HANDLERS[adj.op];
  if (!handler) return outcome('orphaned', `Unknown adjustment "${adj.op}".`);
  return handler(runner, tree, adj, ctx);
}

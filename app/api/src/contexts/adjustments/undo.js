// Undo: take an adjustment's effect back out of the stored tree.
//
// A generated tree would be restored by its next run anyway, but an imported one
// cannot be rebuilt on demand, so undo puts back what the adjustment replaced
// (its `before`). The remaining adjustments are applied again afterwards by the
// caller, so an undo in the middle of the log keeps everything after it.

import { restoreAccountable } from './apply.js';
import { returnAddedBy } from './applySplit.js';

async function exists(runner, id) {
  if (!id) return false;
  const { rows } = await runner.query(`SELECT 1 FROM "Contexts" WHERE id = $1`, [id]);
  return rows.length > 0;
}

// Move everything hanging under `id` (sub-units and members) to `targetId`,
// then remove the unit. Used for units an adjustment created.
async function dissolveCreated(runner, tree, id, targetId) {
  if (!tree.byId.has(id)) return;
  await runner.query(`UPDATE "Contexts" SET "parentContextId" = $2 WHERE "parentContextId" = $1`, [id, targetId]);
  if (targetId) {
    await runner.query(`
      INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
      SELECT $2, "memberType", "memberId", $3 FROM "ContextMembers" WHERE "contextId" = $1
      ON CONFLICT ("contextId", "memberId") DO NOTHING
    `, [id, targetId, returnAddedBy(tree.kind)]);
  }
  await runner.query(`DELETE FROM "Contexts" WHERE id = $1`, [id]);
}

const UNDO = {
  async moveUnit(runner, tree, adj) {
    if (!tree.byId.has(adj.subjectId)) return;
    const parentId = (await exists(runner, adj.before?.parentId)) ? adj.before.parentId : null;
    await runner.query(`UPDATE "Contexts" SET "parentContextId" = $2, "userReparented" = false WHERE id = $1`, [adj.subjectId, parentId]);
  },
  async renameUnit(runner, tree, adj) {
    if (!tree.byId.has(adj.subjectId) || !adj.before?.name) return;
    await runner.query(`UPDATE "Contexts" SET "displayName" = $2, "userRenamed" = false WHERE id = $1`, [adj.subjectId, adj.before.name]);
  },
  async moveMember(runner, tree, adj) {
    const { fromUnitId, toUnitId } = adj.payload;
    await runner.query(`DELETE FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2 AND "addedBy" = 'analyst'`, [toUnitId, adj.memberId]);
    if (!tree.byId.has(fromUnitId)) return;
    await runner.query(`
      INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
      VALUES ($1, $2, $3, $4) ON CONFLICT ("contextId", "memberId") DO NOTHING
    `, [fromUnitId, tree.targetType, adj.memberId, adj.before?.fromAddedBy || returnAddedBy(tree.kind)]);
  },
  async addUnit(runner, tree, adj) {
    const unit = tree.byId.get(adj.payload.contextId);
    await dissolveCreated(runner, tree, adj.payload.contextId, unit?.rawParentId || null);
  },
  async splitUnit(runner, tree, adj) {
    const parent = tree.byId.has(adj.subjectId) ? adj.subjectId : null;
    await dissolveCreated(runner, tree, adj.payload.contextId, parent);
  },
  async setManager(runner, tree, adj) {
    if (!tree.byId.has(adj.subjectId)) return;
    await runner.query(`
      DELETE FROM "ContextRoles" WHERE "contextId" = $1 AND role = 'Accountable' AND "principalId" = $2 AND "addedBy" = 'analyst'
    `, [adj.subjectId, adj.payload.principalId]);
    await restoreAccountable(runner, adj.subjectId, adj.before?.accountable);
  },
};

export async function undoEffect(runner, tree, adj) {
  const fn = UNDO[adj.op];
  if (fn) await fn(runner, tree, adj);
}

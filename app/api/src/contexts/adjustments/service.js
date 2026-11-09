// Adjust tree: record, undo, redo, follow — and re-apply after every rebuild.
//
// Every write runs in one transaction: the adjustment row and its effect on the
// tree commit together. After any change ALL active adjustments of the tree are
// applied again in order (they are idempotent), so an undo in the middle of the
// log, or a source rebuild, always ends in the same tree.

import { randomUUID } from 'crypto';
import { refreshMemberCounts } from '../memberCounts.js';
import { loadTree } from './treeStore.js';
import { applyAdjustment } from './apply.js';
import { validateAdjustment, AdjustmentInvalid } from './ops.js';
import { undoEffect } from './undo.js';

const SNAPSHOT_MEMBERS = 200;

export const today = () => new Date().toISOString().slice(0, 10);

async function activeAdjustments(runner, treeKey) {
  const { rows } = await runner.query(`
    SELECT * FROM "ContextTreeAdjustments" WHERE "treeKey" = $1 AND status <> 'reverted' ORDER BY seq
  `, [treeKey]);
  return rows;
}

const sameOutcome = (adj, out) => adj.status === out.status
  && (adj.statusDetail || null) === (out.statusDetail || null)
  && JSON.stringify(adj.suggestion || null) === JSON.stringify(out.suggestion || null);

// Apply every active adjustment of the tree to the tree as it is now. Returns
// the number of adjustments applied (0 = nothing to do, nothing touched).
export async function reapplyTree(runner, treeKey) {
  const adjustments = await activeAdjustments(runner, treeKey);
  if (adjustments.length === 0) return 0;
  const tree = await loadTree(runner, treeKey);
  if (!tree) return 0;
  const ctx = { touched: new Set(), today: today() };
  for (const adj of adjustments) {
    const out = await applyAdjustment(runner, tree, adj, ctx);
    if (!sameOutcome(adj, out)) {
      await runner.query(`
        UPDATE "ContextTreeAdjustments"
           SET status = $2, "statusDetail" = $3, suggestion = $4, "updatedAt" = now()
         WHERE id = $1
      `, [adj.id, out.status, out.statusDetail, out.suggestion]);
    }
  }
  await refreshMemberCounts(runner, [...tree.ids]);
  return adjustments.length;
}

// After a sync of a source system: re-apply every tree that system feeds.
export async function reapplyForSystem(runner, systemId) {
  if (systemId == null) return 0;
  const { rows } = await runner.query(`
    SELECT DISTINCT "treeKey" FROM "ContextTreeAdjustments" WHERE "scopeSystemId" = $1 AND status <> 'reverted'
  `, [systemId]);
  let applied = 0;
  for (const r of rows) applied += await reapplyTree(runner, r.treeKey);
  return applied;
}

async function directMemberIds(runner, contextId) {
  if (!contextId) return [];
  const { rows } = await runner.query(`
    SELECT "memberId" FROM "ContextMembers" WHERE "contextId" = $1 ORDER BY "memberId" LIMIT ${SNAPSHOT_MEMBERS}
  `, [contextId]);
  return rows.map(r => r.memberId);
}

// What the adjustment replaces, so undo can put it back.
async function captureBefore(runner, tree, fields) {
  const subject = fields.subjectId ? tree.byId.get(fields.subjectId) : null;
  switch (fields.op) {
    case 'moveUnit': return { parentId: subject.rawParentId || null };
    case 'renameUnit': return { name: subject.name };
    case 'moveMember': {
      const { rows } = await runner.query(`SELECT "addedBy" FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2`,
        [fields.payload.fromUnitId, fields.memberId]);
      return { fromAddedBy: rows[0]?.addedBy || null };
    }
    case 'setManager': {
      const { rows } = await runner.query(`
        SELECT "principalId", "identityId", "addedBy" FROM "ContextRoles" WHERE "contextId" = $1 AND role = 'Accountable'
      `, [fields.subjectId]);
      return { accountable: rows[0] || null };
    }
    default: return {};
  }
}

// Who the unit is, to recognise it when the source re-keys it.
async function captureSnapshot(runner, tree, fields) {
  const subject = fields.subjectId ? tree.byId.get(fields.subjectId) : null;
  if (!subject) return null;
  return { name: subject.name, memberIds: await directMemberIds(runner, subject.id) };
}

// A split remembers the people it carved out (after its first apply), so a
// renamed value can be recognised later.
async function snapshotSplit(runner, row) {
  const memberIds = await directMemberIds(runner, row.payload.contextId);
  await runner.query(`
    UPDATE "ContextTreeAdjustments" SET snapshot = jsonb_set(COALESCE(snapshot, '{}'::jsonb), '{memberIds}', $2::jsonb) WHERE id = $1
  `, [row.id, JSON.stringify(memberIds)]);
}

export async function createAdjustment(runner, treeKey, body, createdBy) {
  const tree = await loadTree(runner, treeKey);
  if (!tree) throw new AdjustmentInvalid('Tree not found', 404);
  const fields = validateAdjustment(body, tree);
  if (fields.op === 'addUnit' || fields.op === 'splitUnit') fields.payload.contextId = randomUUID();
  const before = await captureBefore(runner, tree, fields);
  const snapshot = await captureSnapshot(runner, tree, fields);
  const { rows } = await runner.query(`
    INSERT INTO "ContextTreeAdjustments"
      ("treeKey", "scopeSystemId", op, "subjectId", "memberId", payload, before, snapshot, reason, "validUntil", "createdBy")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `, [treeKey, tree.systemId, fields.op, fields.subjectId, fields.memberId, fields.payload, before, snapshot,
      fields.reason, fields.validUntil, createdBy]);
  await reapplyTree(runner, treeKey);
  if (fields.op === 'splitUnit' && fields.payload.attribute) await snapshotSplit(runner, rows[0]);
  return getAdjustment(runner, treeKey, rows[0].id);
}

export async function getAdjustment(runner, treeKey, id) {
  const { rows } = await runner.query(`SELECT * FROM "ContextTreeAdjustments" WHERE id = $1 AND "treeKey" = $2`, [id, treeKey]);
  return rows[0] || null;
}

async function mustGet(runner, treeKey, id) {
  const adj = await getAdjustment(runner, treeKey, id);
  if (!adj) throw new AdjustmentInvalid('Adjustment not found', 404);
  return adj;
}

export async function undoAdjustment(runner, treeKey, id) {
  const adj = await mustGet(runner, treeKey, id);
  if (adj.status === 'reverted') throw new AdjustmentInvalid('This adjustment is already undone');
  const tree = await loadTree(runner, treeKey);
  if (tree) await undoEffect(runner, tree, adj);
  await runner.query(`UPDATE "ContextTreeAdjustments" SET status = 'reverted', "updatedAt" = now() WHERE id = $1`, [id]);
  await reapplyTree(runner, treeKey);
  if (tree) await refreshMemberCounts(runner, [...tree.ids]);
  return getAdjustment(runner, treeKey, id);
}

export async function redoAdjustment(runner, treeKey, id) {
  const adj = await mustGet(runner, treeKey, id);
  if (adj.status !== 'reverted') throw new AdjustmentInvalid('Only an undone adjustment can be redone');
  await runner.query(`UPDATE "ContextTreeAdjustments" SET status = 'active', "updatedAt" = now() WHERE id = $1`, [id]);
  await reapplyTree(runner, treeKey);
  return getAdjustment(runner, treeKey, id);
}

// Point a needsDecision adjustment at what it was probably renamed to.
export function followedFields(adj) {
  const s = adj.suggestion || {};
  if (s.value != null) return { subjectId: adj.subjectId, payload: { ...adj.payload, value: s.value } };
  if (!s.contextId) throw new AdjustmentInvalid('This adjustment has nothing to follow');
  const payload = adj.op === 'moveMember' ? { ...adj.payload, toUnitId: s.contextId } : adj.payload;
  return { subjectId: s.contextId, payload };
}

export async function followAdjustment(runner, treeKey, id) {
  const adj = await mustGet(runner, treeKey, id);
  if (adj.status !== 'needsDecision') throw new AdjustmentInvalid('Only an adjustment that needs a decision can be followed');
  const { subjectId, payload } = followedFields(adj);
  // From now on the unit is recognised by what it is after the rename.
  const snapshotId = adj.op === 'moveMember' ? payload.toUnitId : subjectId;
  const name = adj.suggestion?.contextId ? adj.suggestion.name : adj.snapshot?.name;
  const snapshot = { name, memberIds: await directMemberIds(runner, snapshotId) };
  await runner.query(`
    UPDATE "ContextTreeAdjustments" SET "subjectId" = $2, payload = $3, snapshot = $4, suggestion = NULL, "updatedAt" = now() WHERE id = $1
  `, [id, subjectId, payload, snapshot]);
  await reapplyTree(runner, treeKey);
  if (adj.op === 'splitUnit' && payload.attribute) await snapshotSplit(runner, { id, payload });
  return getAdjustment(runner, treeKey, id);
}

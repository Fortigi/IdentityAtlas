// splitUnit: carve some members of a unit out into a sub-unit of their own.
//
// By attribute (accounts only): every member whose attribute has the value —
// re-evaluated on every apply, so a newcomer in that department follows and a
// leaver returns. By picked members: exactly those, as long as they are there.
//
// When an attribute split matches nobody any more, the value was probably
// renamed in the source: the people it split off now share another value. That
// is proposed (needsDecision), never followed silently.

import { getPrincipalColumns } from '../../db/columnCache.js';
import { ok, outcome, missingSubject, ensureUnit } from './applyCommon.js';
import { pickRenamedValue } from './detect.js';

// Where a member that leaves the split unit goes back to, as the source owns it.
export function returnAddedBy(treeKind) {
  if (treeKind === 'generated') return 'algorithm';
  if (treeKind === 'synced') return 'sync';
  return 'analyst';
}

// A whitelisted SQL expression for an account attribute: a real Principals
// column, else a key of extendedAttributes read through a parameter.
export async function attributeSql(attribute, paramIndex) {
  const columns = new Set((await getPrincipalColumns()).map(c => c.name));
  if (columns.has(attribute)) return { sql: `p."${attribute}"`, params: [] };
  return { sql: `p."extendedAttributes" ->> $${paramIndex}`, params: [attribute] };
}

async function pickMembers(runner, adj, poolIds) {
  const { attribute, value, memberIds } = adj.payload;
  if (!attribute) return new Set((memberIds || []).filter(id => poolIds.includes(id)));
  const attr = await attributeSql(attribute, 3);
  const { rows } = await runner.query(
    `SELECT p.id FROM "Principals" p WHERE p.id = ANY($1::uuid[]) AND ${attr.sql} = $2`,
    [poolIds, value, ...attr.params]);
  return new Set(rows.map(r => r.id));
}

async function moveRow(runner, fromId, toId, memberId, memberType, addedBy) {
  await runner.query(`DELETE FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2`, [fromId, memberId]);
  await runner.query(`
    INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
    VALUES ($1, $2, $3, $4) ON CONFLICT ("contextId", "memberId") DO NOTHING
  `, [toId, memberType, memberId, addedBy]);
}

// Bring the split unit's members in line with `picked`.
async function rebalance(runner, tree, { subject, child, pool, picked }) {
  const inSubject = new Set(pool.filter(r => r.contextId === subject.id).map(r => r.memberId));
  for (const r of pool) {
    if (r.contextId === subject.id && picked.has(r.memberId)) {
      await moveRow(runner, subject.id, child.id, r.memberId, tree.targetType, 'analyst');
    } else if (r.contextId === child.id && r.addedBy === 'analyst' && !picked.has(r.memberId) && !inSubject.has(r.memberId)) {
      await moveRow(runner, child.id, subject.id, r.memberId, tree.targetType, returnAddedBy(tree.kind));
    } else if (r.contextId === child.id && r.addedBy === 'analyst' && !picked.has(r.memberId)) {
      await runner.query(`DELETE FROM "ContextMembers" WHERE "contextId" = $1 AND "memberId" = $2`, [child.id, r.memberId]);
    }
  }
}

async function renamedValue(runner, adj, poolIds) {
  const snapshotIds = adj.snapshot?.memberIds || [];
  if (!snapshotIds.length) return null;
  const attr = await attributeSql(adj.payload.attribute, 3);
  const { rows } = await runner.query(`
    SELECT ${attr.sql} AS value, COUNT(*)::int AS count FROM "Principals" p
     WHERE p.id = ANY($1::uuid[]) AND p.id = ANY($2::uuid[]) GROUP BY 1
  `, [snapshotIds, poolIds, ...attr.params]);
  return pickRenamedValue(snapshotIds.length, rows, adj.payload.value);
}

async function nobodyMatches(runner, adj, subject, poolIds) {
  const { attribute, value } = adj.payload;
  const renamed = attribute ? await renamedValue(runner, adj, poolIds) : null;
  if (renamed) {
    return outcome('needsDecision',
      `Nobody in "${subject.name}" has ${attribute} "${value}" any more. ${renamed.count} of the people it split off now have "${renamed.value}", so the value was probably renamed in the source.`,
      { value: renamed.value, name: `${attribute} "${renamed.value}"` });
  }
  return outcome('orphaned', attribute
    ? `Nobody in "${subject.name}" has ${attribute} "${value}" any more.`
    : 'None of the picked members is in the unit any more.');
}

export async function applySplit(runner, tree, adj, ctx) {
  const subject = tree.byId.get(adj.subjectId);
  if (!subject) return missingSubject(runner, tree, adj);
  const { contextId, name } = adj.payload;
  const child = await ensureUnit(runner, tree, { id: contextId, name, parentId: subject.id, createdBy: adj.createdBy });
  const { rows: pool } = await runner.query(`
    SELECT "contextId", "memberId", "addedBy" FROM "ContextMembers" WHERE "contextId" = ANY($1::uuid[])
  `, [[subject.id, child.id]]);
  const poolIds = [...new Set(pool.map(r => r.memberId))];
  const picked = await pickMembers(runner, adj, poolIds);
  await rebalance(runner, tree, { subject, child, pool, picked });
  ctx.touched.add(subject.id);
  ctx.touched.add(child.id);
  if (picked.size === 0) return nobodyMatches(runner, adj, subject, poolIds);
  return ok;
}

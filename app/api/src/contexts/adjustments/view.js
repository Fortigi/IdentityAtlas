// Adjust tree — the read side: the tree with its marks, and the adjustment log.

import { loadTree, CREATING_OPS, MEMBER_TABLES } from './treeStore.js';
import { describeAdjustment, dateText } from './ops.js';
import { treeKeyForContext } from './treeKey.js';

async function allAdjustments(runner, treeKey) {
  const { rows } = await runner.query(`
    SELECT * FROM "ContextTreeAdjustments" WHERE "treeKey" = $1 ORDER BY seq DESC
  `, [treeKey]);
  return rows;
}

async function namesById(runner, table, ids) {
  if (!table || ids.length === 0) return new Map();
  const { rows } = await runner.query(`SELECT id, "displayName" AS name FROM "${table}" WHERE id = ANY($1::uuid[])`, [ids]);
  return new Map(rows.map(r => [r.id, r.name]));
}

// The template as people say it: "LogicalApplication" → "Logical applications".
export function templateLabel(category) {
  const words = String(category || 'Units').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const plural = words.endsWith('s') ? words : `${words}s`;
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

async function treeTitle(runner, tree) {
  const top = tree.units.filter(u => !u.parentId);
  if (tree.kind === 'synced') {
    const sys = await runner.query(`SELECT "displayName" FROM "Systems" WHERE id = $1`, [tree.systemId]);
    return `${templateLabel(tree.contextCategory)} · ${sys.rows[0]?.displayName || `System ${tree.systemId}`}`;
  }
  if (top.length === 1) return top[0].name;
  if (tree.kind === 'generated') {
    const algo = await runner.query(`SELECT "displayName" FROM "ContextAlgorithms" WHERE id = $1`, [tree.parsed.algorithmId]);
    return algo.rows[0]?.displayName || 'Generated tree';
  }
  return top[0]?.name || 'Tree';
}

async function treeSource(runner, tree) {
  const sys = tree.systemId == null ? null
    : (await runner.query(`SELECT "displayName" FROM "Systems" WHERE id = $1`, [tree.systemId])).rows[0];
  let algorithmName = null; let lastRunAt = null;
  if (tree.kind === 'generated') {
    const { rows } = await runner.query(`
      SELECT a."displayName" AS name, MAX(r."finishedAt") AS "lastRunAt"
        FROM "ContextAlgorithms" a LEFT JOIN "ContextAlgorithmRuns" r ON r."algorithmId" = a.id AND r.status = 'succeeded'
       WHERE a.id = $1 GROUP BY a."displayName"
    `, [tree.parsed.algorithmId]);
    algorithmName = rows[0]?.name || null; lastRunAt = rows[0]?.lastRunAt || null;
  }
  return { systemId: tree.systemId, systemName: sys?.displayName || null, algorithmName, lastRunAt };
}

async function accountables(runner, ids) {
  if (ids.length === 0) return new Map();
  const { rows } = await runner.query(`
    SELECT r."contextId", r."principalId", COALESCE(p."displayName", i."displayName") AS name
      FROM "ContextRoles" r
      LEFT JOIN "Principals" p ON p.id = r."principalId"
      LEFT JOIN "Identities" i ON i.id = r."identityId"
     WHERE r.role = 'Accountable' AND r."contextId" = ANY($1::uuid[])
  `, [ids]);
  return new Map(rows.map(r => [r.contextId, { principalId: r.principalId, name: r.name }]));
}

// Which units an active adjustment touches, which it created, and which have an
// interim manager. Pure.
export function adjustmentMarks(adjustments, managerNames) {
  const adjusted = new Set(); const created = new Set(); const interim = new Map();
  for (const a of adjustments) {
    if (a.status === 'reverted') continue;
    if (a.subjectId) adjusted.add(a.subjectId);
    if (CREATING_OPS.includes(a.op)) created.add(a.payload.contextId);
    if (a.op === 'moveMember') adjusted.add(a.payload.toUnitId);
    if (a.op === 'setManager' && a.payload.interim && a.status === 'active') {
      interim.set(a.subjectId, { name: managerNames.get(a.payload.principalId) || null, validUntil: dateText(a.validUntil) });
    }
  }
  return { adjusted, created, interim };
}

export async function treeView(runner, treeKey) {
  const tree = await loadTree(runner, treeKey);
  if (!tree) return null;
  const adjustments = await allAdjustments(runner, treeKey);
  const managerIds = adjustments.filter(a => a.op === 'setManager').map(a => a.payload.principalId);
  const managerNames = await namesById(runner, 'Principals', managerIds);
  const marks = adjustmentMarks(adjustments, managerNames);
  const owners = await accountables(runner, [...tree.ids]);
  return {
    treeKey, kind: tree.kind, name: await treeTitle(runner, tree),
    targetType: tree.targetType, contextCategory: tree.contextCategory,
    source: await treeSource(runner, tree),
    units: tree.units.map(u => ({
      id: u.id, parentId: u.parentId, name: u.name, contextType: u.contextType, contextCategory: u.contextCategory,
      variant: u.variant, memberCount: u.memberCount ?? 0, totalMemberCount: u.totalMemberCount ?? 0,
      notPlaced: u.externalId === 'unplaced',
      adjusted: marks.adjusted.has(u.id), createdByAdjustment: marks.created.has(u.id),
      accountable: owners.get(u.id) || null, interim: marks.interim.get(u.id) || null,
    })),
  };
}

export async function adjustmentsView(runner, treeKey) {
  const tree = await loadTree(runner, treeKey);
  if (!tree) return null;
  const rows = await allAdjustments(runner, treeKey);
  const memberNames = await namesById(runner, MEMBER_TABLES[tree.targetType], rows.filter(a => a.memberId).map(a => a.memberId));
  const managerNames = await namesById(runner, 'Principals', rows.filter(a => a.op === 'setManager').map(a => a.payload.principalId));
  const nameOf = (id) => tree.byId.get(id)?.name || null;
  return rows.map(a => ({
    id: a.id, op: a.op, subjectId: a.subjectId, subjectName: nameOf(a.subjectId) || a.snapshot?.name || null,
    memberId: a.memberId, payload: a.payload, reason: a.reason,
    validUntil: dateText(a.validUntil),
    status: a.status, statusDetail: a.statusDetail, suggestion: a.suggestion || null,
    description: describeAdjustment(a, { nameOf, memberName: memberNames.get(a.memberId), managerName: managerNames.get(a.payload?.principalId) }),
    createdBy: a.createdBy, createdAt: a.createdAt,
  }));
}

// GET resolve: which tree a context is in.
export async function resolveTree(runner, contextId) {
  const { rows: made } = await runner.query(`
    SELECT "treeKey" FROM "ContextTreeAdjustments"
     WHERE op = ANY($1::text[]) AND payload->>'contextId' = $2 AND status <> 'reverted' LIMIT 1
  `, [CREATING_OPS, contextId]);
  let treeKey = made[0]?.treeKey;
  if (!treeKey) {
    const { rows } = await runner.query(`
      WITH RECURSIVE up AS (
        SELECT c.*, 0 AS depth FROM "Contexts" c WHERE c.id = $1
        UNION ALL
        SELECT p.*, up.depth + 1 FROM "Contexts" p JOIN up ON p.id = up."parentContextId" WHERE up.depth < 100
      )
      SELECT id, variant, "sourceAlgorithmId", "sourceInstanceKey", "scopeSystemId", "contextCategory", depth FROM up ORDER BY depth
    `, [contextId]);
    if (rows.length === 0) return null;
    treeKey = treeKeyForContext(rows[0], rows[rows.length - 1]);
  }
  const view = await treeView(runner, treeKey);
  if (!view) return null;
  return { treeKey, kind: view.kind, name: view.name, targetType: view.targetType, contextCategory: view.contextCategory, canAdjust: true };
}

// Adjust tree — what needs the analyst: adjustments the source overtook, split
// candidates, and people the tree could not place.

import { loadTree } from './treeStore.js';
import { adjustmentsView } from './view.js';
import { getPrincipalColumns } from '../../db/columnCache.js';

const SPLIT_ATTRIBUTE = 'department';
const SPLIT_MIN_MEMBERS = 2;

const ADJUSTMENT_ITEMS = {
  needsDecision: (a) => ({ kind: 'decision', severity: 'warn', title: `Needs your decision: ${a.description}`,
    action: { type: 'follow', adjustmentId: a.id, label: `Follow to ${a.suggestion?.name || 'the new unit'}` } }),
  orphaned: (a) => ({ kind: 'orphaned', severity: 'bad', title: `No longer applies: ${a.description}`,
    action: { type: 'remove', adjustmentId: a.id, label: 'Remove adjustment' } }),
  matches: (a) => ({ kind: 'matches', severity: 'ok', title: `The source now agrees: ${a.description}`,
    action: { type: 'remove', adjustmentId: a.id, label: 'Remove adjustment' } }),
  expired: (a) => ({ kind: 'expired', severity: 'warn', title: `Ended: ${a.description}`,
    action: { type: 'remove', adjustmentId: a.id, label: 'Remove adjustment' } }),
};

// Pure: one item per adjustment the source overtook.
export function adjustmentItems(adjustments) {
  return adjustments.filter(a => ADJUSTMENT_ITEMS[a.status]).map(a => ({
    id: `adj:${a.id}`, adjustmentId: a.id, unitId: a.subjectId, detail: a.statusDetail || '', ...ADJUSTMENT_ITEMS[a.status](a),
  }));
}

// Pure: a unit whose members mostly share one department but where at least
// SPLIT_MIN_MEMBERS share another — the "manages two teams" and interim cases.
// rows: [{ contextId, value, count }]; splitDone: Set of `${unitId}|${value}`.
export function splitCandidates(rows, tree, splitDone) {
  const byUnit = new Map();
  for (const r of rows) {
    if (!r.value) continue;
    if (!byUnit.has(r.contextId)) byUnit.set(r.contextId, []);
    byUnit.get(r.contextId).push(r);
  }
  const items = [];
  for (const [unitId, values] of byUnit) {
    const unit = tree.byId.get(unitId);
    if (!unit || unit.variant === 'manual') continue;
    const ranked = values.sort((a, b) => b.count - a.count);
    const total = ranked.reduce((s, v) => s + v.count, 0);
    for (const v of ranked.slice(1)) {
      if (v.count < SPLIT_MIN_MEMBERS || splitDone.has(`${unitId}|${v.value}`)) continue;
      items.push({
        id: `split:${unitId}:${v.value}`, kind: 'splitCandidate', severity: 'warn', unitId,
        title: `Split candidate: ${unit.name}`,
        detail: `${v.count} of its ${total} members are in ${SPLIT_ATTRIBUTE} "${v.value}"; most are in "${ranked[0].value}". They may be a separate team, or one managed on an interim basis.`,
        action: { type: 'split', subjectId: unitId, attribute: SPLIT_ATTRIBUTE, value: v.value, label: `Split off ${v.value}` },
        size: v.count,
      });
    }
  }
  return items.sort((a, b) => b.size - a.size).map(({ size, ...item }) => item);
}

async function departmentRows(runner, tree) {
  if (tree.targetType !== 'Principal') return [];
  const columns = new Set((await getPrincipalColumns()).map(c => c.name));
  if (!columns.has(SPLIT_ATTRIBUTE)) return [];
  const { rows } = await runner.query(`
    SELECT cm."contextId", p."${SPLIT_ATTRIBUTE}" AS value, COUNT(*)::int AS count
      FROM "ContextMembers" cm JOIN "Principals" p ON p.id = cm."memberId"
     WHERE cm."contextId" = ANY($1::uuid[])
     GROUP BY 1, 2
  `, [[...tree.ids]]);
  return rows;
}

function notPlacedItems(tree) {
  return tree.units.filter(u => u.externalId === 'unplaced' && (u.memberCount || 0) > 0).map(u => ({
    id: `unplaced:${u.id}`, kind: 'notPlaced', severity: 'warn', unitId: u.id,
    title: `${u.memberCount} not placed`,
    detail: 'No manager, a manager outside the chosen top, or a service or test account. Drag them into a unit, or leave them out.',
    action: { type: 'select', unitId: u.id, label: 'Show them' },
  }));
}

export async function attentionView(runner, treeKey) {
  const tree = await loadTree(runner, treeKey);
  if (!tree) return null;
  const adjustments = await adjustmentsView(runner, treeKey);
  const splitDone = new Set(adjustments
    .filter(a => a.op === 'splitUnit' && a.status !== 'reverted' && a.payload.attribute)
    .map(a => `${a.subjectId}|${a.payload.value}`));
  return [
    ...adjustmentItems(adjustments),
    ...notPlacedItems(tree),
    ...splitCandidates(await departmentRows(runner, tree), tree, splitDone),
  ];
}

// The attribute values among a unit's direct members, to split by.
export async function splitOptions(runner, treeKey, unitId) {
  const tree = await loadTree(runner, treeKey);
  if (!tree || !tree.byId.has(unitId)) return null;
  if (tree.targetType !== 'Principal') return { attributes: [] };
  const columns = new Set((await getPrincipalColumns()).map(c => c.name));
  const attributes = [];
  for (const [attribute, label] of [['department', 'Department'], ['jobTitle', 'Job title'], ['companyName', 'Company'], ['officeLocation', 'Office']]) {
    if (!columns.has(attribute)) continue;
    const { rows } = await runner.query(`
      SELECT p."${attribute}" AS value, COUNT(*)::int AS count
        FROM "ContextMembers" cm JOIN "Principals" p ON p.id = cm."memberId"
       WHERE cm."contextId" = $1 AND p."${attribute}" IS NOT NULL AND p."${attribute}" <> ''
       GROUP BY 1 ORDER BY 2 DESC, 1
    `, [unitId]);
    if (rows.length) attributes.push({ attribute, label, values: rows });
  }
  return { attributes };
}

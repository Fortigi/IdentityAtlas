// Organisation truth — the activity ON one subject: a collection entity (a
// customer) or a resource (GET /org-truth/activity/subject/:targetType/:id).
//
//   {
//     type, types,                       the activity type shown (?type=, else the one with most rows) and all present
//     unit, total, firstOn, lastOn,      over that type's rows (total = sum of measure, dates YYYY-MM-DD)
//     months:  [{ month: '2026-03', total }],                       ascending
//     actors:  [{ targetType, targetId, label, total, lastOn, isMember, memberRoles: ['eigenaar'] }],
//              most first; one per resolved actor (accepted key)
//     unresolvedRows                     rows of that type whose actor key is not accepted
//   }
//
// isMember / memberRoles for a collection entity: its accepted OrgLinks to a
// Principal or Identity, the role being the link's via (eigenaar, team) — a link
// to any record of the same person counts (identity ↔ accounts, family.js). For a
// resource the "members" are the accounts assigned to it, the role being the
// assignment type (Direct, Indirect, Eligible).
import { query } from '../../db/connection.js';
import { resolveLabels } from '../model/entities.js';
import { activityRollupSql, round2, later, earlier } from './sql.js';
import { loadFamily, membershipIndex, keyOf } from './family.js';

export const SUBJECT_TYPES = ['OrgEntity', 'Resource'];

const subjectSql = activityRollupSql(`sk."targetType" = $1 AND sk."targetId" = $2`, { byMonth: true });

const entityMembersSql = `
  SELECT COALESCE("via", 'displayName') AS via, "targetType", "targetId" FROM "OrgLinks"
   WHERE "orgEntityId" = $1 AND "status" = 'accepted' AND "targetType" IN ('Principal', 'Identity')`;

// The resource's assignments held by the actors' accounts (or their siblings').
const resourceMembersSql = `
  SELECT ra."assignmentType" AS via, 'Principal' AS "targetType", ra."principalId" AS "targetId"
    FROM "ResourceAssignments" ra
   WHERE ra."resourceId" = $1
     AND (ra."principalId" = ANY($2::uuid[])
          OR ra."principalId" IN (
               SELECT m."principalId" FROM "IdentityMembers" m
                WHERE m."identityId" = ANY($2::uuid[])
                   OR m."identityId" IN (SELECT x."identityId" FROM "IdentityMembers" x WHERE x."principalId" = ANY($2::uuid[]))))`;

/** Pure: the activity types present, most rows first (then by name). */
export function typesByRows(rows) {
  const n = new Map();
  for (const r of rows) n.set(r.activityType, (n.get(r.activityType) ?? 0) + r.rowCount);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([t]) => t);
}

export function chooseType(rows, requested) {
  const types = typesByRows(rows);
  return { types, type: types.includes(requested) ? requested : (types[0] ?? null) };
}

/** Pure: per resolved actor of `rows`: total and last date. */
export function actorTotals(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!r.actorId) continue;
    const k = keyOf(r.actorType, r.actorId);
    const a = out.get(k) ?? { targetType: r.actorType, targetId: r.actorId, total: 0, lastOn: null };
    a.total += r.total;
    a.lastOn = later(a.lastOn, r.lastOn);
    out.set(k, a);
  }
  return [...out.values()];
}

function monthTotals(rows) {
  const out = new Map();
  for (const r of rows) if (r.month) out.set(r.month, (out.get(r.month) ?? 0) + r.total);
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, total]) => ({ month, total: round2(total) }));
}

function span(rows) {
  let firstOn = null; let lastOn = null; let total = 0; let unresolvedRows = 0;
  for (const r of rows) {
    firstOn = earlier(firstOn, r.firstOn);
    lastOn = later(lastOn, r.lastOn);
    total += r.total;
    if (!r.actorId) unresolvedRows += r.rowCount;
  }
  return { firstOn, lastOn, total: round2(total), unresolvedRows };
}

/** Pure: roll-up rows + membership + labels → the response. */
export function shapeSubject({ rows, requestedType, rolesOf, labels }) {
  const { types, type } = chooseType(rows, requestedType);
  const mine = rows.filter(r => r.activityType === type);
  const { firstOn, lastOn, total, unresolvedRows } = span(mine);
  const actors = actorTotals(mine).map(a => {
    const memberRoles = rolesOf(a.targetType, a.targetId);
    return {
      targetType: a.targetType, targetId: a.targetId, label: labels.get(keyOf(a.targetType, a.targetId))?.label ?? null,
      total: round2(a.total), lastOn: a.lastOn, isMember: memberRoles.length > 0, memberRoles,
    };
  }).sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label)));
  return {
    type, types, unit: mine.find(r => r.unit)?.unit ?? null, total, firstOn, lastOn,
    months: monthTotals(mine), actors, unresolvedRows,
  };
}

async function subjectMembers(targetType, id, actors) {
  if (targetType === 'OrgEntity') return (await query(entityMembersSql, [id])).rows;
  if (actors.length === 0) return [];
  return (await query(resourceMembersSql, [id, actors.map(a => a.targetId)])).rows;
}

export async function getSubjectActivity(targetType, id, { type = null } = {}) {
  const rows = (await query(subjectSql, [targetType, id])).rows;
  const actors = actorTotals(rows);
  const members = await subjectMembers(targetType, id, actors);
  const family = await loadFamily([...actors, ...members]);
  const labels = await resolveLabels(actors);
  return shapeSubject({ rows, requestedType: type, rolesOf: membershipIndex(members, family), labels });
}

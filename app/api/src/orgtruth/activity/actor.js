// Organisation truth — the activity BY one person (GET /org-truth/activity/actor/:targetType/:id).
//
//   { groups: [{ type, unit, unresolvedRows,
//                subjects: [{ targetType, targetId, label, total, lastOn, isMember }] }] }
//
// One group per activity type (most total first inside), the person being the
// account or identity asked for together with its identity ↔ accounts (the same
// widening as linkedTo.js). `unresolvedRows` counts the person's rows of that
// type whose subject key is not accepted. isMember: for a collection entity, an
// accepted OrgLink from it to any of the person's records; for a resource, an
// assignment of it to one of the person's accounts.
import { query } from '../../db/connection.js';
import { targetsOf } from '../model/linkedTo.js';
import { activityRollupSql, round2, later } from './sql.js';
import { keyOf } from './family.js';

export const ACTOR_TYPES = ['Principal', 'Identity'];

const actorSql = activityRollupSql(`ak."targetType" = ANY($1::text[]) AND ak."targetId" = ANY($2::uuid[])`);

const entityMembershipSql = `
  SELECT DISTINCT "orgEntityId" AS id FROM "OrgLinks"
   WHERE "status" = 'accepted' AND "orgEntityId" = ANY($1::uuid[])
     AND "targetType" = ANY($2::text[]) AND "targetId" = ANY($3::uuid[])`;

const resourceMembershipSql = `
  SELECT DISTINCT "resourceId" AS id FROM "ResourceAssignments"
   WHERE "resourceId" = ANY($1::uuid[]) AND "principalId" = ANY($2::uuid[])`;

const idsOf = (rows, subjectType) => [...new Set(rows.filter(r => r.subjectType === subjectType).map(r => r.subjectId))];

// Keys 'Type:id' of the subjects the person is a member of.
async function memberSubjects(rows, pairs) {
  const out = new Set();
  const entityIds = idsOf(rows, 'OrgEntity');
  if (entityIds.length > 0) {
    const r = await query(entityMembershipSql, [entityIds, pairs.map(p => p.targetType), pairs.map(p => p.id)]);
    for (const row of r.rows) out.add(keyOf('OrgEntity', row.id));
  }
  const resourceIds = idsOf(rows, 'Resource');
  const principalIds = pairs.filter(p => p.targetType === 'Principal').map(p => p.id);
  if (resourceIds.length > 0 && principalIds.length > 0) {
    const r = await query(resourceMembershipSql, [resourceIds, principalIds]);
    for (const row of r.rows) out.add(keyOf('Resource', row.id));
  }
  return out;
}

function addSubjectRow(group, r, members) {
  if (!r.subjectId) { group.unresolvedRows += r.rowCount; return; }
  const k = keyOf(r.subjectType, r.subjectId);
  const s = group.subjects.get(k) ?? {
    targetType: r.subjectType, targetId: r.subjectId, label: r.subjectLabel ?? null, total: 0, lastOn: null, isMember: members.has(k),
  };
  s.total += r.total;
  s.lastOn = later(s.lastOn, r.lastOn);
  group.subjects.set(k, s);
}

/** Pure: roll-up rows (any of the person's records) + member subject keys → groups. */
export function shapeActor(rows, members) {
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.activityType) ?? { type: r.activityType, unit: null, unresolvedRows: 0, subjects: new Map() };
    g.unit = g.unit ?? r.unit ?? null;
    addSubjectRow(g, r, members);
    groups.set(r.activityType, g);
  }
  return {
    groups: [...groups.values()]
      .sort((a, b) => String(a.type).localeCompare(String(b.type)))
      .map(g => ({
        ...g,
        subjects: [...g.subjects.values()]
          .map(s => ({ ...s, total: round2(s.total) }))
          .sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label))),
      })),
  };
}

export async function getActorActivity(targetType, id) {
  const pairs = await targetsOf(targetType, id);
  const rows = (await query(actorSql, [pairs.map(p => p.targetType), pairs.map(p => p.id)])).rows;
  return shapeActor(rows, await memberSubjects(rows, pairs));
}

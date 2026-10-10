// Organisation truth — the review queue as DISTINCT decisions.
//
// A timesheet names "Havenbedrijf Rotterdam N.V." on 42 rows; each row has its
// own proposed link to the customer PortOfRotterdam. That is one decision, not
// 42. The queue is therefore grouped on
//   (entityType, via, value, targetType)      value = the linked value (orgValue), else the entity's name
// and one decision applies to every open proposal in the group.
//
//   listReviewGroups({ status, entityType, page }) →
//     { kind: 'groups', status, entityType, page, pageSize, total,
//       rows: [{ entityType, via, value, targetType, entities, bestConfidence,
//                candidates: [{ targetId, label, confidence, entities }] }] }   weakest group first
//   decideGroup({ entityType, via, value, targetType, targetId?, action }, user) →
//     { accepted, rejected }
//       confirmed + targetId: that target's proposals → accepted (override confirmed);
//                             the group's other targets → rejected (override rejected)
//       rejected  + targetId: that target's proposals → rejected (override rejected)
//       rejected, no targetId: every proposal in the group → rejected
// Overrides are what every later run respects (plan.js): a confirmed value stays
// linked, a rejected target is never proposed again for that value.
import { query, tx } from '../../db/connection.js';
import { ReviewError, reviewParams, loadLabels, actorOf, isUuid, PAGE_SIZE } from './review.js';

const GROUP_VALUE = `COALESCE(l."orgValue", e."displayName")`;

const CANDIDATE_ROWS_SQL = `
  SELECT e."entityType", COALESCE(l."via", 'displayName') AS via, ${GROUP_VALUE} AS value, l."targetType", l."targetId",
         MAX(l."confidence")::int AS confidence, COUNT(DISTINCT l."orgEntityId")::int AS entities
    FROM "OrgLinks" l JOIN "OrgEntities" e ON e."id" = l."orgEntityId"
   WHERE l."status" = $1 AND e."validTo" IS NULL AND ($2::text IS NULL OR e."entityType" = $2)
   GROUP BY 1, 2, 3, 4, 5`;

/** Pure: candidate rows → groups, weakest best-candidate first, then most entities. */
export function groupCandidates(rows, labels) {
  const groups = new Map();
  for (const r of rows) {
    const key = [r.entityType, r.via, r.value, r.targetType].join('\u0000');
    const g = groups.get(key) ?? { entityType: r.entityType, via: r.via, value: r.value, targetType: r.targetType, entities: 0, bestConfidence: 0, candidates: [] };
    g.candidates.push({ targetId: r.targetId, label: labels.get(`${r.targetType}|${r.targetId}`) ?? null, confidence: r.confidence, entities: r.entities });
    g.entities = Math.max(g.entities, r.entities);
    g.bestConfidence = Math.max(g.bestConfidence, r.confidence);
    groups.set(key, g);
  }
  for (const g of groups.values()) g.candidates.sort((a, b) => b.confidence - a.confidence || String(a.label).localeCompare(String(b.label)));
  return [...groups.values()].sort((a, b) => a.bestConfidence - b.bestConfidence || b.entities - a.entities || String(a.value).localeCompare(String(b.value)));
}

export async function listReviewGroups(params) {
  const { status, entityType, page, offset } = reviewParams(params);
  const rows = (await query(CANDIDATE_ROWS_SQL, [status, entityType])).rows;
  const labels = await loadLabels(rows);
  const all = groupCandidates(rows, labels);
  return { kind: 'groups', status, entityType, page, pageSize: PAGE_SIZE, total: all.length, rows: all.slice(offset, offset + PAGE_SIZE) };
}

// The open proposals of one group; $1..$4 = entityType, via, value, targetType.
const IN_GROUP = `"id" IN (
  SELECT l."id" FROM "OrgLinks" l JOIN "OrgEntities" e ON e."id" = l."orgEntityId"
   WHERE e."entityType" = $1 AND COALESCE(l."via", 'displayName') = $2 AND ${GROUP_VALUE} = $3 AND l."targetType" = $4
     AND l."status" = 'proposed' AND l."analystOverride" IS NULL)`;
const STAMP = `"overriddenBy" = $5, "overriddenAt" = now() AT TIME ZONE 'utc', "updatedAt" = now() AT TIME ZONE 'utc'`;
const ACCEPT_TARGET_SQL = `UPDATE "OrgLinks" SET "status" = 'accepted', "analystOverride" = 'confirmed', ${STAMP} WHERE ${IN_GROUP} AND "targetId" = $6`;
const REJECT_OTHERS_SQL = `UPDATE "OrgLinks" SET "status" = 'rejected', "analystOverride" = 'rejected', ${STAMP} WHERE ${IN_GROUP} AND "targetId" <> $6`;
const REJECT_TARGET_SQL = `UPDATE "OrgLinks" SET "status" = 'rejected', "analystOverride" = 'rejected', ${STAMP} WHERE ${IN_GROUP} AND "targetId" = $6`;
const REJECT_ALL_SQL = `UPDATE "OrgLinks" SET "status" = 'rejected', "analystOverride" = 'rejected', ${STAMP} WHERE ${IN_GROUP}`;

function readDecision(body) {
  const { entityType, via, value, targetType, targetId, action } = body ?? {};
  for (const [k, v] of Object.entries({ entityType, via, value, targetType })) {
    if (typeof v !== 'string' || v === '') throw new ReviewError(400, `${k} is required.`);
  }
  if (!['confirmed', 'rejected'].includes(action)) throw new ReviewError(400, 'action must be confirmed or rejected.');
  if (targetId !== undefined && !isUuid(targetId)) throw new ReviewError(400, 'targetId must be a UUID.');
  if (action === 'confirmed' && !targetId) throw new ReviewError(400, 'Confirming needs the targetId of the candidate.');
  return { entityType, via, value, targetType, targetId, action };
}

export async function decideGroup(body, user) {
  const d = readDecision(body);
  const base = [d.entityType, d.via, d.value, d.targetType, actorOf(user)];
  return tx(async (client) => {
    const count = (r) => r.rowCount ?? 0;
    if (d.action === 'confirmed') {
      const accepted = count(await client.query(ACCEPT_TARGET_SQL, [...base, d.targetId]));
      if (accepted === 0) throw new ReviewError(404, 'No open proposal for that value and target.');
      const rejected = count(await client.query(REJECT_OTHERS_SQL, [...base, d.targetId]));
      return { accepted, rejected };
    }
    const rejected = count(await client.query(d.targetId ? REJECT_TARGET_SQL : REJECT_ALL_SQL, d.targetId ? [...base, d.targetId] : base));
    if (rejected === 0) throw new ReviewError(404, 'No open proposal for that value.');
    return { accepted: 0, rejected };
  });
}

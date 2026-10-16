// Organisation truth — the review queue and the analyst's decisions on links
// and claims (owned by workstream T2). http/links.js is the thin route layer.
//
//   listReview({ status, entityType, page })  → { kind: 'links', status, entityType, page, pageSize, total, rows }
//     row: { link, entity: { id, entityType, displayName }, target: { targetType, id, label },
//            candidates: [{ id, targetType, targetId, label, confidence, status, analystOverride }] }
//     ordered by confidence asc (the weakest first); candidates = the other links of the same entity
//   listClaims({ status, entityType, page })  → { kind: 'claims', status, page, pageSize,
//                                                 entities: { total, rows }, relations: { total, rows } }
//   overrideLink(id, { action, targetId }, user) → { link, original? }
//   clearOverride(id)                           → link
//   setClaimStatus('entities' | 'relations', id, status) → { id, status }
// Errors are ReviewError with an HTTP status (400 bad input, 404 unknown id).
//
// An override is what every later run respects (plan.js):
//   confirmed → status 'accepted'; the entity is pinned to it
//   rejected  → status 'rejected'; that target is never proposed again
//   moved     → the link to `targetId` (same targetType) becomes accepted with
//               override 'moved' (created when missing, origin 'analyst'), the
//               original is rejected with override 'rejected'
// DECISION (T2): confirming or moving also rejects the entity's other links
// that are still 'proposed' and carry no override — otherwise a resolved tie
// stays in the queue. A later "clear override" does not bring them back; the
// next run re-proposes whatever still scores.
import { randomUUID } from 'node:crypto';
import { query, queryOne, tx } from '../../db/connection.js';
import { CLAIM_STATUSES } from '../contracts.js';
import { TARGET_TABLES } from './candidates.js';

export const PAGE_SIZE = 50;
export const OVERRIDE_ACTIONS = ['confirmed', 'rejected', 'moved'];
export const CLAIM_DECISIONS = ['accepted', 'rejected'];
const CLAIM_TABLES = Object.freeze({ entities: 'OrgEntities', relations: 'OrgRelations' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ReviewError extends Error {
  constructor(httpStatus, message) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** `req.user` → the name stamped on an override (auth may be off). */
export function actorOf(user) {
  return user?.preferred_username ?? user?.oid ?? 'anonymous';
}

/** Validate and default the shared query parameters. */
export function reviewParams({ status, entityType, page } = {}) {
  const s = status ?? 'proposed';
  if (!CLAIM_STATUSES.includes(s)) throw new ReviewError(400, `status must be one of ${CLAIM_STATUSES.join(', ')}.`);
  const p = page === undefined ? 1 : Number(page);
  if (!Number.isInteger(p) || p < 1) throw new ReviewError(400, 'page must be a whole number from 1.');
  const et = typeof entityType === 'string' && entityType.trim() ? entityType.trim() : null;
  return { status: s, entityType: et, page: p, offset: (p - 1) * PAGE_SIZE };
}

// ─── Links queue ────────────────────────────────────────────────────────
const LINK_FILTER = `FROM "OrgLinks" l JOIN "OrgEntities" e ON e."id" = l."orgEntityId"
  WHERE l."status" = $1 AND e."validTo" IS NULL AND ($2::text IS NULL OR e."entityType" = $2)`;

const LINK_PAGE_SQL = `SELECT l."id", l."orgEntityId", l."targetType", l."targetId", l."confidence", l."signals",
    l."matchedField", l."matchedValue", l."origin", l."status", l."analystOverride", l."overriddenBy",
    l."overriddenAt", l."runId", l."updatedAt", e."entityType", e."displayName" AS "entityDisplayName"
  ${LINK_FILTER}
  ORDER BY l."confidence" ASC, l."id" ASC LIMIT $3 OFFSET $4`;

const LINK_COUNT_SQL = `SELECT COUNT(*)::int AS "total" ${LINK_FILTER}`;

const SIBLINGS_SQL = `SELECT "id", "orgEntityId", "targetType", "targetId", "confidence", "status", "analystOverride"
  FROM "OrgLinks" WHERE "orgEntityId" = ANY($1::uuid[]) ORDER BY "confidence" DESC, "id" ASC`;

/** One query per target type: id → displayName. Table names come from TARGET_TABLES only. */
export async function loadLabels(refs) {
  const idsByType = new Map();
  for (const { targetType, targetId } of refs) {
    if (!TARGET_TABLES[targetType]) continue;
    const set = idsByType.get(targetType) ?? new Set();
    set.add(targetId);
    idsByType.set(targetType, set);
  }
  const labels = new Map();
  for (const [targetType, ids] of idsByType) {
    const r = await query(`SELECT "id", "displayName" FROM "${TARGET_TABLES[targetType].table}" WHERE "id" = ANY($1::uuid[])`, [[...ids]]);
    for (const row of r.rows) labels.set(`${targetType}|${row.id}`, row.displayName);
  }
  return labels;
}

const labelOf = (labels, targetType, targetId) => labels.get(`${targetType}|${targetId}`) ?? null;

function shapeRow(l, siblings, labels) {
  const { entityType, entityDisplayName, ...link } = l;
  return {
    link,
    entity: { id: l.orgEntityId, entityType, displayName: entityDisplayName },
    target: { targetType: l.targetType, id: l.targetId, label: labelOf(labels, l.targetType, l.targetId) },
    candidates: siblings
      .filter(s => s.orgEntityId === l.orgEntityId && s.id !== l.id)
      .map(s => ({ ...s, label: labelOf(labels, s.targetType, s.targetId) }))
      .map(({ orgEntityId: _e, ...s }) => s),
  };
}

export async function listReview(params) {
  const { status, entityType, page, offset } = reviewParams(params);
  const links = (await query(LINK_PAGE_SQL, [status, entityType, PAGE_SIZE, offset])).rows;
  const countRes = await query(LINK_COUNT_SQL, [status, entityType]);
  const entityIds = [...new Set(links.map(l => l.orgEntityId))];
  const siblings = entityIds.length > 0 ? (await query(SIBLINGS_SQL, [entityIds])).rows : [];
  const labels = await loadLabels([...links, ...siblings]);
  return {
    kind: 'links', status, entityType, page, pageSize: PAGE_SIZE,
    total: countRes.rows[0]?.total ?? 0,
    rows: links.map(l => shapeRow(l, siblings, labels)),
  };
}

// ─── Claims queue (model output waiting for an analyst) ────────────────
const ENTITY_CLAIMS_FILTER = `FROM "OrgEntities" WHERE "status" = $1 AND "validTo" IS NULL AND ($2::text IS NULL OR "entityType" = $2)`;
const ENTITY_CLAIMS_SQL = `SELECT "id", "entityType", "displayName", "attributes", "origin", "confidence", "sourceId",
    "sourceLocator", "observedAt", "createdBy" ${ENTITY_CLAIMS_FILTER}
  ORDER BY "confidence" ASC NULLS FIRST, "id" ASC LIMIT $3 OFFSET $4`;

const RELATION_CLAIMS_FILTER = `FROM "OrgRelations" r
  JOIN "OrgEntities" f ON f."id" = r."fromEntityId" JOIN "OrgEntities" t ON t."id" = r."toEntityId"
  WHERE r."status" = $1 AND r."validTo" IS NULL AND ($2::text IS NULL OR f."entityType" = $2 OR t."entityType" = $2)`;
const RELATION_CLAIMS_SQL = `SELECT r."id", r."predicate", r."fromEntityId", f."displayName" AS "fromDisplayName",
    r."toEntityId", t."displayName" AS "toDisplayName", r."origin", r."confidence", r."sourceId", r."sourceLocator",
    r."observedAt", r."createdBy" ${RELATION_CLAIMS_FILTER}
  ORDER BY r."confidence" ASC NULLS FIRST, r."id" ASC LIMIT $3 OFFSET $4`;

async function pageOf(listSql, filter, args, offset) {
  const rows = (await query(listSql, [...args, PAGE_SIZE, offset])).rows;
  const total = (await query(`SELECT COUNT(*)::int AS "total" ${filter}`, args)).rows[0]?.total ?? 0;
  return { total, rows };
}

export async function listClaims(params) {
  const { status, entityType, page, offset } = reviewParams(params);
  const args = [status, entityType];
  return {
    kind: 'claims', status, entityType, page, pageSize: PAGE_SIZE,
    entities: await pageOf(ENTITY_CLAIMS_SQL, ENTITY_CLAIMS_FILTER, args, offset),
    relations: await pageOf(RELATION_CLAIMS_SQL, RELATION_CLAIMS_FILTER, args, offset),
  };
}

// ─── Overrides ──────────────────────────────────────────────────────────
const STAMP = `"overriddenBy" = $2, "overriddenAt" = now() AT TIME ZONE 'utc', "updatedAt" = now() AT TIME ZONE 'utc'`;
const SET_OVERRIDE_SQL = `UPDATE "OrgLinks" SET "status" = $3, "analystOverride" = $4, ${STAMP} WHERE "id" = $1 RETURNING *`;
// Only the proposals for the SAME decision (target type, attribute and value):
// confirming a team member must not reject the proposals for the owner.
const REJECT_OPEN_SIBLINGS_SQL = `UPDATE "OrgLinks" SET "status" = 'rejected', "updatedAt" = now() AT TIME ZONE 'utc'
  WHERE "orgEntityId" = $1 AND "id" <> ALL($2::uuid[]) AND "status" = 'proposed' AND "analystOverride" IS NULL
    AND "targetType" = $3 AND "via" IS NOT DISTINCT FROM $4 AND "orgValue" IS NOT DISTINCT FROM $5`;
const MOVE_UPSERT_SQL = `INSERT INTO "OrgLinks"
    ("id", "orgEntityId", "targetType", "targetId", "confidence", "signals", "via", "orgValue", "origin", "status",
     "analystOverride", "overriddenBy", "overriddenAt")
  VALUES ($1, $3, $4, $5, 100, 'analyst', $6, $7, 'analyst', 'accepted', 'moved', $2, now() AT TIME ZONE 'utc')
  ON CONFLICT ("orgEntityId", "targetType", "targetId", (COALESCE("via", ''))) DO UPDATE SET
    "status" = 'accepted', "analystOverride" = 'moved', ${STAMP}
  RETURNING *`;
const siblingParams = (link, keepIds) => [link.orgEntityId, keepIds, link.targetType, link.via ?? null, link.orgValue ?? null];

// The same decision on OTHER entities: the analyst confirmed (or rejected) that
// value V of attribute A means target T — every open proposal with the same
// attribute, value and target takes that decision too (42 timesheet rows naming
// "Havenbedrijf Rotterdam N.V." are confirmed by one click, not 42).
const SAME_DECISION_SQL = `UPDATE "OrgLinks" SET "status" = $5, "analystOverride" = $6, ${STAMP.replace('$2', '$7')}
  WHERE "id" <> $1 AND "status" = 'proposed' AND "analystOverride" IS NULL
    AND "targetType" = $2 AND "targetId" = $3 AND "via" IS NOT DISTINCT FROM $4 AND "orgValue" IS NOT DISTINCT FROM $8
  RETURNING "id", "orgEntityId"`;
async function applyToSameValue(client, link, status, override, actor) {
  if (!link.orgValue) return 0;
  const r = await client.query(SAME_DECISION_SQL, [link.id, link.targetType, link.targetId, link.via ?? null, status, override, actor, link.orgValue]);
  return r.rowCount ?? r.rows.length;
}

async function loadLink(id) {
  if (!isUuid(id)) throw new ReviewError(400, 'The link id must be a UUID.');
  const link = await queryOne('SELECT * FROM "OrgLinks" WHERE "id" = $1', [id]);
  if (!link) throw new ReviewError(404, 'Link not found.');
  return link;
}

async function assertTargetExists(targetType, targetId) {
  const { table } = TARGET_TABLES[targetType];
  const row = await queryOne(`SELECT "id" FROM "${table}" WHERE "id" = $1`, [targetId]);
  if (!row) throw new ReviewError(400, `targetId is not a known ${targetType}.`);
}

async function moveLink(original, targetId, actor) {
  if (!isUuid(targetId)) throw new ReviewError(400, 'Moving a link needs a targetId (a UUID).');
  if (targetId.toLowerCase() === String(original.targetId).toLowerCase()) {
    throw new ReviewError(400, 'targetId is the link\'s current target; confirm the link instead.');
  }
  await assertTargetExists(original.targetType, targetId);
  return tx(async (client) => {
    const moved = (await client.query(MOVE_UPSERT_SQL,
      [randomUUID(), actor, original.orgEntityId, original.targetType, targetId, original.via ?? null, original.orgValue ?? null])).rows[0];
    const rejected = (await client.query(SET_OVERRIDE_SQL, [original.id, actor, 'rejected', 'rejected'])).rows[0];
    await client.query(REJECT_OPEN_SIBLINGS_SQL, siblingParams(original, [moved.id, original.id]));
    return { link: moved, original: rejected };
  });
}

export async function overrideLink(id, { action, targetId } = {}, user = undefined) {
  if (!OVERRIDE_ACTIONS.includes(action)) throw new ReviewError(400, `action must be one of ${OVERRIDE_ACTIONS.join(', ')}.`);
  const original = await loadLink(id);
  const actor = actorOf(user);
  if (action === 'moved') return moveLink(original, targetId, actor);
  if (action === 'rejected') {
    return tx(async (client) => {
      const link = (await client.query(SET_OVERRIDE_SQL, [id, actor, 'rejected', 'rejected'])).rows[0];
      const alsoApplied = await applyToSameValue(client, original, 'rejected', 'rejected', actor);
      return { link, alsoApplied };
    });
  }
  return tx(async (client) => {
    const link = (await client.query(SET_OVERRIDE_SQL, [id, actor, 'accepted', 'confirmed'])).rows[0];
    await client.query(REJECT_OPEN_SIBLINGS_SQL, siblingParams(original, [id]));
    const alsoApplied = await applyToSameValue(client, original, 'accepted', 'confirmed', actor);
    return { link, alsoApplied };
  });
}

export async function clearOverride(id) {
  if (!isUuid(id)) throw new ReviewError(400, 'The link id must be a UUID.');
  const link = await queryOne(
    `UPDATE "OrgLinks" SET "analystOverride" = NULL, "overriddenBy" = NULL, "overriddenAt" = NULL,
       "updatedAt" = now() AT TIME ZONE 'utc' WHERE "id" = $1 RETURNING *`,
    [id],
  );
  if (!link) throw new ReviewError(404, 'Link not found.');
  return link;
}

// ─── Claim status ───────────────────────────────────────────────────────
export async function setClaimStatus(kind, id, status) {
  const table = CLAIM_TABLES[kind];
  if (!table) throw new ReviewError(400, 'Unknown claim kind.');
  if (!isUuid(id)) throw new ReviewError(400, 'The id must be a UUID.');
  if (!CLAIM_DECISIONS.includes(status)) throw new ReviewError(400, `status must be one of ${CLAIM_DECISIONS.join(', ')}.`);
  const row = await queryOne(`UPDATE "${table}" SET "status" = $2 WHERE "id" = $1 RETURNING "id", "status"`, [id, status]);
  if (!row) throw new ReviewError(404, kind === 'entities' ? 'Entity not found.' : 'Relation not found.');
  return row;
}

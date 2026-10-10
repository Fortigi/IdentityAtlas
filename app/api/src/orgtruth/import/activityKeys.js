// Organisation truth — reviewing activity keys (the distinct actor / subject
// values of the activity imports), one value at a time.
//
//   listKeys({ status, role, profileName, page })
//     → { data: [{ id, profileName, role, rawValue, rows, targetType, targetId, targetLabel,
//                  confidence, status, candidates? }], total }
//     PAGE_SIZE per page, the most referenced values first. `candidates` (the best
//     MAX_CANDIDATES targets, scored now) only on keys that are not accepted.
//   decideKeyReview(id, { status, targetType?, targetId? }, actor)
//     → { key } | { error, status } — an analyst decision (analystOverride = true), which no
//     later import changes. Accepting needs a target: the one given, else the key's proposed one.
import { query, queryOne } from '../../db/connection.js';
import { TARGET_TABLES } from '../linking/candidates.js';
import { decideKey, loadRoleIndexes } from './activityResolve.js';
import { isUuid } from './httpHelpers.js';

export const PAGE_SIZE = 50;
export const KEY_STATUSES = ['proposed', 'accepted', 'rejected', 'unmatched'];
export const KEY_TARGET_TYPES = ['Principal', 'Identity', 'Resource', 'OrgEntity'];

const LABEL_SQL = KEY_TARGET_TYPES.map(t => `WHEN '${t}' THEN (SELECT x."displayName" FROM "${TARGET_TABLES[t].table}" x WHERE x."id" = k."targetId")`).join(' ');

const LIST_SQL = `
  SELECT * FROM (
    SELECT k."id", k."profileName", k."role", k."rawValue", k."targetType", k."targetId", k."confidence", k."status",
           CASE k."role" WHEN 'actor' THEN (SELECT count(*)::int FROM "OrgActivities" a WHERE a."actorKeyId" = k."id")
                         ELSE (SELECT count(*)::int FROM "OrgActivities" a WHERE a."subjectKeyId" = k."id") END AS "rows",
           CASE k."targetType" ${LABEL_SQL} END AS "targetLabel",
           count(*) OVER ()::int AS "total"
      FROM "OrgActivityKeys" k
     WHERE ($1::text IS NULL OR k."status" = $1) AND ($2::text IS NULL OR k."role" = $2) AND ($3::text IS NULL OR k."profileName" = $3)
  ) q
   ORDER BY q."rows" DESC, q."rawValue", q."id"
   LIMIT ${PAGE_SIZE} OFFSET $4`;

const LATEST_RECIPE_SQL = `SELECT "recipe" FROM "OrgImportProfiles" WHERE "name" = $1 ORDER BY "version" DESC LIMIT 1`;

// The rule indexes per (profile name, role), loaded once per request.
async function candidatesFor(keys) {
  const cache = new Map();
  const out = new Map();
  for (const k of keys.filter(x => x.status !== 'accepted')) {
    const ck = `${k.profileName}\u0000${k.role}`;
    if (!cache.has(ck)) {
      const profile = await queryOne(LATEST_RECIPE_SQL, [k.profileName]);
      cache.set(ck, profile?.recipe?.template === 'activity' ? await loadRoleIndexes(profile.recipe, k.role) : null);
    }
    const indexes = cache.get(ck);
    if (indexes) out.set(k.id, decideKey(k.rawValue, indexes).candidates);
  }
  return out;
}

export async function listKeys({ status = null, role = null, profileName = null, page = 1 } = {}) {
  const r = await query(LIST_SQL, [status, role, profileName, (page - 1) * PAGE_SIZE]);
  const candidates = await candidatesFor(r.rows);
  const data = r.rows.map(({ total: _t, ...k }) => (candidates.has(k.id) ? { ...k, candidates: candidates.get(k.id) } : k));
  return { data, total: r.rows[0]?.total ?? 0 };
}

const UPDATE_SQL = `
  UPDATE "OrgActivityKeys"
     SET "status" = $2, "targetType" = $3, "targetId" = $4,
         "confidence" = CASE WHEN "targetId" IS DISTINCT FROM $4 THEN 100 ELSE "confidence" END,
         "analystOverride" = true, "decidedBy" = $5, "decidedAt" = now() AT TIME ZONE 'utc', "updatedAt" = now() AT TIME ZONE 'utc'
   WHERE "id" = $1
  RETURNING "id", "profileName", "role", "rawValue", "targetType", "targetId", "confidence", "status", "analystOverride", "decidedBy", "decidedAt"`;

async function targetExists(targetType, targetId) {
  const row = await queryOne(`SELECT 1 AS "found" FROM "${TARGET_TABLES[targetType].table}" WHERE "id" = $1`, [targetId]);
  return !!row;
}

// The target an acceptance points at, or an error sentence.
async function acceptedTarget(key, body) {
  const targetType = body.targetType ?? key.targetType;
  const targetId = body.targetId ?? key.targetId;
  if (!targetType || !targetId) return { error: 'Accepting a value needs a target: send targetType and targetId.' };
  if (!KEY_TARGET_TYPES.includes(targetType)) return { error: `targetType must be one of ${KEY_TARGET_TYPES.join(', ')}.` };
  if (!isUuid(targetId)) return { error: 'targetId is not a valid id.' };
  if (!(await targetExists(targetType, targetId))) return { error: `No ${targetType} with id ${targetId} exists.` };
  return { targetType, targetId };
}

export async function decideKeyReview(id, body, actor) {
  if (!['accepted', 'rejected'].includes(body?.status)) return { status: 400, error: 'status must be accepted or rejected.' };
  const key = isUuid(id) ? await queryOne(`SELECT "id", "targetType", "targetId" FROM "OrgActivityKeys" WHERE "id" = $1`, [id]) : null;
  if (!key) return { status: 404, error: 'Activity key not found.' };
  const target = body.status === 'accepted' ? await acceptedTarget(key, body) : { targetType: key.targetType, targetId: key.targetId };
  if (target.error) return { status: 400, error: target.error };
  return { key: await queryOne(UPDATE_SQL, [id, body.status, target.targetType, target.targetId, actor]) };
}

// Organisation truth — what the matrix filter's "Organisation" picker can offer
// for one entity type (the condition itself: matrix/orgCondition.js).
//
//   getFilterOptions(entityType) →
//   { entityType, entityCount,
//     attributes: [ { key, distinct, free, values: [ { value, count } ] } ],   keys sorted; top 50 values,
//                                                                              most frequent first
//     vias:       [ { name, kind: 'direct' | 'through', targets: [...], links } ] }
//
//   attributes  over the accepted, current entities of the type. A key whose
//               every value is unique and that has more than 50 of them (an id,
//               a name) is still listed, as `free: true` with no values — it
//               cannot be picked from a list.
//   vias        the names the condition's `via` accepts: `direct` = the via of
//               a link from these entities to a system object, `through` = the
//               entity type of a fact list whose rows link to these entities by
//               an attribute and to system objects themselves (a timesheet row
//               naming the customer and the person). `links` counts accepted
//               links to system objects.
import { query } from '../../db/connection.js';

export const VALUES_PER_KEY = 50;
const SYSTEM_TYPES = ['Principal', 'Identity', 'Resource', 'Context'];
const CURRENT = (alias) => `${alias}."status" = 'accepted' AND ${alias}."validTo" IS NULL`;

const countSql = `SELECT count(*)::int AS n FROM "OrgEntities" e WHERE e."entityType" = $1 AND ${CURRENT('e')}`;

// Per (key, value): how many entities; per key: how many distinct values, and
// whether it is multi-valued. A multi-valued attribute (stored as a JSON array,
// e.g. expertises) offers its SEPARATE values — "devops engineer" — not each
// row's whole list; an entity counts once per value it holds.
const valuesSql = `
  WITH kv AS (
    SELECT e."id", a.key, jsonb_typeof(a.value) = 'array' AS multi, a.value
      FROM "OrgEntities" e
     CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(e."attributes") = 'object' THEN e."attributes" ELSE '{}'::jsonb END) a
     WHERE e."entityType" = $1 AND ${CURRENT('e')}),
  flat AS (
    SELECT kv."id", kv.key, kv.multi, x.value
      FROM kv CROSS JOIN LATERAL (
        SELECT jsonb_array_elements_text(kv.value) AS value WHERE kv.multi
        UNION ALL SELECT kv.value #>> '{}' WHERE NOT kv.multi) x),
  v AS (
    SELECT key, value, count(DISTINCT "id")::int AS n, bool_or(multi) AS multi
      FROM flat WHERE value IS NOT NULL AND value <> ''
     GROUP BY key, value),
  r AS (
    SELECT key, value, n, count(*) OVER (PARTITION BY key)::int AS "distinctCount",
           bool_or(multi) OVER (PARTITION BY key) AS multi,
           row_number() OVER (PARTITION BY key ORDER BY n DESC, value) AS rn
      FROM v)
  SELECT key, value, n, "distinctCount", multi FROM r WHERE rn <= $2 ORDER BY key, rn`;

// Activity on these entities (a timesheet imported as activity): its type is a
// `through` name the condition's `via` accepts, like a fact list's type.
const activitySql = `
  SELECT a."activityType" AS name, ak."targetType", count(*)::int AS links
    FROM "OrgActivities" a
    JOIN "OrgActivityKeys" sk ON sk."id" = a."subjectKeyId" AND sk."status" = 'accepted' AND sk."targetType" = 'OrgEntity'
    JOIN "OrgActivityKeys" ak ON ak."id" = a."actorKeyId" AND ak."status" = 'accepted' AND ak."targetType" = ANY($2::text[])
    JOIN "OrgEntities" e ON e."id" = sk."targetId"
   WHERE e."entityType" = $1 AND ${CURRENT('e')}
   GROUP BY 1, 2`;

const directSql = `
  SELECT COALESCE(l."via", 'displayName') AS name, l."targetType", count(*)::int AS links
    FROM "OrgLinks" l JOIN "OrgEntities" e ON e."id" = l."orgEntityId"
   WHERE e."entityType" = $1 AND ${CURRENT('e')}
     AND l."status" = 'accepted' AND l."targetType" = ANY($2::text[])
   GROUP BY 1, 2`;

const throughSql = `
  SELECT f."entityType" AS name, fl."targetType", count(*)::int AS links
    FROM "OrgEntities" e
    JOIN "OrgLinks" tl ON tl."targetType" = 'OrgEntity' AND tl."targetId" = e."id" AND tl."status" = 'accepted'
                      AND COALESCE(tl."via", 'displayName') <> 'displayName'
    JOIN "OrgEntities" f ON f."id" = tl."orgEntityId" AND ${CURRENT('f')}
    JOIN "OrgLinks" fl ON fl."orgEntityId" = f."id" AND fl."status" = 'accepted' AND fl."targetType" = ANY($2::text[])
   WHERE e."entityType" = $1 AND ${CURRENT('e')}
   GROUP BY 1, 2`;

/** Pure: value rows (ordered by key, rank) → attribute list. */
export function shapeAttributes(rows, entityCount) {
  const byKey = new Map();
  for (const r of rows) {
    const a = byKey.get(r.key) ?? { key: r.key, distinct: r.distinctCount, free: false, multi: r.multi === true, values: [] };
    a.values.push({ value: r.value, count: r.n });
    byKey.set(r.key, a);
  }
  const out = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  for (const a of out) {
    if (a.distinct === entityCount && a.distinct > VALUES_PER_KEY) { a.free = true; a.values = []; }
  }
  return out;
}

/** Pure: direct + through rows → via list, one entry per (kind, name). */
export function shapeVias(directRows, throughRows) {
  const byKey = new Map();
  const add = (kind, r) => {
    const key = `${kind}|${r.name}`;
    const v = byKey.get(key) ?? { name: r.name, kind, targets: [], links: 0 };
    if (!v.targets.includes(r.targetType)) v.targets.push(r.targetType);
    v.links += r.links;
    byKey.set(key, v);
  };
  directRows.forEach(r => add('direct', r));
  throughRows.forEach(r => add('through', r));
  const out = [...byKey.values()];
  for (const v of out) v.targets.sort((a, b) => SYSTEM_TYPES.indexOf(a) - SYSTEM_TYPES.indexOf(b));
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export async function getFilterOptions(entityType) {
  const [count, values, direct, through, activity] = await Promise.all([
    query(countSql, [entityType]),
    query(valuesSql, [entityType, VALUES_PER_KEY]),
    query(directSql, [entityType, SYSTEM_TYPES]),
    query(throughSql, [entityType, SYSTEM_TYPES]),
    query(activitySql, [entityType, SYSTEM_TYPES]),
  ]);
  const entityCount = count.rows[0]?.n ?? 0;
  return {
    entityType,
    entityCount,
    attributes: shapeAttributes(values.rows, entityCount),
    vias: shapeVias(direct.rows, [...through.rows, ...activity.rows]),
  };
}

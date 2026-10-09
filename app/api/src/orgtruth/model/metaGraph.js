// Organisation truth — the meta-model the Model tab draws (GET /org-truth/model).
//
// Response (all counts integers; arrays sorted as listed):
//
//   {
//     entityTypes: [ { type, count, proposed, attributeKeys: string[], sources, lastObservedAt } ],  // by type
//     predicates:  [ { predicate, fromType, toType, count, proposed } ],  // by predicate, fromType, toType
//     links:       [ { entityType, targetType, accepted, proposed } ],    // by entityType, targetType
//     systemTypes: [ { targetType, count } ],                              // Principal, Resource, Identity, Context; [] with withSystemCounts=0
//     totals:      { entities, relations, links, sources }
//   }
//
// Semantics (T4 decisions):
//   - `count` is the accepted rows, `proposed` the proposed ones; rejected rows
//     are left out everywhere (also from `sources`, `lastObservedAt`, the keys).
//   - Open rows only (validTo IS NULL) unless includeClosed; for relations and
//     links the open/closed and sourceId filters apply to the relation row and
//     to the link's entity respectively.
//   - attributeKeys: the keys of the entities' `attributes`, most frequent first,
//     capped at 50 per type.
//   - totals.entities / relations / links = accepted + proposed; totals.sources
//     = uploaded OrgSources (1 or 0 with a sourceId filter).
import * as db from '../../db/connection.js';
import { createParams } from '../../db/sqlParams.js';

export const ATTRIBUTE_KEY_CAP = 50;
export const SYSTEM_TYPES = ['Principal', 'Resource', 'Identity', 'Context'];

// WHERE fragment for a row of OrgEntities/OrgRelations under alias `a`.
// The sourceId value is bound; the closed filter is a fixed fragment.
function claimFilter(a, { includeClosed, sourceId }, bind) {
  const parts = [`${a}.status <> 'rejected'`];
  if (!includeClosed) parts.push(`${a}."validTo" IS NULL`);
  if (sourceId) parts.push(`${a}."sourceId" = ${bind(sourceId)}::uuid`);
  return parts.join(' AND ');
}

async function entityTypeRows(filters) {
  const { params, bind } = createParams();
  return (await db.query(`
    SELECT e."entityType" AS type,
           COUNT(*) FILTER (WHERE e.status = 'accepted')::int AS count,
           COUNT(*) FILTER (WHERE e.status = 'proposed')::int AS proposed,
           COUNT(DISTINCT e."sourceId")::int AS sources,
           MAX(e."observedAt") AS "lastObservedAt"
      FROM "OrgEntities" e
     WHERE ${claimFilter('e', filters, bind)}
     GROUP BY e."entityType"
     ORDER BY e."entityType"
  `, params)).rows;
}

async function attributeKeyRows(filters) {
  const { params, bind } = createParams();
  return (await db.query(`
    SELECT e."entityType" AS type, k.key, COUNT(*)::int AS n
      FROM "OrgEntities" e
     CROSS JOIN LATERAL jsonb_object_keys(
             CASE WHEN jsonb_typeof(e.attributes) = 'object' THEN e.attributes ELSE '{}'::jsonb END
           ) AS k(key)
     WHERE ${claimFilter('e', filters, bind)}
     GROUP BY e."entityType", k.key
     ORDER BY e."entityType", n DESC, k.key
  `, params)).rows;
}

async function predicateRows(filters) {
  const { params, bind } = createParams();
  return (await db.query(`
    SELECT r.predicate, f."entityType" AS "fromType", t."entityType" AS "toType",
           COUNT(*) FILTER (WHERE r.status = 'accepted')::int AS count,
           COUNT(*) FILTER (WHERE r.status = 'proposed')::int AS proposed
      FROM "OrgRelations" r
      JOIN "OrgEntities" f ON f.id = r."fromEntityId"
      JOIN "OrgEntities" t ON t.id = r."toEntityId"
     WHERE ${claimFilter('r', filters, bind)}
     GROUP BY r.predicate, f."entityType", t."entityType"
     ORDER BY r.predicate, f."entityType", t."entityType"
  `, params)).rows;
}

async function linkRows(filters) {
  const { params, bind } = createParams();
  return (await db.query(`
    SELECT e."entityType", l."targetType",
           COUNT(*) FILTER (WHERE l.status = 'accepted')::int AS accepted,
           COUNT(*) FILTER (WHERE l.status = 'proposed')::int AS proposed
      FROM "OrgLinks" l
      JOIN "OrgEntities" e ON e.id = l."orgEntityId"
     WHERE l.status <> 'rejected' AND ${claimFilter('e', filters, bind)}
     GROUP BY e."entityType", l."targetType"
     ORDER BY e."entityType", l."targetType"
  `, params)).rows;
}

async function sourceCount({ sourceId }) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM "OrgSources" WHERE ($1::uuid IS NULL OR id = $1::uuid)`,
    [sourceId || null],
  );
  return r.rows[0]?.n ?? 0;
}

async function systemTypeRows() {
  const r = await db.query(`
    SELECT (SELECT COUNT(*) FROM "Principals")::int AS "Principal",
           (SELECT COUNT(*) FROM "Resources")::int  AS "Resource",
           (SELECT COUNT(*) FROM "Identities")::int AS "Identity",
           (SELECT COUNT(*) FROM "Contexts")::int   AS "Context"
  `);
  const row = r.rows[0] || {};
  return SYSTEM_TYPES.map(targetType => ({ targetType, count: row[targetType] ?? 0 }));
}

export function groupAttributeKeys(rows, cap = ATTRIBUTE_KEY_CAP) {
  const byType = new Map();
  for (const { type, key } of rows) {
    const keys = byType.get(type) || [];
    if (keys.length < cap) keys.push(key);
    byType.set(type, keys);
  }
  return byType;
}

const sum = (rows, ...fields) => rows.reduce((n, r) => n + fields.reduce((m, f) => m + (r[f] || 0), 0), 0);

/**
 * @param {{ includeClosed?: boolean, sourceId?: string|null, withSystemCounts?: boolean }} opts
 */
export async function getMetaGraph({ includeClosed = false, sourceId = null, withSystemCounts = true } = {}) {
  const filters = { includeClosed, sourceId };
  const [types, keyRows, predicates, links, sources, systemTypes] = await Promise.all([
    entityTypeRows(filters),
    attributeKeyRows(filters),
    predicateRows(filters),
    linkRows(filters),
    sourceCount(filters),
    withSystemCounts ? systemTypeRows() : Promise.resolve([]),
  ]);
  const keys = groupAttributeKeys(keyRows);
  const entityTypes = types.map(t => ({ ...t, attributeKeys: keys.get(t.type) || [] }));
  return {
    entityTypes,
    predicates,
    links,
    systemTypes,
    totals: {
      entities: sum(types, 'count', 'proposed'),
      relations: sum(predicates, 'count', 'proposed'),
      links: sum(links, 'accepted', 'proposed'),
      sources,
    },
  };
}

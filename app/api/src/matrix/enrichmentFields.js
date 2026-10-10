// The enrichment attribute fields the matrix attribute picker offers, next to
// the entity's own columns (GET /api/matrix/columns) and searchable like them
// (GET /api/matrix/column-values).
//
//   listEnrichmentFields(entity) →
//     [{ column: 'org.Maten.expertises', key: 'org.Maten.expertises', type: 'text',
//        values: ['Azure', 'IAM'], truncated, label: 'expertises (Maten)', multi: true }]
//     (the ordinary column entry shape; `key` repeats `column` for the picker)
//   enrichmentFieldValues(entity, column, q) → { column, values, truncated } | null (not an enrichment field)
//
// A field is listed for a matrix entity when an enrichment row about that entity
// kind carries it — widened like the condition (enrichmentCondition.js): the
// Principal and Identity pickers both see Principal and Identity enrichments.
// Values are distinct and split for multi-valued attributes (one entry per list
// element), alphabetical, at most VALUES_PER_FIELD per field (`truncated` then;
// the rest is reachable through the search). `multi` says the attribute holds a
// list somewhere, so the picker can say "matches any of".
import * as db from '../db/connection.js';
import { createParams, likeContains } from '../db/sqlParams.js';
import { enrichmentTargetsSql } from '../orgtruth/enrichment/sql.js';
import { enrichmentField, parseEnrichmentField, isEnrichmentField } from './enrichmentCondition.js';

export const VALUES_PER_FIELD = 200;
export const TARGETS_FOR = Object.freeze({
  Principal: ['Principal', 'Identity'],
  Identity: ['Identity', 'Principal'],
  Resource: ['Resource'],
});

// Per (source, key, value) one row, the first VALUES_PER_FIELD per field, with
// the field's distinct-value count and whether that value came out of a list.
function valuesQuery(entity, { source = null, key = null, q = '' } = {}) {
  const { params, bind } = createParams();
  const where = [`l."targetType" = ANY(${bind(TARGETS_FOR[entity])}::text[])`];
  if (source) where.push(`e."entityType" = ${bind(source)}`);
  const keyFilter = key ? `WHERE k.key = ${bind(key)}` : '';
  const qFilter = q ? `AND ev.v ILIKE ${bind(likeContains(q))} ESCAPE '\\'` : '';
  const sql = `
    WITH t AS (${enrichmentTargetsSql(where)}),
    kv AS (
      SELECT DISTINCT t."entityId", t.source, k.key, k.value
        FROM t CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(t."attributes") = 'object' THEN t."attributes" ELSE '{}'::jsonb END) k
       ${keyFilter}),
    v AS (
      SELECT kv.source, kv.key, ev.v AS value, jsonb_typeof(kv.value) = 'array' AS multi
        FROM kv CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE jsonb_typeof(kv.value) WHEN 'array' THEN kv.value ELSE jsonb_build_array(kv.value) END) ev(v)
       WHERE ev.v IS NOT NULL AND ev.v <> '' ${qFilter}),
    r AS (
      SELECT source, key, value, bool_or(multi) AS multi,
             row_number() OVER (PARTITION BY source, key ORDER BY value) AS rn,
             count(*) OVER (PARTITION BY source, key) AS n
        FROM v GROUP BY source, key, value)
    SELECT source, key, value, multi, n::int AS "distinctCount"
      FROM r WHERE rn <= ${bind(VALUES_PER_FIELD)} ORDER BY source, key, rn`;
  return { sql, params };
}

/** Pure: value rows (ordered by source, key, rank) → picker fields. */
export function shapeFields(rows) {
  const fields = new Map();
  for (const r of rows) {
    const column = enrichmentField(r.source, r.key);
    const f = fields.get(column) ?? { column, key: column, type: 'text', values: [], truncated: false, label: `${r.key} (${r.source})`, multi: false };
    f.values.push(r.value);
    f.multi = f.multi || r.multi === true;
    f.truncated = r.distinctCount > VALUES_PER_FIELD;
    fields.set(column, f);
  }
  return [...fields.values()];
}

export async function listEnrichmentFields(entity) {
  if (!Object.hasOwn(TARGETS_FOR, entity)) return [];
  const { sql, params } = valuesQuery(entity);
  return shapeFields((await db.query(sql, params)).rows);
}

export async function enrichmentFieldValues(entity, column, q = '') {
  if (!isEnrichmentField(column)) return null;
  const parsed = parseEnrichmentField(column);
  if (!parsed || !Object.hasOwn(TARGETS_FOR, entity)) return { column, values: [], truncated: false };
  const { sql, params } = valuesQuery(entity, { source: parsed.source, key: parsed.attribute, q });
  const [field] = shapeFields((await db.query(sql, params)).rows);
  return { column, values: field?.values ?? [], truncated: field?.truncated ?? false };
}

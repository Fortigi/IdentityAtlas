// Shared column-discovery cache for the principals/resources tables.
//
// Routes use this to discover what columns exist (so the UI can render
// dynamic filter dropdowns) and to fetch the distinct values per filterable
// column. Both queries are cached for 5 minutes; an in-flight deduplication
// promise prevents thundering-herd on cold cache.
//
// In v5 the only tables are postgres `Principals` and `Resources`. They are
// created with quoted PascalCase identifiers (see migrations/001_core_schema.sql)
// and the columns are also camelCase — information_schema lookups therefore
// need the exact case.
//
// The legacy `GraphUsers` / `GraphGroups` paths are removed — they were the v3
// pre-universal-resource-model fallback and have been dead code since v3.1.

import * as db from './connection.js';

const COLUMN_CACHE_TTL = 5 * 60 * 1000;

// Postgres data types we treat as filterable. The legacy types like
// `nvarchar` no longer apply.
const FILTERABLE_TYPES = new Set([
  'text', 'character varying', 'character', 'boolean',
  'integer', 'bigint', 'smallint',
]);

// Validate identifiers used in dynamic SQL — defense-in-depth even though
// we only feed it information_schema output.
const SAFE_IDENT_RE = /^[a-zA-Z0-9_]+$/;

// ─── Schema cache ───────────────────────────────────────────────
let principalColumnsCache = null;
let principalColumnsCacheTime = 0;
let resourceColumnsCache = null;
let resourceColumnsCacheTime = 0;

async function discoverColumns(table) {
  if (!SAFE_IDENT_RE.test(table)) throw new Error(`Invalid table name: ${table}`);
  const r = await db.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND column_name NOT IN ('id', 'systemId', 'extendedAttributes')
      ORDER BY ordinal_position`,
    [table]
  );
  return r.rows.map(row => ({
    name: row.column_name,
    rawName: row.column_name,
    type: row.data_type,
  }));
}

export async function getPrincipalColumns(_pool) {
  const now = Date.now();
  if (principalColumnsCache && (now - principalColumnsCacheTime) < COLUMN_CACHE_TTL) {
    return principalColumnsCache;
  }
  principalColumnsCache = await discoverColumns('Principals');
  principalColumnsCacheTime = now;
  return principalColumnsCache;
}

export async function getResourceColumns(_pool) {
  const now = Date.now();
  if (resourceColumnsCache && (now - resourceColumnsCacheTime) < COLUMN_CACHE_TTL) {
    return resourceColumnsCache;
  }
  resourceColumnsCache = await discoverColumns('Resources');
  resourceColumnsCacheTime = now;
  return resourceColumnsCache;
}

// Backward-compat aliases used by some routes — they always return principal/
// resource columns now, no GraphUsers/GraphGroups fallback exists in v5.
export const getUserColumns                = getPrincipalColumns;
export const getGroupColumns               = getResourceColumns;
export const getPrincipalOrUserColumns     = getPrincipalColumns;

// ─── Distinct values cache ──────────────────────────────────────
let principalValuesCache = null;
let principalValuesCacheTime = 0;
let principalValuesInflight = null;
let resourceValuesCache = null;
let resourceValuesCacheTime = 0;
let resourceValuesInflight = null;

async function discoverColumnValues(table, columns) {
  const filterableCols = columns.filter(c => FILTERABLE_TYPES.has(c.type) && SAFE_IDENT_RE.test(c.rawName));
  if (filterableCols.length === 0) return {};
  if (!SAFE_IDENT_RE.test(table)) throw new Error(`Invalid table name: ${table}`);

  // One UNION ALL query per filterable column. Each gets up to 500 distinct
  // non-null values. The result is a flat (col, val) list which we group in JS.
  // postgres syntax: ::text cast for non-text columns, LIMIT 500 instead of TOP.
  const parts = filterableCols.map(c =>
    `SELECT '${c.name}' AS col, val FROM (
       SELECT DISTINCT "${c.rawName}"::text AS val FROM "${table}"
        WHERE "${c.rawName}" IS NOT NULL AND "${c.rawName}"::text <> ''
        LIMIT 500
     ) t`
  );

  const r = await db.query(parts.join('\nUNION ALL\n') + '\nORDER BY col, val');
  const grouped = {};
  for (const row of r.rows) {
    if (!grouped[row.col]) grouped[row.col] = [];
    grouped[row.col].push(row.val);
  }
  return grouped;
}

// Discover scalar top-level keys in the `extendedAttributes` JSONB column and
// their distinct values. The flat column list returned by `discoverColumns`
// deliberately excludes `extendedAttributes` (it's a blob, not directly
// filterable), but individual string/number/boolean keys INSIDE the blob are
// very useful filter fields — e.g. `userType`, `onPremisesSyncEnabled`,
// `extensionAttribute5`. They're surfaced under namespaced keys like
// `ext.userType` so the front end and `buildFilterWhere` can tell them apart
// from real columns and emit JSON-path SQL (`"extendedAttributes"->>'key'`).
//
// Object/array-valued keys (e.g. `signInActivity`, `groupTypes`) are skipped —
// matching on a serialized object is not a useful filter.
async function discoverExtendedAttrValues(table) {
  if (!SAFE_IDENT_RE.test(table)) throw new Error(`Invalid table name: ${table}`);

  // Find distinct scalar top-level keys. We use jsonb_typeof on the value so
  // we only keep keys whose typical content is something a user would filter
  // on; if a key is mixed (string in some rows, object in others) we'd lose
  // the object rows, but the filter still matches the scalar ones.
  const keysRes = await db.query(
    `SELECT DISTINCT key
       FROM "${table}", jsonb_object_keys("extendedAttributes") AS key
      WHERE "extendedAttributes" IS NOT NULL
        AND jsonb_typeof("extendedAttributes"->key) IN ('string', 'number', 'boolean')`
  );
  const keys = keysRes.rows.map(r => r.key).filter(k => SAFE_IDENT_RE.test(k));
  if (keys.length === 0) return {};

  // One UNION ALL per key — same shape as discoverColumnValues. The
  // `->> 'key'` form returns text for any scalar jsonb type, which is what
  // we want: booleans become 'true'/'false', numbers become their printed form.
  const parts = keys.map(k =>
    `SELECT 'ext.${k}' AS col, val FROM (
       SELECT DISTINCT "extendedAttributes"->>'${k}' AS val FROM "${table}"
        WHERE "extendedAttributes" ? '${k}'
          AND "extendedAttributes"->>'${k}' IS NOT NULL
          AND "extendedAttributes"->>'${k}' <> ''
        LIMIT 500
     ) t`
  );

  const r = await db.query(parts.join('\nUNION ALL\n') + '\nORDER BY col, val');
  const grouped = {};
  for (const row of r.rows) {
    if (!grouped[row.col]) grouped[row.col] = [];
    grouped[row.col].push(row.val);
  }
  return grouped;
}

export async function getPrincipalColumnValues(_pool) {
  const now = Date.now();
  if (principalValuesCache && (now - principalValuesCacheTime) < COLUMN_CACHE_TTL) {
    return principalValuesCache;
  }
  if (principalValuesInflight) return principalValuesInflight;
  principalValuesInflight = (async () => {
    try {
      const cols = await getPrincipalColumns(null);
      const [base, ext] = await Promise.all([
        discoverColumnValues('Principals', cols),
        discoverExtendedAttrValues('Principals'),
      ]);
      const result = { ...base, ...ext };
      principalValuesCache = result;
      principalValuesCacheTime = Date.now();
      return result;
    } finally {
      principalValuesInflight = null;
    }
  })();
  return principalValuesInflight;
}

export async function getResourceColumnValues(_pool) {
  const now = Date.now();
  if (resourceValuesCache && (now - resourceValuesCacheTime) < COLUMN_CACHE_TTL) {
    return resourceValuesCache;
  }
  if (resourceValuesInflight) return resourceValuesInflight;
  resourceValuesInflight = (async () => {
    try {
      const cols = await getResourceColumns(null);
      const [base, ext] = await Promise.all([
        discoverColumnValues('Resources', cols),
        discoverExtendedAttrValues('Resources'),
      ]);
      const result = { ...base, ...ext };
      resourceValuesCache = result;
      resourceValuesCacheTime = Date.now();
      return result;
    } finally {
      resourceValuesInflight = null;
    }
  })();
  return resourceValuesInflight;
}

export const getUserColumnValues             = getPrincipalColumnValues;
export const getGroupColumnValues            = getResourceColumnValues;
export const getPrincipalOrUserColumnValues  = getPrincipalColumnValues;

export { FILTERABLE_TYPES };

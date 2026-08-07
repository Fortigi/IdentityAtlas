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

// How many distinct values we preload per column, and how many a value search
// returns. The preload is a hard payload cap: a column can have hundreds of
// thousands of distinct values (`description` in a real tenant) and shipping
// them all would blow up every filter-dropdown response.
export const DEFAULT_VALUE_PAGE_SIZE = 500;
export const MAX_VALUE_PAGE_SIZE = 5000;
export const VALUE_SEARCH_LIMIT = 50;

// The page size is a deployment setting (`MATRIX_VALUE_PAGE_SIZE`), not a
// constant, so the capped path can be exercised on a dataset that has nowhere
// near 500 distinct values. Set it to a handful on a test deployment and every
// column with more values than that is paged, flagged and searched exactly as
// `description` is in a tenant with tens of thousands of them — which is what
// makes #928 verifiable without first importing 500+ resources.
//
// Anything unparseable, zero or negative falls back to the default; the value
// is capped at MAX_VALUE_PAGE_SIZE so a typo can't turn every filter dropdown
// into a multi-megabyte response.
export function valuePageSize() {
  const raw = String(process.env.MATRIX_VALUE_PAGE_SIZE ?? '').trim();
  if (!raw) return DEFAULT_VALUE_PAGE_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_VALUE_PAGE_SIZE;
  return Math.min(n, MAX_VALUE_PAGE_SIZE);
}

// Run the UNION ALL of per-column distinct-value subqueries and group the flat
// (col, val) result in JS.
//
// Each subquery fetches pageSize + 1 values ordered by value, so a column that
// came back with an extra row is known to have more than we serve: we drop the
// surplus and flag the column as truncated. Ordering inside the subquery is
// what makes the served page deterministic — without it Postgres returns an
// ARBITRARY page of the distinct values, which is what made values vanish from
// the matrix wizard's "+ Attribute" picker with no way to reach them (#928).
async function runValueUnion(parts, pageSize) {
  const r = await db.query(parts.join('\nUNION ALL\n') + '\nORDER BY col, val');
  const values = {};
  for (const row of r.rows) {
    if (!values[row.col]) values[row.col] = [];
    values[row.col].push(row.val);
  }
  const truncated = {};
  for (const [col, vals] of Object.entries(values)) {
    if (vals.length > pageSize) {
      values[col] = vals.slice(0, pageSize);
      truncated[col] = true;
    }
  }
  return { values, truncated };
}

// The distinct-value subquery for one real column — shared by the preload and
// the value search so both agree on what counts as a value.
function columnValueExpr(rawName) {
  return `"${rawName}"::text`;
}

// …and for one `extendedAttributes` key.
function extValueExpr(key) {
  return `"extendedAttributes"->>'${key}'`;
}

export async function discoverColumnValues(table, columns, pageSize = valuePageSize()) {
  const filterableCols = columns.filter(c => FILTERABLE_TYPES.has(c.type) && SAFE_IDENT_RE.test(c.rawName));
  if (filterableCols.length === 0) return { values: {}, truncated: {} };
  if (!SAFE_IDENT_RE.test(table)) throw new Error(`Invalid table name: ${table}`);

  // One UNION ALL query per filterable column. Each gets the alphabetically
  // first `pageSize` distinct non-null values (+1 probe row, see
  // runValueUnion). postgres syntax: ::text cast for non-text columns.
  const parts = filterableCols.map(c =>
    `SELECT '${c.name}' AS col, val FROM (
       SELECT DISTINCT ${columnValueExpr(c.rawName)} AS val FROM "${table}"
        WHERE "${c.rawName}" IS NOT NULL AND ${columnValueExpr(c.rawName)} <> ''
        ORDER BY val
        LIMIT ${pageSize + 1}
     ) t`
  );

  return runValueUnion(parts, pageSize);
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
export async function discoverExtendedAttrValues(table, pageSize = valuePageSize()) {
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
  if (keys.length === 0) return { values: {}, truncated: {} };

  // One UNION ALL per key — same shape as discoverColumnValues, including the
  // ordered page + overflow probe. The `->> 'key'` form returns text for any
  // scalar jsonb type, which is what we want: booleans become 'true'/'false',
  // numbers become their printed form.
  const parts = keys.map(k =>
    `SELECT 'ext.${k}' AS col, val FROM (
       SELECT DISTINCT ${extValueExpr(k)} AS val FROM "${table}"
        WHERE "extendedAttributes" ? '${k}'
          AND ${extValueExpr(k)} IS NOT NULL
          AND ${extValueExpr(k)} <> ''
        ORDER BY val
        LIMIT ${pageSize + 1}
     ) t`
  );

  return runValueUnion(parts, pageSize);
}

// Search the distinct values of ONE column for a substring — the escape hatch
// for columns whose value list is truncated. `column` is either a real column
// name or an `ext.<key>` namespaced key; it MUST come from an allowlist built
// from discovered columns/keys, never straight from the request, because it is
// interpolated into the SQL. The needle itself is always bound (#928).
export async function searchColumnValues(table, column, q, allowedColumns) {
  if (!SAFE_IDENT_RE.test(table)) throw new Error(`Invalid table name: ${table}`);
  if (!allowedColumns.has(column)) throw new Error(`Unknown column: ${column}`);

  const isExt = column.startsWith('ext.');
  const key = isExt ? column.slice(4) : column;
  if (!SAFE_IDENT_RE.test(key)) throw new Error(`Invalid column name: ${column}`);
  const valExpr = isExt ? extValueExpr(key) : columnValueExpr(key);
  const presence = isExt ? `"extendedAttributes" ? '${key}'` : `"${key}" IS NOT NULL`;

  // strpos on the lower-cased pair, not ILIKE: a `%` or `_` typed into the
  // search box is a literal character to the user, not a wildcard.
  const r = await db.query(
    `SELECT DISTINCT ${valExpr} AS val FROM "${table}"
      WHERE ${presence}
        AND ${valExpr} IS NOT NULL AND ${valExpr} <> ''
        AND strpos(lower(${valExpr}), lower($1)) > 0
      ORDER BY val
      LIMIT ${VALUE_SEARCH_LIMIT}`,
    [q],
  );
  return r.rows.map(row => row.val);
}

// Merge the real-column and ext-key halves into one { values, truncated } pair.
export function mergeValueSets(base, ext) {
  return {
    values:    { ...base.values,    ...ext.values },
    truncated: { ...base.truncated, ...ext.truncated },
  };
}

// The *Meta getters return { values, truncated, pageSize }; the plain getters
// return just the value map, which is the shape every existing consumer (filter
// dropdowns on the Users/Resources/tag pages) already spreads.
//
// `pageSize` is also the cache key alongside the TTL: a deployment that changes
// MATRIX_VALUE_PAGE_SIZE must not keep serving pages cut to the old size.
export async function getPrincipalColumnValuesMeta() {
  const now = Date.now();
  const pageSize = valuePageSize();
  if (principalValuesCache && principalValuesCache.pageSize === pageSize
      && (now - principalValuesCacheTime) < COLUMN_CACHE_TTL) {
    return principalValuesCache;
  }
  if (principalValuesInflight) return principalValuesInflight;
  principalValuesInflight = (async () => {
    try {
      const cols = await getPrincipalColumns(null);
      const [base, ext] = await Promise.all([
        discoverColumnValues('Principals', cols, pageSize),
        discoverExtendedAttrValues('Principals', pageSize),
      ]);
      const result = { ...mergeValueSets(base, ext), pageSize };
      principalValuesCache = result;
      principalValuesCacheTime = Date.now();
      return result;
    } finally {
      principalValuesInflight = null;
    }
  })();
  return principalValuesInflight;
}

export async function getResourceColumnValuesMeta() {
  const now = Date.now();
  const pageSize = valuePageSize();
  if (resourceValuesCache && resourceValuesCache.pageSize === pageSize
      && (now - resourceValuesCacheTime) < COLUMN_CACHE_TTL) {
    return resourceValuesCache;
  }
  if (resourceValuesInflight) return resourceValuesInflight;
  resourceValuesInflight = (async () => {
    try {
      const cols = await getResourceColumns(null);
      const [base, ext] = await Promise.all([
        discoverColumnValues('Resources', cols, pageSize),
        discoverExtendedAttrValues('Resources', pageSize),
      ]);
      const result = { ...mergeValueSets(base, ext), pageSize };
      resourceValuesCache = result;
      resourceValuesCacheTime = Date.now();
      return result;
    } finally {
      resourceValuesInflight = null;
    }
  })();
  return resourceValuesInflight;
}

export async function getPrincipalColumnValues(_pool) {
  return (await getPrincipalColumnValuesMeta()).values;
}

export async function getResourceColumnValues(_pool) {
  return (await getResourceColumnValuesMeta()).values;
}

// Test hook — the caches are module-level with a 5-minute TTL, which makes a
// suite that seeds rows and then asserts on discovered values order-dependent.
export function clearColumnCaches() {
  principalColumnsCache = null;
  principalColumnsCacheTime = 0;
  resourceColumnsCache = null;
  resourceColumnsCacheTime = 0;
  principalValuesCache = null;
  principalValuesCacheTime = 0;
  resourceValuesCache = null;
  resourceValuesCacheTime = 0;
}

export const getUserColumnValues             = getPrincipalColumnValues;
export const getGroupColumnValues            = getResourceColumnValues;
export const getPrincipalOrUserColumnValues  = getPrincipalColumnValues;

export { FILTERABLE_TYPES, SAFE_IDENT_RE };

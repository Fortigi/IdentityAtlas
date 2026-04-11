// Shared column-discovery cache for the principals/resources tables.
//
// Routes use this to discover what columns exist (so the UI can render
// dynamic filter dropdowns) and to fetch the distinct values per filterable
// column. Both queries are cached for 5 minutes; an in-flight deduplication
// promise prevents thundering-herd on cold cache.
//
// In v5 the only tables are postgres `principals` and `resources` (snake_case).
// The legacy `GraphUsers` / `GraphGroups` paths are removed — they were the v3
// pre-universal-resource-model fallback and have been dead code since v3.1.
//
// Returned column shape stays in camelCase so the frontend doesn't need
// changes — we map snake_case → camelCase here.

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

// Convert postgres column name to camelCase for the API response
function snakeToCamel(s) {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

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
        AND column_name NOT IN ('id', 'system_id', 'extended_attributes')
      ORDER BY ordinal_position`,
    [table]
  );
  return r.rows.map(row => ({
    name: snakeToCamel(row.column_name),
    rawName: row.column_name,
    type: row.data_type,
  }));
}

export async function getPrincipalColumns(_pool) {
  const now = Date.now();
  if (principalColumnsCache && (now - principalColumnsCacheTime) < COLUMN_CACHE_TTL) {
    return principalColumnsCache;
  }
  principalColumnsCache = await discoverColumns('principals');
  principalColumnsCacheTime = now;
  return principalColumnsCache;
}

export async function getResourceColumns(_pool) {
  const now = Date.now();
  if (resourceColumnsCache && (now - resourceColumnsCacheTime) < COLUMN_CACHE_TTL) {
    return resourceColumnsCache;
  }
  resourceColumnsCache = await discoverColumns('resources');
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

export async function getPrincipalColumnValues(_pool) {
  const now = Date.now();
  if (principalValuesCache && (now - principalValuesCacheTime) < COLUMN_CACHE_TTL) {
    return principalValuesCache;
  }
  if (principalValuesInflight) return principalValuesInflight;
  principalValuesInflight = (async () => {
    try {
      const cols = await getPrincipalColumns(null);
      const result = await discoverColumnValues('principals', cols);
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
      const result = await discoverColumnValues('resources', cols);
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
export const SYSTEM_COLS = new Set(['id', 'system_id', 'extended_attributes']);

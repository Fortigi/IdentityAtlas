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
import {
  COLUMN_CACHE_TTL, STALE_GRACE, createValueCache, valuePageSize,
  DEFAULT_VALUE_PAGE_SIZE, MAX_VALUE_PAGE_SIZE, VALUE_SEARCH_LIMIT,
} from './valueCache.js';

// Re-exported so every existing importer of these keeps working — the page
// size and the cache policy moved to db/valueCache.js, the discovery did not.
export {
  createValueCache, valuePageSize, STALE_GRACE,
  DEFAULT_VALUE_PAGE_SIZE, MAX_VALUE_PAGE_SIZE, VALUE_SEARCH_LIMIT,
};

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
// (the entries themselves are built with createValueCache further down, once
// the discovery functions they load from are defined)

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

// ─── Query planning for the value preload ───────────────────────
//
// Every column used to get its own `SELECT DISTINCT … ORDER BY val LIMIT n`
// branch, so discovering the values of a 13-column table read the whole table
// 13 times (a LIMIT after a DISTINCT cannot stop early — there is no index to
// walk — so each branch is a full scan plus a sort or hash).
//
// Most of those columns hold a handful of distinct values, and unpivoting them
// into ONE pass (`FROM … , LATERAL (VALUES (col, expr), …)`) collapses all of
// them into a single scan. That only works while the distinct set stays small:
// a near-unique column such as `displayName` or `description` would put one
// group per row into the shared hash aggregate, and measured on an 805 k-row
// Resources table that single-pass form is SLOWER than what it replaced
// (5.7 s vs 3.3 s). Those columns keep their own branch, where the aggregate
// is at least not shared with anything else.
//
// Which column is which comes from `pg_stats.n_distinct`, which PostgreSQL
// already maintains for free via ANALYZE. It is used as a ROUTING HINT ONLY:
// both routes return exactly the same values, so a stale or missing estimate
// costs time, never correctness. No stats row at all (a table never analysed)
// means every column takes its own branch — precisely the old behaviour.
// A column estimated to hold more distinct values than this keeps its own
// branch, and the shared pass stops accepting columns once their estimates add
// up to the budget — the shared hash aggregate holds one entry per distinct
// (column, value) pair, so the budget is what bounds its memory.
export const WIDE_COLUMN_DISTINCT_LIMIT = 50_000;
export const SHARED_PASS_DISTINCT_BUDGET = 250_000;

// Estimated distinct values of a column from a pg_stats row, or null when
// there is no usable estimate. Postgres stores a negative n_distinct as a
// MULTIPLE OF THE ROW COUNT (-1 = unique, -0.5 = half the rows are distinct),
// which is the form near-unique columns take, so it has to be scaled by the
// live row count before it can be compared with anything. A stats row that
// says 0 is an all-NULL column: no distinct values at all, and therefore the
// cheapest possible passenger on the shared pass — NOT an unknown, which is
// what a column with no stats row is.
export function estimateDistinct(nDistinct, rowCount) {
  const n = Number(nDistinct);
  if (!Number.isFinite(n)) return null;
  if (n >= 0) return n;
  const rows = Number(rowCount);
  if (!Number.isFinite(rows) || rows <= 0) return null;
  return Math.abs(n) * rows;
}

// Split the filterable columns into the ones that can share one pass and the
// ones that need their own. Pure, so the routing rule is unit-testable without
// a database.
export function planColumnValueQueries(
  columns, stats, rowCount,
  limit = WIDE_COLUMN_DISTINCT_LIMIT, budget = SHARED_PASS_DISTINCT_BUDGET,
) {
  const separate = [];
  const candidates = [];
  for (const c of columns) {
    const est = estimateDistinct(stats?.get(c.rawName), rowCount);
    // Unknown estimate ⇒ treat as wide. Being wrong here only costs a scan.
    if (est === null || est > limit) separate.push(c);
    else candidates.push({ c, est });
  }
  // Narrowest first, so a budget that runs out sheds the widest columns —
  // the ones that would have dominated the shared aggregate anyway.
  candidates.sort((a, b) => a.est - b.est);
  const shared = [];
  let spent = 0;
  for (const { c, est } of candidates) {
    if (spent + est > budget) separate.push(c);
    else { shared.push(c); spent += est; }
  }
  // One column on the shared route is just a branch with extra syntax.
  if (shared.length < 2) return { shared: [], separate: [...separate, ...shared] };
  return { shared, separate };
}

// n_distinct per column for one table, plus its estimated live row count.
// Best-effort: a deployment whose role cannot read pg_stats (or a table that
// has never been analysed) simply gets no hints.
async function columnStats(table) {
  try {
    const r = await db.query(
      `SELECT s.attname, s.n_distinct, c.reltuples
         FROM pg_stats s
         JOIN pg_class c ON c.relname = s.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname
        WHERE s.schemaname = 'public' AND s.tablename = $1`,
      [table]
    );
    const stats = new Map(r.rows.map(row => [row.attname, row.n_distinct]));
    return { stats, rowCount: r.rows.length ? Number(r.rows[0].reltuples) : 0 };
  } catch {
    return { stats: new Map(), rowCount: 0 };
  }
}

// The single-pass branch: unpivot several columns into (col, val) pairs with
// one scan, then keep the alphabetically first `pageSize + 1` per column.
export function sharedColumnPass(table, columns, pageSize) {
  const pairs = columns
    .map(c => `('${c.name}', ${columnValueExpr(c.rawName)})`)
    .join(', ');
  return `SELECT col, val FROM (
       SELECT col, val, row_number() OVER (PARTITION BY col ORDER BY val) AS rn FROM (
         SELECT DISTINCT v.col, v.val FROM "${table}",
           LATERAL (VALUES ${pairs}) AS v(col, val)
          WHERE v.val IS NOT NULL AND v.val <> ''
       ) d
     ) z WHERE rn <= ${pageSize + 1}`;
}

// The per-column branch, unchanged: the alphabetically first `pageSize`
// distinct non-null values (+1 probe row, see runValueUnion).
export function singleColumnPass(table, column, pageSize) {
  return `SELECT '${column.name}' AS col, val FROM (
       SELECT DISTINCT ${columnValueExpr(column.rawName)} AS val FROM "${table}"
        WHERE "${column.rawName}" IS NOT NULL AND ${columnValueExpr(column.rawName)} <> ''
        ORDER BY val
        LIMIT ${pageSize + 1}
     ) t`;
}

export async function discoverColumnValues(table, columns, pageSize = valuePageSize()) {
  const filterableCols = columns.filter(c => FILTERABLE_TYPES.has(c.type) && SAFE_IDENT_RE.test(c.rawName));
  if (filterableCols.length === 0) return { values: {}, truncated: {} };
  if (!SAFE_IDENT_RE.test(table)) throw new Error(`Invalid table name: ${table}`);

  const { stats, rowCount } = await columnStats(table);
  const { shared, separate } = planColumnValueQueries(filterableCols, stats, rowCount);

  const parts = separate.map(c => singleColumnPass(table, c, pageSize));
  if (shared.length) parts.push(sharedColumnPass(table, shared, pageSize));

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
// At most this many extendedAttributes keys become filter columns — the most
// frequent ones. Crawlers control the key set, and every discovered key adds a
// branch to the value query below, so an unbounded set made every column-list
// request as expensive as the number of distinct keys ever stored
// (SEC-2026-09 L-16). Far above what any shipped crawler writes.
export const MAX_EXTENDED_ATTR_KEYS = 300;

// The scalar top-level keys of a table's `extendedAttributes`, most frequent
// first. We use jsonb_typeof on the value so we only keep keys whose typical
// content is something a user would filter on; if a key is mixed (string in some
// rows, object in others) we'd lose the object rows, but the filter still matches
// the scalar ones. Keys that are not safe identifiers are dropped in SQL, before
// the cap, so they cannot use up the budget; the JS filter stays as defence in
// depth — every caller interpolates these keys into SQL.
//
// Shared with the report builder's field catalog (nlreports/extFields.js), which
// offers the same keys as report fields: one discovery rule, so an attribute you
// can filter on in a list is one you can report on.
export async function discoverExtendedAttrKeys(table, maxKeys = MAX_EXTENDED_ATTR_KEYS) {
  if (!SAFE_IDENT_RE.test(table)) throw new Error(`Invalid table name: ${table}`);
  const keysRes = await db.query(
    `SELECT key

       FROM "${table}", jsonb_object_keys("extendedAttributes") AS key
      WHERE "extendedAttributes" IS NOT NULL
        AND jsonb_typeof("extendedAttributes"->key) IN ('string', 'number', 'boolean')
        AND key ~ '^[a-zA-Z0-9_]+$'
      GROUP BY key
      ORDER BY COUNT(*) DESC, key
      LIMIT $1`,
    [maxKeys]
  );
  return keysRes.rows.map(r => r.key).filter(k => SAFE_IDENT_RE.test(k));
}

// The keys AND their values in ONE pass over the table.
//
// This used to be two steps — `discoverExtendedAttrKeys` to learn the key set,
// then one `SELECT DISTINCT … ORDER BY … LIMIT` per key — which read the whole
// table once for the keys and again for every key. On the customer's
// 805 k-row Resources table that was 13 scans and 11.3 s; expanding each row's
// JSON exactly once instead does the same work in 4.7 s.
//
// `jsonb_each` expands a row's object once and yields every (key, value) pair,
// so the key list falls out of the same aggregate that produces the values.
// Keys are still ranked by how many rows carry them and capped at `maxKeys`,
// and `value #>> '{}'` renders a scalar exactly as `->>` did: booleans become
// 'true'/'false', numbers their printed form.
export function extendedAttrValuesSql(table, pageSize, maxKeys) {
  return `WITH pairs AS (
       SELECT e.key AS col, e.value #>> '{}' AS val, count(*) AS rows
         FROM "${table}" t, LATERAL jsonb_each(
                CASE WHEN jsonb_typeof(t."extendedAttributes") = 'object'
                     THEN t."extendedAttributes" END) e
        WHERE jsonb_typeof(e.value) IN ('string', 'number', 'boolean')
          AND e.key ~ '^[a-zA-Z0-9_]+$'
        GROUP BY 1, 2
     ), keys AS (
       SELECT col, row_number() OVER (ORDER BY sum(rows) DESC, col) AS krank
         FROM pairs GROUP BY col
     )
     SELECT 'ext.' || p.col AS col, p.val
       FROM (
         SELECT col, val, row_number() OVER (PARTITION BY col ORDER BY val) AS rn
           FROM pairs WHERE val IS NOT NULL AND val <> ''
       ) p
       JOIN keys k ON k.col = p.col
      WHERE k.krank <= ${maxKeys} AND p.rn <= ${pageSize + 1}`;
}

export async function discoverExtendedAttrValues(table, pageSize = valuePageSize(), maxKeys = MAX_EXTENDED_ATTR_KEYS) {
  if (!SAFE_IDENT_RE.test(table)) throw new Error(`Invalid table name: ${table}`);
  const max = Number.isInteger(maxKeys) && maxKeys > 0 ? maxKeys : MAX_EXTENDED_ATTR_KEYS;
  return runValueUnion([extendedAttrValuesSql(table, pageSize, max)], pageSize);
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
// dropdowns on the Users/Resources/tag pages) already spreads. The caching
// policy behind them — including serving stale while revalidating — lives in
// db/valueCache.js.
const principalValues = createValueCache('Principals', async (pageSize) => {
  const cols = await getPrincipalColumns(null);
  const [base, ext] = await Promise.all([
    discoverColumnValues('Principals', cols, pageSize),
    discoverExtendedAttrValues('Principals', pageSize),
  ]);
  return mergeValueSets(base, ext);
});

const resourceValues = createValueCache('Resources', async (pageSize) => {
  const cols = await getResourceColumns(null);
  const [base, ext] = await Promise.all([
    discoverColumnValues('Resources', cols, pageSize),
    discoverExtendedAttrValues('Resources', pageSize),
  ]);
  return mergeValueSets(base, ext);
});

export function getPrincipalColumnValuesMeta() {
  return principalValues.get();
}

export function getResourceColumnValuesMeta() {
  return resourceValues.get();
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
  principalValues.clear();
  resourceValues.clear();
}

export const getUserColumnValues             = getPrincipalColumnValues;
export const getGroupColumnValues            = getResourceColumnValues;
export const getPrincipalOrUserColumnValues  = getPrincipalColumnValues;

export { FILTERABLE_TYPES, SAFE_IDENT_RE };

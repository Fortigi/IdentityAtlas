// Shared helpers + runtime config for the tags endpoints.
//
// Extracted from routes/tags.js (audit finding C1). buildFilterWhere,
// ensureTagTables, ENTITY_TO_TARGET and UUID_RE stay exported (re-exported by
// routes/tags.js) because resources.js, admin/curatedData.js and
// permissions/grid.js import them from ./tags.js. No behaviour change.

export const useSql = process.env.USE_SQL === 'true';

export let db = null;
if (useSql) {
  db = await import('../../db/connection.js');
}

// ─── Auto-create tag tables if they don't exist ──────────────────
// In v5 the tags + tag-assignments tables are created by the migrations
// runner at startup. This function is a no-op kept for backward compatibility.
let tablesReady = false;
export async function ensureTagTables(_pool) { tablesReady = true; }

export const ENTITY_TO_TARGET = { user: 'Principal', group: 'Resource', resource: 'Resource', identity: 'Identity' };
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Build parameterized WHERE clause from filters object.
//
// Two kinds of filter keys are accepted:
//   - Real column names — validated against `validColNames` to prevent SQL
//     injection via field names, emitted as `alias."col"::text = @param`.
//   - `ext.<key>` — filters on a scalar value inside the `extendedAttributes`
//     JSONB column. The suffix must match FILTER_KEY_RE so it's safe to
//     inline (we can't parameter-bind a JSON path key). Emitted as
//     `alias."extendedAttributes"->>'key' = @param`.
const FILTER_KEY_RE = /^[a-zA-Z0-9_]+$/;
const EXT_PREFIX = 'ext.';

// Native form: returns { where, bindings } where `where` uses @name placeholders
// and `bindings` is the { name: value } map the caller feeds to bindNamedParams.
// Prefer this in migrated (native-pg) handlers.
export function buildFilterWhereNamed(filters, validColNames, alias, paramPrefix = 'fl') {
  let where = '';
  const bindings = {};
  let idx = 0;
  for (const [field, value] of Object.entries(filters)) {
    if (value == null || String(value) === '') continue;
    const paramName = `${paramPrefix}${idx}`;

    if (field.startsWith(EXT_PREFIX)) {
      const key = field.slice(EXT_PREFIX.length);
      if (!FILTER_KEY_RE.test(key)) continue;
      where += ` AND ${alias}."extendedAttributes"->>'${key}' = @${paramName}`;
      bindings[paramName] = String(value);
      idx++;
    } else if (validColNames.has(field)) {
      where += ` AND ${alias}."${field}"::text = @${paramName}`;
      bindings[paramName] = String(value);
      idx++;
    }
  }
  return { where, bindings };
}

// Legacy form kept for the tags handlers still on the mssql-compat request
// object: delegates to buildFilterWhereNamed and replays the bindings onto the
// request via .input(). Removed once tags/{crud,entities}.js are migrated (#663).
export function buildFilterWhere(requestObj, filters, validColNames, alias, paramPrefix = 'fl') {
  const { where, bindings } = buildFilterWhereNamed(filters, validColNames, alias, paramPrefix);
  for (const [name, value] of Object.entries(bindings)) requestObj.input(name, value);
  return where;
}

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

// Parse the pipe-delimited tag string emitted by the entity-list SQL
// (`id:name:color|id:name:color…`) into an array of tag objects. Tag IDs are
// UUID strings (v6). Empty/absent input yields []. Shared by tags/entities.js
// and resources.js (via the ./tags.js barrel).
export function parseTags(tagString) {
  if (!tagString) return [];
  return tagString.split('|').map(t => {
    const parts = t.split(':');
    return { id: parts[0], name: parts[1], color: parts[2] };
  });
}

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

// Build a parameterised WHERE fragment from a filter object, binding each value
// through the caller's `bind` (from createParams) so the fragment's $N slot into
// the enclosing query's positional params. Returns the SQL fragment string.
export function buildFilterWhere(filters, validColNames, alias, bind) {
  let where = '';
  for (const [field, value] of Object.entries(filters)) {
    if (value == null || String(value) === '') continue;

    if (field.startsWith(EXT_PREFIX)) {
      const key = field.slice(EXT_PREFIX.length);
      if (!FILTER_KEY_RE.test(key)) continue;
      where += ` AND ${alias}."extendedAttributes"->>'${key}' = ${bind(String(value))}`;
    } else if (validColNames.has(field)) {
      where += ` AND ${alias}."${field}"::text = ${bind(String(value))}`;
    }
  }
  return where;
}

// Safe ORDER BY builder for the paginated list endpoints (/api/users,
// /api/resources, /api/identities).
//
// The list pages sort a *column*, not the current page: the UI sends
// `?sort=<columnKey>&dir=<asc|desc>` and the server must order the full result
// set before it paginates (audit H-14 — the old client-side sort only reordered
// the 100 rows already on screen, so "top N" was wrong past page 1).
//
// Neither `sort` nor `dir` is ever interpolated into SQL: `sort` is looked up in
// a static per-endpoint allowlist that maps a column key to an already-quoted
// SQL column expression, and `dir` collapses to the literal `ASC`/`DESC`. An
// unknown column key (or an injection attempt) falls back to a fixed default.
//
// An allowlist entry is normally just the column expression and the direction is
// appended. When the entry needs the direction somewhere other than the end —
// a nullable column wanting `DESC NULLS LAST`, where "no value" must sort to the
// bottom whichever way the values run — it writes the {dir} placeholder itself
// and the direction is substituted there instead. Still no user input in SQL:
// the placeholder is expanded only inside an allowlisted, hand-written string.
const DIRECTION_PLACEHOLDER = '{dir}';
//
// @param {string|undefined} sort      column key from the query string
// @param {string|undefined} dir       'asc' | 'desc' (case-insensitive)
// @param {Record<string,string>} allowed  colKey -> quoted SQL column expression
// @param {string} [fallback]          full ORDER BY expression when sort is unknown
// @returns {string} e.g. `"displayName" DESC` — safe to interpolate into ORDER BY
export function buildOrderBy(sort, dir, allowed, fallback = '"displayName" ASC') {
  // Own keys only: an inherited name such as `constructor` or `toString` is not
  // a column (SEC-2026-09 L-15).
  const col = Object.hasOwn(allowed, sort) ? allowed[sort] : undefined;
  if (!col) return fallback;
  const direction = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return col.includes(DIRECTION_PLACEHOLDER)
    ? col.replaceAll(DIRECTION_PLACEHOLDER, direction)
    : `${col} ${direction}`;
}

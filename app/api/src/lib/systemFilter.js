// The virtual `__system` filter column shared by the Principals and Resources
// list pages.
//
// `systemId` is deliberately excluded from column discovery (db/columnCache.js)
// — surfacing it there would leak a raw integer into every filter surface built
// from discovery (matrix attribute picker, permissions grid, tags CRUD, the
// context-plugin attribute dropdown). Instead the list endpoints offer a
// virtual `__system` column whose values are `Systems.displayName`, and
// translate a selected name back into a systemId predicate here.
//
// Same shape as the `__userTag` / `__resourceTag` virtual columns: one helper
// adds the column to a discovery response, one pulls the key out of a parsed
// filters object, one renders the WHERE fragment.

import * as db from '../db/connection.js';

export const SYSTEM_FILTER_KEY = '__system';

// Every connected system's display name. Sourced from the `Systems` table
// rather than from distinct row values so a system with zero principals or
// resources is still offered as a filter value. DISTINCT because
// `Systems.displayName` has no UNIQUE constraint — two systems sharing a name
// should appear once in the dropdown (and both match, see systemFilterWhere).
export async function fetchSystemNames() {
  const r = await db.query(
    `SELECT DISTINCT "displayName" FROM "Systems"
      WHERE "displayName" IS NOT NULL AND "displayName" <> ''
      ORDER BY "displayName"`,
  );
  return r.rows.map(row => row.displayName);
}

// Add the virtual column to a { column: values } discovery map (mutates and
// returns it). On the `?schema=true` fast path the column is emitted with no
// values, matching how `__resourceTag` behaves there.
export async function addSystemColumn(grouped, { schemaOnly = false } = {}) {
  grouped[SYSTEM_FILTER_KEY] = schemaOnly ? [] : await fetchSystemNames();
  return grouped;
}

// Pull `__system` out of a parsed filters object (mutating it) so it isn't
// validated as a real column by buildFilterWhere. Returns the selected display
// name, or null when absent/blank.
export function extractSystemFilter(attrFilters) {
  if (!attrFilters || attrFilters[SYSTEM_FILTER_KEY] == null) return null;
  const name = String(attrFilters[SYSTEM_FILTER_KEY]).trim();
  delete attrFilters[SYSTEM_FILTER_KEY];
  return name || null;
}

// The WHERE fragment narrowing `alias` to rows whose system carries that
// display name, binding the name through the caller's `bind`. Two systems
// sharing a display name both match — the least-surprising reading of
// "System = X" given the column isn't unique.
export function systemFilterWhere(systemName, alias, bind) {
  if (!systemName) return '';
  return ` AND EXISTS (SELECT 1 FROM "Systems" _sys`
    + ` WHERE _sys.id = ${alias}."systemId" AND _sys."displayName" = ${bind(systemName)})`;
}

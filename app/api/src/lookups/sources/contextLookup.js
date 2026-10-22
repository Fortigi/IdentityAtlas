// A lookup source over a slice of the Contexts table — the picker a report's
// `contexts` parameter uses. resource-contexts.js (contexts of resources, for
// the Entitlement Pivot) and unit-contexts.js (organisational units of
// accounts or people, for the unit report) are two slices of the same picker:
// same search, same hint, same id resolution; only the WHERE differs.
//
// The hint is what makes a picker worth having. A catalogue that grew over
// years holds several contexts under one name; type, size and source system
// tell them apart before the choice is made, and the id the picker stores makes
// the choice unambiguous either way.

import * as db from '../../db/connection.js';
import { escapeLike } from '../../db/sqlParams.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One context row -> one option. Type first, because "Tag" and "Department"
// with the same name are different things; then size, the fact that separates a
// real application from an empty or duplicated one.
function toOption(row) {
  const parts = [row.contextType, `${Number(row.members || 0).toLocaleString('en-US')} members`];
  if (row.systemName) parts.push(row.systemName);
  return { value: row.id, label: row.displayName, hint: parts.filter(Boolean).join(' · ') };
}

const SELECT = `SELECT c.id, c."displayName", c."contextType", c."directMemberCount" AS members,
                       s."displayName" AS "systemName"
                  FROM "Contexts" c
                  LEFT JOIN "Systems" s ON s.id = c."scopeSystemId"`;

/**
 * A lookup source named `name` over the contexts `where` (a constant SQL
 * predicate on `c`) selects.
 */
export function contextLookup({ name, displayName, where }) {
  return {
    name,
    displayName,

    // Biggest first, so an empty box offers the contexts somebody is most likely
    // to be after, and an empty root sinks to the bottom without being
    // special-cased. `%` and `_` are escaped: a search for "a_b" means "a_b".
    async search({ q = '', limit = 20 }) {
      const { rows } = await db.query(
        `${SELECT}
          WHERE ${where}
            AND ($1 = '' OR c."displayName" ILIKE '%' || $1 || '%' ESCAPE '\\')
          ORDER BY c."directMemberCount" DESC NULLS LAST, c."displayName"
          LIMIT $2`,
        [escapeLike(q), limit]);
      return rows.map(toOption);
    },

    // Stored ids back into labels, so a bookmarked report shows the contexts it
    // is about. Anything that is not a uuid is dropped rather than sent to
    // postgres, which would fail the whole statement on one bad value — a
    // parameter may still hold a name typed by hand before the picker existed.
    async resolve({ ids = [] }) {
      const valid = ids.filter(id => UUID.test(String(id)));
      if (valid.length === 0) return [];
      const { rows } = await db.query(`${SELECT} WHERE c.id = ANY($1::uuid[]) AND ${where}`, [valid]);
      return rows.map(toOption);
    },
  };
}

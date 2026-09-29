// Lookup source: the logical applications an access review is held over.
//
// A logical application is a Context (`contextType='LogicalApplication'`,
// `targetType='Resource'`) — see docs/architecture/context-redesign.md.
//
// The hint is what makes this worth having. A catalogue that grew over years
// holds several contexts under one name, and until the picker existed the only
// way to find that out was to run the report and read the warning. Size and
// source system tell them apart before the choice is made, and the id the
// picker stores makes the choice unambiguous either way.

import * as db from '../../db/connection.js';

const CONTEXT_TYPE = 'LogicalApplication';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `%` and `_` are ILIKE wildcards. A search for "a_b" must mean "a_b", not
// "a<anything>b" — otherwise a name with an underscore in it (most entitlement
// catalogues) matches almost everything and the list is useless.
function escapeLike(text) {
  return text.replace(/[\\%_]/g, ch => `\\${ch}`);
}

// One catalogue row -> one option. Size first, because it is the fact that
// separates a real application from an empty or duplicated one.
function toOption(row) {
  const parts = [`${Number(row.members || 0).toLocaleString('en-US')} members`];
  if (row.systemName) parts.push(row.systemName);
  return { value: row.id, label: row.displayName, hint: parts.join(' · ') };
}

const SELECT = `SELECT c.id, c."displayName", c."directMemberCount" AS members,
                       s."displayName" AS "systemName"
                  FROM "Contexts" c
                  LEFT JOIN "Systems" s ON s.id = c."scopeSystemId"`;

export default {
  name: 'logical-applications',
  displayName: 'Logical applications',

  // Biggest first, so an empty box offers the applications somebody is most
  // likely to be reviewing, and a catalogue's empty root sinks to the bottom
  // without being special-cased.
  async search({ q = '', limit = 20 }) {
    const { rows } = await db.query(
      `${SELECT}
        WHERE c."contextType" = $1 AND c."targetType" = 'Resource'
          AND ($2 = '' OR c."displayName" ILIKE '%' || $2 || '%' ESCAPE '\\')
        ORDER BY c."directMemberCount" DESC NULLS LAST, c."displayName"
        LIMIT $3`,
      [CONTEXT_TYPE, escapeLike(q), limit]);
    return rows.map(toOption);
  },

  // Stored ids back into labels, so a bookmarked report shows the applications
  // it is about. Anything that is not a uuid is dropped rather than sent to
  // postgres, which would fail the whole statement on one bad value — a
  // parameter may still hold a name typed by hand before the picker existed.
  async resolve({ ids = [] }) {
    const valid = ids.filter(id => UUID.test(String(id)));
    if (valid.length === 0) return [];
    const { rows } = await db.query(
      `${SELECT} WHERE c.id = ANY($1::uuid[]) AND c."contextType" = $2`,
      [valid, CONTEXT_TYPE]);
    return rows.map(toOption);
  },
};

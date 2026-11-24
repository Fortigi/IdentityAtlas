// One team member's ungoverned permissions, by name — what the count in the team
// overview (contexts/teamOverview.js) is made of, by the very same definition
// (IS_UNGOVERNED), so the list always adds up to the number that opened it.

import { IS_UNGOVERNED, TEAM_ACCOUNTS_SQL, TEAM_SCOPE_CTES } from './teamOverview.js';

export const MAX_UNGOVERNED = 500;

// $1 member ids, $2 account ids, $3 person ids (parallel arrays), $4 row cap.
export const UNGOVERNED_SQL = `
    WITH RECURSIVE ${TEAM_SCOPE_CTES}
    SELECT r.id, r."displayName", r."resourceType", h.direct, h.indirect
      FROM held h
      JOIN "Resources" r ON r.id = h."resourceId" AND r."deletedAt" IS NULL AND NOT r."governanceResource"
     WHERE ${IS_UNGOVERNED}
     ORDER BY r."displayName", r.id
     LIMIT $4`;

// The strongest way it is held: directly, else inherited, else only eligible.
function howHeld(row) {
  if (row.direct) return 'Direct';
  return row.indirect ? 'Indirect' : 'Eligible';
}

/** The rows as the API answers them, cut at `cap`. Pure. */
export function toUngoverned(rows, cap = MAX_UNGOVERNED) {
  return {
    items: rows.slice(0, cap).map(r => ({ id: r.id, displayName: r.displayName, resourceType: r.resourceType, how: howHeld(r) })),
    truncated: rows.length > cap,
  };
}

export async function loadUngoverned(db, memberId) {
  const accounts = (await db.query(TEAM_ACCOUNTS_SQL, [[memberId]])).rows;
  if (!accounts.length) return { items: [], truncated: false };
  const { rows } = await db.query(UNGOVERNED_SQL, [
    accounts.map(a => a.memberId), accounts.map(a => a.accountId), accounts.map(a => a.identityId), MAX_UNGOVERNED + 1,
  ]);
  return toUngoverned(rows);
}

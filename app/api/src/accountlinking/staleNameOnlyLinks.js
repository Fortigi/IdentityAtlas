// Identity Atlas — retroactive cleanup for the name-only corroboration guard.
//
// The engine no longer creates a link that rests on name signals alone, but it
// has never removed a link either — so every name-only link made before the
// guard existed would stay attached forever, which is the exact data the guard
// was introduced to prevent. A run under the guard therefore first detaches the
// ones it would no longer create, so they rejoin the orphan pool and re-score in
// the same run: corroborated accounts re-link, uncorroborated ones become
// suggestions.
//
// Only the engine's own guesses are touched. Two kinds of row are never:
//   - analyst-touched rows (`analystOverride` set) — a decision outranks a rule,
//   - crawler-sourced rows (`linkConfidence IS NULL`) — the source system knows
//     the account belongs to the person; it is not a score.
// These are the same exclusions the crawler's reconcile already honours.

import * as db from '../db/connection.js';
import { nameSignalNames, isNameOnly, parseLinkSignals } from './engine.helpers.js';

/**
 * Detach every engine-scored, analyst-untouched member row whose recorded
 * signals are all name signals, and recompute `accountCount` for the identities
 * that lost an account.
 *
 * @param {object} rules the active rule set (its name signals define "name-only")
 * @returns {Promise<number>} how many member rows were removed
 */
export async function removeStaleNameOnlyLinks(rules) {
  const nameSigs = nameSignalNames(rules);
  if (nameSigs.size === 0) return 0; // no name signals configured → nothing qualifies

  // Selection is done in JS: linkSignals is a JSONB string of CSV, so "is every
  // recorded signal a name signal" is not expressible as a sargable predicate.
  const { rows } = await db.query(`
    SELECT "identityId", "principalId", "linkSignals"
      FROM "IdentityMembers"
     WHERE "linkConfidence" IS NOT NULL
       AND "analystOverride" IS NULL
  `);
  const stale = rows.filter(r => isNameOnly(parseLinkSignals(r.linkSignals), nameSigs));
  if (stale.length === 0) return 0;

  for (const row of stale) {
    await db.query(
      `DELETE FROM "IdentityMembers" WHERE "identityId" = $1 AND "principalId" = $2`,
      [row.identityId, row.principalId]
    );
  }
  for (const identityId of new Set(stale.map(r => r.identityId))) {
    await db.query(`
      UPDATE "Identities"
         SET "accountCount" = (SELECT COUNT(*)::int FROM "IdentityMembers" WHERE "identityId" = $1)
       WHERE "id" = $1
    `, [identityId]);
  }
  return stale.length;
}

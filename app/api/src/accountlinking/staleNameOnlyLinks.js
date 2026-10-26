// Identity Atlas — retroactive cleanup for the name-only guard.
//
// The guard decides what the engine creates, but it has never removed a link
// either — so a name-only link made before the guard existed would stay attached
// forever, which is the exact data the guard was introduced to prevent. A run
// therefore first detaches the name-only links it would no longer create, so
// they rejoin the orphan pool and re-score in the same run: a name that still
// points at one person re-links, the rest become held-for-review matches.
//
// Which links those are follows the active policy:
//   - the shipped policy  — only the links whose account name no longer points
//     at the identity it is attached to: a namesake, or a near-identical name
//     shared with a second person (#1440). A link on a name unique to one person
//     is left exactly where it is, so an upgrade churns nothing it needn't.
//   - allowNameOnlyLinks: false — every name-only link, because under that
//     policy the engine would create none of them.
//
// Only the engine's own guesses are touched. Three kinds of row are never:
//   - analyst-touched rows (`analystOverride` set) — a decision outranks a rule,
//   - crawler-sourced rows (`linkConfidence IS NULL`) — the source system knows
//     the account belongs to the person; it is not a score,
//   - rows on an account a sync has removed (`deletedAt` set) — the orphan pool
//     is live rows only, so a detached link there can never re-score. Deleting
//     it costs the identity its trail to the account and every grant on it, with
//     nothing to correct it to and no held-for-review record to act on; #1442
//     keeps such a link as history (#1461).
// These are the same exclusions the crawler's reconcile already honours.

import * as db from '../db/connection.js';
import {
  nameSignalNames, isNameOnly, parseLinkSignals, indexIdentities, nameClaim, loginPrefixesFrom,
} from './engine.helpers.js';

/**
 * Which of the name-only links the active policy would no longer create.
 * The indexes are built once for the whole set, not once per row.
 *
 * The question is put to `nameClaim` on the same terms the engine put it, login
 * included (#1454) — a link the engine made because the account's login spells
 * exactly one person's name would otherwise be read as resting on a name that
 * points at nobody, detached, and re-created by the same run, forever.
 */
function staleUnder(rules, nameOnly, identities) {
  if (rules.allowNameOnlyLinks === false) return nameOnly;
  const indexes = indexIdentities(identities);
  const opts = { loginPrefixes: loginPrefixesFrom(rules) };
  return nameOnly.filter(r => nameClaim(r, indexes, opts).sole?.id !== r.identityId);
}

/**
 * Detach the engine-scored, analyst-untouched member rows whose recorded signals
 * are all name signals and which the active policy would no longer create, and
 * recompute `accountCount` for the identities that lost an account.
 *
 * @param {object} rules the active rule set (its name signals define "name-only")
 * @param {object[]} identities every identity, as loaded by the run — the name
 *   indexes are built from these, so a partial list would read unique names as
 *   ambiguous and detach links that are fine
 * @returns {Promise<number>} how many member rows were removed
 */
export async function removeStaleNameOnlyLinks(rules, identities) {
  const nameSigs = nameSignalNames(rules);
  if (nameSigs.size === 0) return 0; // no name signals configured → nothing qualifies

  // Selection is done in JS: linkSignals is a JSONB string of CSV, so "is every
  // recorded signal a name signal" is not expressible as a sargable predicate.
  // The account's own name comes along for the uniqueness question below — its
  // login included, which is one of the names that question is asked of.
  const { rows } = await db.query(`
    SELECT m."identityId", m."principalId", m."linkSignals",
           p."displayName", p."givenName", p."surname", p."email"
      FROM "IdentityMembers" m
      JOIN "Principals" p ON p."id" = m."principalId"
     WHERE m."linkConfidence" IS NOT NULL
       AND m."analystOverride" IS NULL
       AND p."deletedAt" IS NULL
  `);
  const nameOnly = rows.filter(r => isNameOnly(parseLinkSignals(r.linkSignals), nameSigs));
  if (nameOnly.length === 0) return 0;

  const stale = staleUnder(rules, nameOnly, identities);
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

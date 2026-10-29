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
//   - the shipped policy  — only the links nothing still settles on the identity
//     they are attached to: a namesake, or a near-identical name shared with a
//     second person (#1440), with no department or manager singling one of them
//     out either (#1455). A link the name, or the evidence beside it, still
//     points at is left exactly where it is, so an upgrade churns nothing it
//     needn't.
//   - allowNameOnlyLinks: false — every name-only link, because under that
//     policy the engine would create none of them.
//   - a signal switched off — the links that rested on it. Weight 0 is the
//     dictionary's off-switch, but until #1455 it only ever switched a signal
//     off for *new* matches: staleness was judged by uniqueness alone, and the
//     uniqueness reading counted name keys and login forms whatever their
//     weight, so a link on a login that still named one person was never stale.
//     Zeroing `loginNameForm` therefore changed nothing about the 13 links it
//     had already made. Both halves are fixed: the reading now ignores a rung
//     the dictionary no longer scores (`activeNameRungs`), and a link resting on
//     nothing it still scores is stale outright.
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
  nameSignalNames, nameSignalLevels, activeNameRungs, isNameOnly, parseLinkSignals,
  indexIdentities, loginPrefixesFrom,
} from './engine.helpers.js';
import { nameClaim } from './nameClaim.js';
import { guardEvidence, weighEvidence } from './guardEvidence.js';
import { MANAGER_IDENTITY_ID_SQL } from './orphanQuery.js';

/**
 * Whether a link rests on nothing the dictionary still scores.
 *
 * The test is put to the signals that *carry* the match — the name rungs and the
 * login form, plus any signal the dictionary no longer defines at all — and not
 * to the corroborating evidence beside them (`nameUnique`, `department`,
 * `manager`), which never stands on its own: each says the name singled somebody
 * out, so re-weighting one alone must not detach a link whose name still points
 * at its one person (P7). Confidence is what a weight changes; whether the
 * account belongs to the person is what uniqueness answers, and the two are
 * deliberately not the same question.
 *
 * @param {string[]} signals the link's recorded `linkSignals`
 * @param {Map<string, string>} levels `nameSignalLevels` for the active rules
 * @param {(name: string) => number|undefined} weightOf the active weight, or
 *   undefined for a signal the dictionary does not define
 */
function restsOnNothingScored(signals, levels, weightOf) {
  const bearing = signals.filter(s => levels.has(s) || weightOf(s) === undefined);
  return bearing.length > 0 && bearing.every(s => !weightOf(s));
}

/**
 * Who the account's name — and the evidence beside it — still settles on, which
 * is the same pair of questions the engine asked when it made the link, in the
 * same order (see `buildLinkForOrphan`).
 *
 * The evidence half is why this is not simply `sole`. A name two people answer to
 * is settled by a department or a manager that singles one of them out, so a
 * reading that stops at the name sees such a link resting on a name that points
 * at nobody, detaches it, and the same run re-creates it from the orphan pool —
 * every run, for ever. Only a live database shows that: every mocked case gives
 * each name one claimant, where the two readings cannot differ.
 *
 * The engine weighs the evidence over the claimants that also tie for the best
 * score. A cleanup cannot re-score, so it weighs it over every claimant: the
 * wider set keeps a link the guard could have made rather than churning one it
 * would, and the engine stays the only authority on what a run creates.
 *
 * @returns {string|undefined} the identity the evidence settles on, if any
 */
function settledOn(row, indexes, opts, evidence) {
  const { sole, claimants } = nameClaim(row, indexes, opts);
  return weighEvidence(row, claimants, sole, evidence).identity?.id;
}

/**
 * Which of the name-only links the active policy would no longer create.
 * The indexes are built once for the whole set, not once per row.
 *
 * The question is put to `nameClaim` on the same terms the engine put it — login
 * included (#1454), and only at the rungs the dictionary still scores (#1455).
 * Asked without the login, a link the engine made because the account's login
 * spells exactly one person's name would be read as resting on a name that
 * points at nobody, detached, and re-created by the same run, forever.
 */
function staleUnder(rules, nameOnly, identities) {
  if (rules.allowNameOnlyLinks === false) return nameOnly;
  const indexes = indexIdentities(identities);
  const opts = { loginPrefixes: loginPrefixesFrom(rules), activeRungs: activeNameRungs(rules) };
  const levels = nameSignalLevels(rules);
  const weights = new Map((rules.signals || []).map(s => [s.name, s.weight || 0]));
  const weightOf = (name) => weights.get(name);
  const evidence = guardEvidence(rules);
  return nameOnly.filter(r =>
    restsOnNothingScored(parseLinkSignals(r.linkSignals), levels, weightOf)
    || settledOn(r, indexes, opts, evidence) !== r.identityId);
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
  // login included, which is one of the names that question is asked of — and so
  // does the context the guard settles a shared name on (#1455), because a link
  // the department or the manager settled is not stale and cannot be judged
  // without them.
  const { rows } = await db.query(`
    SELECT m."identityId", m."principalId", m."linkSignals",
           p."displayName", p."givenName", p."surname", p."email", p."department",
           ${MANAGER_IDENTITY_ID_SQL}
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

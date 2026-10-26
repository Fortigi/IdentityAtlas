// Identity Atlas — Account Linking engine (deterministic, no LLM).
//
// Replaces the v4 PowerShell "account correlation" job that was never ported
// to v5. Account linking is top-down: for each existing Identity, find orphan
// accounts (live Principals with no IdentityMembers row) that belong to that
// person — admin (`adm-jdoe`), guest, or a plain secondary account — and attach
// them with a confidence score.
//
//   - Candidate scope: ONLY orphan Principals, as orphanQuery.js defines them —
//     live accounts attached to no Identity. Accounts already attached to an
//     Identity (e.g. by the crawler's IdentityFilter) are never disturbed, and
//     neither are accounts a full sync has removed: an account linked before it
//     was deleted stays linked (history), but a tombstone is never newly
//     attached and never counted as a remaining orphan.
//   - Matching is deterministic rule application against a dictionary
//     (defaultRules.js, editable via AccountLinkingConfig.rules). No LLM.
//   - A match resting on name signals alone links only where the account's name
//     points at exactly one person; a name a second person answers to is held
//     for review on the run instead (the name-uniqueness guard below).
//   - Analyst decisions win: a member with any analystOverride is never
//     overwritten, and an account the analyst marked 'rejected' is never
//     re-linked.
//   - After linking, the leftover orphans are emitted as the "Orphaned
//     Accounts" generated Context via the orphaned-accounts plugin.
//
// runLinking(runId, configId) mirrors riskscoring/engine.js runScoring: it
// updates an AccountLinkingRuns row as it progresses and runs in the background
// while the HTTP route returns the run id.

import * as db from '../db/connection.js';
import { enqueueRun } from '../contexts/plugins/runner.js';
import { DEFAULT_RULES } from './defaultRules.js';
import { effectiveLinkingRules } from './rulesMerge.js';
import {
  classifyAccount,
  compileAccountTypeRules,
  normalizeName,
  emailLocalPart,
  stripKnownPrefixes,
} from './classifier.js';
import { ORPHAN_QUERY_PARAMS, orphanPrincipalsSql } from './orphanQuery.js';
import {
  norm,
  fullName,
  strongestNameRung,
  prefixesFrom,
  suffixesFrom,
  loginPrefixesFrom,
  nameSignalNames,
  nameSignalLevels,
  matchLevelOf,
  isNameOnly,
  indexIdentities,
  collectCandidates,
  nameClaim,
  sharedAtWeakerLevel,
  aggregateByIdentity,
} from './engine.helpers.js';
import { removeStaleNameOnlyLinks } from './staleNameOnlyLinks.js';

export { classifyAccount };

/**
 * How many held-back name-only matches a single run stores on its row. The
 * count (`nameOnlyMatches`) is always the true, uncapped number — the list is
 * capped so one run on a large tenant cannot write an unbounded document.
 */
export const MAX_NAME_ONLY_SUGGESTIONS = 500;

/**
 * How many rival identities one held-back match names. `rivalCount` is the true
 * number, so a long list of namesakes stays reportable without storing it.
 */
export const MAX_NAME_ONLY_RIVALS = 5;

/**
 * Score how strongly an orphan account belongs to an identity.
 * Sum of matched signal weights, capped at 100.
 * @returns {{ confidence: number, signals: string[] }}
 */
export function scoreMatch(orphan, identity, rules = DEFAULT_RULES) {
  const signals = [];
  let total = 0;
  // Compute the name-class rung once (lazily) — every signal reading a person's
  // name is mutually exclusive with the others, whether it reads it off the
  // account's display name or off its login: only the strongest rung fires.
  let rung;
  const getRung = () => {
    if (rung === undefined) rung = strongestNameRung(orphan, identity, rules);
    return rung;
  };
  for (const sig of (rules.signals || [])) {
    let matched = false;
    if (sig.type === 'exact') {
      const a = norm(orphan[sig.field]);
      const b = norm(identity[sig.field]);
      matched = !!a && a === b;
    } else if (sig.type === 'prefix') {
      const a = stripKnownPrefixes(emailLocalPart(orphan[sig.field]), sig.stripPrefixes || []);
      const b = emailLocalPart(identity[sig.field]);
      matched = !!a && a === b;
    } else if (sig.type === 'name') {
      matched = getRung() === sig.level;
    } else if (sig.type === 'loginName') {
      // The login read as a name rather than an address: it carries the person's
      // name in whatever form a provisioning convention writes it (#1454). One
      // weight for either form — a login that writes the whole name is better
      // evidence than one that writes an initial, but neither is near-certain,
      // and which of the two it is only decides who its rivals are (the
      // uniqueness guard reads that level itself).
      matched = getRung() === 'loginName';
    } else if (sig.type === 'fuzzy') { // legacy single-signal name match
      const suf = sig.stripSuffixes || [];
      const a = normalizeName(orphan[sig.field], suf) || fullName(orphan, suf);
      const b = normalizeName(identity[sig.field], suf) || fullName(identity, suf);
      matched = !!a && a === b;
    }
    if (matched) { total += (sig.weight || 0); signals.push(sig.name); }
  }
  return { confidence: Math.min(100, total), signals };
}

/**
 * Build the proposed account→identity links for a set of orphan principals.
 * Pure: no DB access.
 *
 * @returns {{ links: object[], stats: { nameOnlyMatches: number, suggestions: object[] } }}
 *   `links` holds one entry per orphan that links; `stats` reports the name-only
 *   matches that were held for review instead of linked — the true count, plus
 *   the matches themselves (up to the cap) so an analyst can see which account
 *   nearly linked to whom, on what evidence, and who else answers to the name.
 */
export function buildLinks(orphans, identities, rules = DEFAULT_RULES) {
  const ctx = {
    rules,
    threshold: rules.linkThreshold ?? DEFAULT_RULES.linkThreshold,
    onlyTypes: new Set(rules.onlyLinkTypes || []),
    compiled: { ...rules, __compiled: compileAccountTypeRules(rules) },
    prefixes: prefixesFrom(rules),
    suffixes: suffixesFrom(rules),
    loginPrefixes: loginPrefixesFrom(rules),
    nameSigs: nameSignalNames(rules),
    nameLevels: nameSignalLevels(rules),
    allowNameOnly: rules.allowNameOnlyLinks !== false,
    indexes: indexIdentities(identities),
  };

  const links = [];
  const suggestions = [];
  let nameOnlyMatches = 0;
  for (const orphan of orphans) {
    const outcome = buildLinkForOrphan(orphan, ctx);
    if (!outcome) continue;
    if (outcome.suggestion) {
      nameOnlyMatches += 1;
      if (suggestions.length < MAX_NAME_ONLY_SUGGESTIONS) suggestions.push(outcome.suggestion);
    }
    if (outcome.link) links.push(outcome.link);
  }
  return { links, stats: { nameOnlyMatches, suggestions } };
}

/**
 * Best above-threshold candidate identity for a set, and every above-threshold
 * candidate (which the name-uniqueness guard needs to see the ties). Candidates
 * are scored in insertion order; the first to reach the high-water mark wins.
 * @returns {{ best: object|null, scored: object[] }}
 */
function pickBest(orphan, candidates, rules, threshold) {
  const scored = [];
  let best = null;
  for (const idy of candidates.values()) {
    const { confidence, signals } = scoreMatch(orphan, idy, rules);
    if (confidence < threshold) continue;
    const candidate = { identityId: idy.id, identityName: idy.displayName ?? null, confidence, signals };
    scored.push(candidate);
    if (!best || confidence > best.confidence) best = candidate;
  }
  return { best, scored };
}

/**
 * The row to write for a scored candidate. `weakerLevelRival` is not stored on
 * the member row — the run reads it off the links it creates to report
 * `linksRestored` (see `sharedAtWeakerLevel`).
 */
function linkFrom(orphan, candidate, accountType, pattern, weakerLevelRival = false) {
  return {
    principalId: orphan.id,
    identityId: candidate.identityId,
    confidence: candidate.confidence,
    signals: candidate.signals,
    accountType,
    accountTypePattern: pattern,
    displayName: orphan.displayName ?? null,
    accountEnabled: orphan.accountEnabled ?? null,
    weakerLevelRival,
  };
}

/**
 * The held-for-review record of a name-only match: who nearly linked to whom,
 * on what evidence, why it was held, and who else answers to the name — which
 * is what makes the match reviewable rather than merely counted.
 *
 * `matchLevel` is the level the match itself rested on, and it is what makes the
 * rival list readable: at `full` the rivals are spelled exactly the account's
 * name, at `surnameInitial` they merely share its surname and first initial, and
 * calling both "answers to this name" sends the reviewer after a namesake who
 * does not exist. Recorded for either reason, since it describes the match and
 * not the hold.
 */
function suggestionFrom(orphan, candidate, accountType, reason, claimants, matchLevel) {
  const rivals = claimants.filter(c => c.id !== candidate.identityId);
  return {
    principalId: orphan.id,
    displayName: orphan.displayName ?? null,
    identityId: candidate.identityId,
    identityName: candidate.identityName,
    confidence: candidate.confidence,
    signals: candidate.signals,
    accountType,
    reason,
    matchLevel,
    rivals: rivals.slice(0, MAX_NAME_ONLY_RIVALS)
      .map(c => ({ identityId: c.id, identityName: c.displayName ?? null })),
    rivalCount: rivals.length,
  };
}

/**
 * Why a name-only match the name did not settle is being held, which is what
 * tells the reviewer what to do with it.
 *
 * `ambiguousName` is the usual answer: more than one person answers to the name,
 * or nobody does. `numberedLogin` is the one case with no rival to name — the
 * login is a *numbered* spelling of somebody's own address (`adm-skleef2` beside
 * the `skleef` mailbox), so the number says the account is not hers and nobody
 * else answers to the form it reduces to (#1468). Reported as ambiguity it would
 * send the reviewer looking for a namesake that does not exist.
 */
function holdReason(claimants, numberedAway) {
  return !claimants.length && numberedAway.length ? 'numberedLogin' : 'ambiguousName';
}

/**
 * What to do with a single orphan. Pure: no DB access.
 *
 * @returns {{ link: object|null, suggestion: object|null }|null}
 *   null when nothing cleared the threshold (or the account type is not linked
 *   at all); otherwise exactly one of `link` (the row to write) and `suggestion`
 *   (the match a guard held for review) is set.
 */
function buildLinkForOrphan(orphan, ctx) {
  const { rules, threshold, onlyTypes, compiled, prefixes, suffixes, loginPrefixes,
    nameSigs, nameLevels, allowNameOnly, indexes } = ctx;
  const { accountType, pattern } = classifyAccount(orphan, compiled);
  if (!onlyTypes.has(accountType)) return null;

  const candidates = collectCandidates(orphan, indexes, { prefixes, suffixes, loginPrefixes });
  const { best, scored } = pickBest(orphan, candidates, rules, threshold);
  if (!best) return null;
  if (!isNameOnly(best.signals, nameSigs)) {
    return { link: linkFrom(orphan, best, accountType, pattern), suggestion: null };
  }

  // The name-uniqueness guard. A match resting on name signals alone links only
  // where the account's name points at exactly one person (see nameClaim): a
  // name a second person answers to at the level the match rests on is no
  // evidence of which of them the account belongs to, and the wrong one then
  // inherits that person's access review, risk score and leaver handling. Those
  // matches are held for review instead.
  //
  // The person the name points at has to be one of the top-scoring candidates
  // to win: a name that singles out somebody the score ranks lower settles
  // nothing. `allowNameOnlyLinks: false` holds back every name-only match, even
  // an unambiguous one, for a tenant that wants a name to never be enough.
  const { sole, claimants, numberedAway } = nameClaim(orphan, indexes, { loginPrefixes });
  const resolved = sole
    ? scored.find(s => s.identityId === sole.id && s.confidence === best.confidence)
    : null;
  const winner = resolved ?? best;
  if (resolved && allowNameOnly) {
    const link = linkFrom(orphan, winner, accountType, pattern, sharedAtWeakerLevel(orphan, indexes));
    return { link, suggestion: null };
  }
  const reason = resolved ? 'uncorroborated' : holdReason(claimants, numberedAway);
  const matchLevel = matchLevelOf(winner.signals, nameLevels);
  return { link: null, suggestion: suggestionFrom(orphan, winner, accountType, reason, claimants, matchLevel) };
}

async function loadRules(configId) {
  let row = null;
  try {
    row = configId
      ? await db.queryOne(`SELECT "rules" FROM "AccountLinkingConfig" WHERE id = $1`, [configId])
      : await db.queryOne(`SELECT "rules" FROM "AccountLinkingConfig" WHERE "isActive" = true ORDER BY "updatedAt" DESC LIMIT 1`);
  } catch { /* table may not exist yet on a partially-migrated DB */ }
  // A saved row is an override of the shipped dictionary, not a replacement:
  // signals are merged by name so a signal shipped after the tenant last saved
  // still fires for them (#1469).
  return effectiveLinkingRules(row?.rules);
}

async function countOrphans() {
  const r = await db.queryOne(orphanPrincipalsSql(`COUNT(*)::int AS n`), ORPHAN_QUERY_PARAMS);
  return r?.n ?? 0;
}

/**
 * Persist one proposed link while preserving analyst decisions.
 * @returns {'skipped'|'created'|'updated'}
 *   - 'skipped'  the account was rejected anywhere, or the member is analyst-touched
 *   - 'created'  no member row existed → inserted
 *   - 'updated'  a non-analyst member row existed → refreshed
 */
async function writeLink(link) {
  // Never re-link an account the analyst rejected (from any identity).
  const rejected = await db.queryOne(
    `SELECT 1 FROM "IdentityMembers" WHERE "principalId" = $1 AND "analystOverride" = 'rejected' LIMIT 1`,
    [link.principalId]
  );
  if (rejected) return 'skipped';

  const existing = await db.queryOne(
    `SELECT "analystOverride" FROM "IdentityMembers" WHERE "identityId" = $1 AND "principalId" = $2`,
    [link.identityId, link.principalId]
  );
  if (!existing) {
    await db.query(`
      INSERT INTO "IdentityMembers"
        ("identityId", "principalId", "isPrimary", "accountType", "accountTypePattern",
         "accountEnabled", "displayName", "linkSignals", "linkConfidence")
      VALUES ($1, $2, false, $3, $4, $5, $6, $7, $8)
      ON CONFLICT ("identityId", "principalId") DO NOTHING
    `, [link.identityId, link.principalId, link.accountType, link.accountTypePattern,
        link.accountEnabled, link.displayName, JSON.stringify(link.signals.join(',')), link.confidence]);
    return 'created';
  }
  if (existing.analystOverride) return 'skipped'; // analyst-touched → leave it
  await db.query(`
    UPDATE "IdentityMembers"
       SET "linkConfidence" = $3, "linkSignals" = $4, "accountType" = $5,
           "accountTypePattern" = $6, "displayName" = $7, "accountEnabled" = $8
     WHERE "identityId" = $1 AND "principalId" = $2
  `, [link.identityId, link.principalId, link.confidence, JSON.stringify(link.signals.join(',')),
      link.accountType, link.accountTypePattern, link.displayName, link.accountEnabled]);
  return 'updated';
}

/**
 * Main entry point. Marks an AccountLinkingRuns row running, links orphan
 * accounts to identities, refreshes the Orphaned Accounts context, and records
 * counts. Returns when complete.
 */
// Start a run: insert the run row + fire the engine in the background (mirrors
// POST /account-linking/runs). Shared by the route and the post-crawl auto-run.
// `onlyIfConfigured` skips when no active config exists, so the crawl hook does
// not run linking on installs that don't use it.
export async function startAccountLinkingRun(triggeredBy = 'system', { onlyIfConfigured = false, awaitCompletion = false } = {}) {
  const cfg = await db.queryOne(
    `SELECT id FROM "AccountLinkingConfig" WHERE "isActive" = true ORDER BY "updatedAt" DESC LIMIT 1`);
  if (onlyIfConfigured && !cfg) return null;
  const configId = cfg?.id ?? null;
  const run = await db.queryOne(
    `INSERT INTO "AccountLinkingRuns" ("configId", status, step, pct, "triggeredBy")
     VALUES ($1, 'pending', 'Queued', 0, $2) RETURNING *`,
    [configId, triggeredBy]);
  if (awaitCompletion) {
    try { await runLinking(run.id, configId); } catch (err) { console.error(`account-linking run ${run.id} failed:`, err.message); }
  } else {
    runLinking(run.id, configId).catch((err) =>
      console.error(`Background account-linking run ${run.id} crashed:`, err));
  }
  return run;
}

export async function runLinking(runId, configId = null) {
  const updateRun = async (fields) => {
    const set = Object.keys(fields).map((k, i) => `"${k}" = $${i + 2}`).join(', ');
    await db.query(`UPDATE "AccountLinkingRuns" SET ${set} WHERE id = $1`, [runId, ...Object.values(fields)]);
  };

  try {
    await updateRun({ status: 'running', step: 'Loading rules', pct: 5 });
    const rules = await loadRules(configId);

    await updateRun({ step: 'Loading identities', pct: 10 });
    const identities = (await db.query(`
      SELECT i."id", i."displayName", i."email", i."employeeId", i."givenName", i."surname"
        FROM "Identities" i
    `)).rows;

    // Detach the name-only links the engine would no longer make, before the
    // orphan pool is read: they rejoin it below and re-score in this same run,
    // so one that still links does so immediately and one that no longer does
    // becomes a held-for-review match.
    await updateRun({ step: 'Reviewing existing name-only links', pct: 15 });
    const linksRemoved = await removeStaleNameOnlyLinks(rules, identities);

    await updateRun({ step: 'Loading orphan accounts', pct: 20 });
    const orphans = (await db.query(orphanPrincipalsSql(
      `p."id", p."displayName", p."email", p."employeeId", p."givenName", p."surname",
       p."accountEnabled", p."extendedAttributes"`,
    ), ORPHAN_QUERY_PARAMS)).rows;

    await updateRun({ step: 'Matching accounts', pct: 45, candidatesScanned: orphans.length });
    const { links, stats } = buildLinks(orphans, identities, rules);

    await updateRun({ step: 'Writing links', pct: 70 });
    const counts = { created: 0, updated: 0, skipped: 0 };
    // Links this run newly attached on a name somebody else shares only at the
    // weaker surname + initial level: the class the pre-#1460 reading held for
    // review and detached on sight. Counting only the *created* ones means the
    // figure reports the one-off restore and then settles back to zero, instead
    // of re-reporting the same links as restored on every subsequent run.
    let linksRestored = 0;
    for (const link of links) {
      const outcome = await writeLink(link);
      counts[outcome] += 1;
      if (outcome === 'created' && link.weakerLevelRival) linksRestored += 1;
    }
    const { created, updated, skipped } = counts;

    await updateRun({ step: 'Refreshing identity aggregates', pct: 85 });
    // Per-identity rollup: confidence = best newly-linked account, signals =
    // distinct union (stored CSV so the detail page's .split(',') keeps working).
    const byIdentity = aggregateByIdentity(links);
    for (const [identityId, g] of byIdentity) {
      await db.query(`
        UPDATE "Identities"
           SET "accountCount" = (SELECT COUNT(*)::int FROM "IdentityMembers" WHERE "identityId" = $1),
               "linkConfidence" = $2,
               "linkSignals" = $3,
               "linkedAt" = now() AT TIME ZONE 'utc'
         WHERE "id" = $1
      `, [identityId, g.conf, JSON.stringify([...g.signals].join(','))]);
    }

    await updateRun({ step: 'Building Orphaned Accounts context', pct: 92 });
    // Fire the orphaned-accounts context plugin; it reconciles its own context.
    // Non-fatal — a missing registration must not fail the linking run.
    try { await enqueueRun('orphaned-accounts', {}, 'account-linking'); }
    catch (e) { console.warn(`account-linking: could not enqueue orphaned-accounts: ${e.message}`); }

    const orphansRemaining = await countOrphans();
    await updateRun({
      status: 'completed', step: 'Done', pct: 100,
      linksCreated: created, linksUpdated: updated, skippedAnalystOverride: skipped,
      orphansRemaining,
      nameOnlyMatches: stats.nameOnlyMatches,
      linksRemoved,
      linksRestored,
      nameOnlySuggestions: JSON.stringify(stats.suggestions),
    });
    await db.query(`UPDATE "AccountLinkingRuns" SET "completedAt" = now() AT TIME ZONE 'utc' WHERE id = $1`, [runId]);
  } catch (err) {
    console.error('account-linking run failed:', err);
    try {
      await updateRun({ status: 'failed', step: 'Failed', errorMessage: (err.message || String(err)).slice(0, 2000) });
      await db.query(`UPDATE "AccountLinkingRuns" SET "completedAt" = now() AT TIME ZONE 'utc' WHERE id = $1`, [runId]);
    } catch { /* swallow */ }
    throw err;
  }
}

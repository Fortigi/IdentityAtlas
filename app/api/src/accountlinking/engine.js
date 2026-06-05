// Identity Atlas — Account Linking engine (deterministic, no LLM).
//
// Replaces the v4 PowerShell "account correlation" job that was never ported
// to v5. Account linking is top-down: for each existing Identity, find orphan
// accounts (Principals with no IdentityMembers row) that belong to that person
// — admin (`adm-jdoe`), guest, or a plain secondary account — and attach them
// with a confidence score.
//
//   - Candidate scope: ONLY orphan Principals. Accounts already attached to an
//     Identity (e.g. by the crawler's IdentityFilter) are never disturbed.
//   - Matching is deterministic rule application against a dictionary
//     (defaultRules.js, editable via AccountLinkingConfig.rules). No LLM.
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
import {
  classifyAccount,
  compileAccountTypeRules,
  normalizeName,
  emailLocalPart,
  stripKnownPrefixes,
  parseName,
  nameMatchLevel,
} from './classifier.js';

export { classifyAccount };

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());
const fullName = (o, suffixes = []) => normalizeName([o.givenName, o.surname].filter(Boolean).join(' '), suffixes);
const personName = (o) => parseName(o.displayName, o.givenName, o.surname);

function prefixesFrom(rules) {
  return (rules.signals || []).find(s => s.type === 'prefix')?.stripPrefixes || [];
}
function suffixesFrom(rules) {
  return (rules.signals || []).find(s => s.type === 'fuzzy')?.stripSuffixes || [];
}
function nameSignalNames(rules) {
  return new Set((rules.signals || []).filter(s => s.type === 'name').map(s => s.name));
}

/**
 * Score how strongly an orphan account belongs to an identity.
 * Sum of matched signal weights, capped at 100.
 * @returns {{ confidence: number, signals: string[] }}
 */
export function scoreMatch(orphan, identity, rules = DEFAULT_RULES) {
  const signals = [];
  let total = 0;
  // Compute the name-match level once (lazily) — name signals are mutually
  // exclusive: only the signal whose level equals the computed best level fires.
  let level;
  const getLevel = () => {
    if (level === undefined) level = nameMatchLevel(personName(orphan), personName(identity));
    return level;
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
      matched = getLevel() === sig.level;
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
 * Pure: no DB access. Returns one entry per orphan that links above threshold.
 */
export function buildLinks(orphans, identities, rules = DEFAULT_RULES) {
  const threshold = rules.linkThreshold ?? 70;
  const onlyTypes = new Set(rules.onlyLinkTypes || []);
  const compiled = { ...rules, __compiled: compileAccountTypeRules(rules) };
  const prefixes = prefixesFrom(rules);
  const suffixes = suffixesFrom(rules);
  const nameSigs = nameSignalNames(rules);

  // Index identities so we only score plausible candidates per orphan.
  const byEmployeeId = new Map();
  const byEmailLocal = new Map();
  const byName = new Map();
  const byNameKey = new Map();
  const push = (map, key, v) => { if (!key) return; (map.get(key) || map.set(key, []).get(key)).push(v); };
  for (const idy of identities) {
    push(byEmployeeId, norm(idy.employeeId), idy);
    push(byEmailLocal, emailLocalPart(idy.email), idy);
    push(byName, normalizeName(idy.displayName) || fullName(idy), idy);
    push(byNameKey, personName(idy).key, idy);
  }

  const links = [];
  for (const orphan of orphans) {
    const { accountType, pattern } = classifyAccount(orphan, compiled);
    if (!onlyTypes.has(accountType)) continue;

    const candidates = new Map();
    const addAll = (arr) => { for (const idy of (arr || [])) candidates.set(idy.id, idy); };
    addAll(byEmployeeId.get(norm(orphan.employeeId)));
    addAll(byEmailLocal.get(emailLocalPart(orphan.email)));
    addAll(byEmailLocal.get(stripKnownPrefixes(emailLocalPart(orphan.email), prefixes)));
    addAll(byName.get(normalizeName(orphan.displayName, suffixes) || fullName(orphan, suffixes)));
    addAll(byNameKey.get(personName(orphan).key));

    let best = null;
    let ties = 0;
    for (const idy of candidates.values()) {
      const { confidence, signals } = scoreMatch(orphan, idy, rules);
      if (confidence < threshold) continue;
      if (!best || confidence > best.confidence) {
        best = { identityId: idy.id, confidence, signals };
        ties = 1;
      } else if (confidence === best.confidence) {
        ties++;
      }
    }
    if (!best) continue;

    // Ambiguity guard: a name-only match (no strong email/employeeId signal) that
    // ties across multiple identities is too risky to auto-pick — leave it orphan
    // for the principals-clustering / manual review path rather than guess.
    const nameOnly = best.signals.length > 0 && best.signals.every(s => nameSigs.has(s));
    if (nameOnly && ties > 1) continue;

    links.push({
      principalId: orphan.id,
      identityId: best.identityId,
      confidence: best.confidence,
      signals: best.signals,
      accountType,
      accountTypePattern: pattern,
      displayName: orphan.displayName ?? null,
      accountEnabled: orphan.accountEnabled ?? null,
    });
  }
  return links;
}

async function loadRules(configId) {
  let row = null;
  try {
    row = configId
      ? await db.queryOne(`SELECT "rules" FROM "AccountLinkingConfig" WHERE id = $1`, [configId])
      : await db.queryOne(`SELECT "rules" FROM "AccountLinkingConfig" WHERE "isActive" = true ORDER BY "updatedAt" DESC LIMIT 1`);
  } catch { /* table may not exist yet on a partially-migrated DB */ }
  return (row && row.rules) ? { ...DEFAULT_RULES, ...row.rules } : DEFAULT_RULES;
}

async function countOrphans() {
  const r = await db.queryOne(`
    SELECT COUNT(*)::int AS n
      FROM "Principals" p
      LEFT JOIN "IdentityMembers" m ON m."principalId" = p."id"
     WHERE m."principalId" IS NULL
       AND COALESCE(p."principalType", '') NOT IN ('ServicePrincipal', 'ManagedIdentity', 'AIAgent')
  `);
  return r?.n ?? 0;
}

/**
 * Main entry point. Marks an AccountLinkingRuns row running, links orphan
 * accounts to identities, refreshes the Orphaned Accounts context, and records
 * counts. Returns when complete.
 */
export async function runLinking(runId, configId = null) {
  const updateRun = async (fields) => {
    const set = Object.keys(fields).map((k, i) => `"${k}" = $${i + 2}`).join(', ');
    await db.query(`UPDATE "AccountLinkingRuns" SET ${set} WHERE id = $1`, [runId, ...Object.values(fields)]);
  };

  try {
    await updateRun({ status: 'running', step: 'Loading rules', pct: 5 });
    const rules = await loadRules(configId);

    await updateRun({ step: 'Loading orphan accounts + identities', pct: 15 });
    const orphans = (await db.query(`
      SELECT p."id", p."displayName", p."email", p."employeeId", p."givenName", p."surname",
             p."accountEnabled", p."extendedAttributes"
        FROM "Principals" p
        LEFT JOIN "IdentityMembers" m ON m."principalId" = p."id"
       WHERE m."principalId" IS NULL
         AND COALESCE(p."principalType", '') NOT IN ('ServicePrincipal', 'ManagedIdentity', 'AIAgent')
    `)).rows;
    const identities = (await db.query(`
      SELECT i."id", i."displayName", i."email", i."employeeId", i."givenName", i."surname"
        FROM "Identities" i
    `)).rows;

    await updateRun({ step: 'Matching accounts', pct: 45, candidatesScanned: orphans.length });
    const links = buildLinks(orphans, identities, rules);

    await updateRun({ step: 'Writing links', pct: 70 });
    let created = 0, updated = 0, skipped = 0;
    for (const link of links) {
      // Never re-link an account the analyst rejected (from any identity).
      const rejected = await db.queryOne(
        `SELECT 1 FROM "IdentityMembers" WHERE "principalId" = $1 AND "analystOverride" = 'rejected' LIMIT 1`,
        [link.principalId]
      );
      if (rejected) { skipped++; continue; }

      const existing = await db.queryOne(
        `SELECT "analystOverride" FROM "IdentityMembers" WHERE "identityId" = $1 AND "principalId" = $2`,
        [link.identityId, link.principalId]
      );
      if (existing) {
        if (existing.analystOverride) { skipped++; continue; } // analyst-touched → leave it
        await db.query(`
          UPDATE "IdentityMembers"
             SET "linkConfidence" = $3, "linkSignals" = $4, "accountType" = $5,
                 "accountTypePattern" = $6, "displayName" = $7, "accountEnabled" = $8
           WHERE "identityId" = $1 AND "principalId" = $2
        `, [link.identityId, link.principalId, link.confidence, JSON.stringify(link.signals.join(',')),
            link.accountType, link.accountTypePattern, link.displayName, link.accountEnabled]);
        updated++;
      } else {
        await db.query(`
          INSERT INTO "IdentityMembers"
            ("identityId", "principalId", "isPrimary", "accountType", "accountTypePattern",
             "accountEnabled", "displayName", "linkSignals", "linkConfidence")
          VALUES ($1, $2, false, $3, $4, $5, $6, $7, $8)
          ON CONFLICT ("identityId", "principalId") DO NOTHING
        `, [link.identityId, link.principalId, link.accountType, link.accountTypePattern,
            link.accountEnabled, link.displayName, JSON.stringify(link.signals.join(',')), link.confidence]);
        created++;
      }
    }

    await updateRun({ step: 'Refreshing identity aggregates', pct: 85 });
    // Per-identity rollup: confidence = best newly-linked account, signals =
    // distinct union (stored CSV so the detail page's .split(',') keeps working).
    const byIdentity = new Map();
    for (const l of links) {
      const g = byIdentity.get(l.identityId) || { conf: 0, signals: new Set() };
      g.conf = Math.max(g.conf, l.confidence);
      for (const s of l.signals) g.signals.add(s);
      byIdentity.set(l.identityId, g);
    }
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

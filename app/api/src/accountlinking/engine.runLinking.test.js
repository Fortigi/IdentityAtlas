// Unit tests for engine.runLinking — the analyst-decision PRESERVATION logic.
//
// runLinking is the orchestrator: it loads orphans + identities, calls the pure
// buildLinks(), then for every proposed link consults IdentityMembers before
// writing. This file exercises that write loop:
//   (a) an orphan rejected anywhere is NOT re-linked,
//   (b) an existing member with a non-null analystOverride is NOT overwritten,
//   (b2) an existing member with a null override IS updated (not inserted),
//   (c) a fresh scored link IS inserted.
//
// We drive a single, deterministic link through buildLinks by feeding one orphan
// + one identity that match strongly (admin email-prefix + full name → ≥70, well
// over the threshold of 50; same fixture engine.test.js proves links). The
// preservation outcome is asserted on the real IdentityMembers UPDATE/INSERT
// calls — that is the behaviour, independent of how run counts are stored.
//
// db/connection.js is mocked (queryOne dispatched by SQL fragment); the contexts
// plugin runner is stubbed so the Orphaned-Accounts step is a no-op. Does not
// touch the pure scoreMatch/buildLinks coverage in engine.test.js.

import { describe, it, expect, vi } from 'vitest';
import { PRE_LOGIN_NAME_FORM_RULES } from '../../test-utils/preShippedLinkingRules.js';

const IDENTITY = { id: 'idy-1', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E1' };
const ORPHAN   = { id: 'p-adm', displayName: '(ADM-azure) Doe, John', email: 'adm-jdoe@contoso.com' };
const RUN_ID = 'run-1';

// A mocked db whose queryOne dispatches by SQL fragment. The caller supplies the
// responses for the two preservation lookups.
function makeDb({ rejected = null, existing = null, orphans = [ORPHAN], members = [], identities = [IDENTITY] } = {}) {
  const query = vi.fn(async (sql) => {
    if (/FROM "IdentityMembers" m/.test(sql)) return { rows: members };
    if (/FROM "Principals" p/.test(sql)) return { rows: orphans };
    if (/FROM "Identities" i/.test(sql)) return { rows: identities };
    return { rows: [] }; // UPDATE/INSERT IdentityMembers, UPDATE Identities, run updates
  });
  const queryOne = vi.fn(async (sql) => {
    if (/AccountLinkingConfig/.test(sql)) return null;               // loadRules → DEFAULT_RULES
    if (/analystOverride" = 'rejected'/.test(sql)) return rejected;  // rejected-anywhere check
    if (/SELECT "analystOverride"/.test(sql)) return existing;       // existing-member check
    if (/COUNT\(\*\)/.test(sql)) return { n: 0 };                    // countOrphans
    return null;
  });
  return { query, queryOne };
}

async function loadEngine(db) {
  vi.resetModules();
  vi.doMock('../db/connection.js', () => db);
  vi.doMock('../contexts/plugins/runner.js', () => ({ enqueueRun: vi.fn(async () => {}) }));
  return import('./engine.js');
}

// The UPDATE/INSERT statements that TARGET IdentityMembers. Matches the write
// target specifically — the per-identity aggregate UPDATE "Identities" mentions
// IdentityMembers only inside a COUNT(*) subquery and must not be counted here.
function memberWrites(db) {
  return db.query.mock.calls
    .map(c => c[0])
    .filter(sql => /UPDATE\s+"IdentityMembers"/.test(sql) || /INSERT\s+INTO\s+"IdentityMembers"/.test(sql));
}

/** The IdentityMembers rows the run inserted, as the link each one records. */
function insertedLinks(db) {
  return db.query.mock.calls
    .filter(c => /INSERT\s+INTO\s+"IdentityMembers"/.test(c[0]))
    .map(([, p]) => ({ identityId: p[0], principalId: p[1], signals: JSON.parse(p[6]), confidence: p[7] }));
}

// True once the run reached its 'completed' status update.
function reachedCompleted(db) {
  return db.query.mock.calls.some(c => Array.isArray(c[1]) && c[1].includes('completed'));
}

describe('runLinking — analyst-decision preservation', () => {
  it('(a) does NOT re-link an orphan that was rejected anywhere', async () => {
    const db = makeDb({ rejected: { '?column?': 1 } });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberWrites(db)).toHaveLength(0); // skipped — no write at all
    expect(reachedCompleted(db)).toBe(true);
  });

  it('(b) does NOT overwrite an existing member that has an analystOverride', async () => {
    const db = makeDb({ rejected: null, existing: { analystOverride: 'confirmed' } });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberWrites(db)).toHaveLength(0); // analyst-touched → left alone
    expect(reachedCompleted(db)).toBe(true);
  });

  it('(b2) UPDATES an existing member whose analystOverride is null', async () => {
    const db = makeDb({ rejected: null, existing: { analystOverride: null } });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const writes = memberWrites(db);
    expect(writes.some(sql => /UPDATE\s+"IdentityMembers"/.test(sql))).toBe(true);
    expect(writes.some(sql => /INSERT\s+INTO\s+"IdentityMembers"/.test(sql))).toBe(false);
  });

  it('(c) INSERTS a fresh scored link when no member row exists yet', async () => {
    const db = makeDb({ rejected: null, existing: null });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const writes = memberWrites(db);
    expect(writes.some(sql => /INSERT\s+INTO\s+"IdentityMembers"/.test(sql))).toBe(true);
    expect(writes.some(sql => /UPDATE\s+"IdentityMembers"/.test(sql))).toBe(false);
  });
});

// ── loadRules / countOrphans ─────────────────────────────────────────────────
//
// The two DB helpers around the run. Both fail silently rather than loudly, which is why
// mutation found them: a tenant's edited rules being ignored looks exactly like rules that
// had no effect, and an orphan count that throws takes the whole run down on a fresh
// database where the answer is simply zero.

describe('loadRules', () => {
  it('merges a tenant config OVER the defaults', () => {
    // `(row && row.rules) ? {...DEFAULT_RULES, ...row.rules} : DEFAULT_RULES`. Read as
    // always-false, every tenant silently runs on the shipped defaults: an admin raises
    // the threshold in the UI, the slider moves, and linking behaves exactly as before.
    return (async () => {
      const db = makeDb();
      db.queryOne = vi.fn(async (sql) => {
        // A realistic tenant edit: stop attaching ADMIN accounts to people. The fixture
        // orphan is "(ADM-azure) Doe, John" with an adm- email, so it classifies as Admin
        // and must now be left alone. (A raised threshold would not discriminate here --
        // this pair scores 100, the cap, so no threshold below 101 changes the outcome.)
        if (/AccountLinkingConfig/.test(sql)) return { rules: { onlyLinkTypes: ['Secondary'] } };
        if (/COUNT\(\*\)/.test(sql)) return { n: 0 };
        return null;
      });
      const { runLinking } = await loadEngine(db);
      await runLinking(RUN_ID);

      // Threshold 99 is above anything this fixture can score, so the strong
      // admin-prefix + name match that normally links must NOT be written.
      expect(memberWrites(db)).toHaveLength(0);
      expect(reachedCompleted(db)).toBe(true);
    })();
  });

  it('falls back to the defaults when there is no config row', async () => {
    // The paired case: with the same fixture and the shipped threshold, the link IS made.
    const db = makeDb();
    const { runLinking } = await loadEngine(db);
    await runLinking(RUN_ID);
    expect(memberWrites(db).length).toBeGreaterThan(0);
  });

  it('falls back to the defaults when the config table is missing entirely', async () => {
    // A partially-migrated database throws on the SELECT; linking must still run rather
    // than fail the whole job for an optional table.
    const db = makeDb();
    db.queryOne = vi.fn(async (sql) => {
      if (/AccountLinkingConfig/.test(sql)) throw new Error('relation "AccountLinkingConfig" does not exist');
      if (/COUNT\(\*\)/.test(sql)) return { n: 0 };
      return null;
    });
    const { runLinking } = await loadEngine(db);
    await expect(runLinking(RUN_ID)).resolves.not.toThrow();
    expect(memberWrites(db).length).toBeGreaterThan(0);
  });
});

// ── A saved dictionary vs signals shipped after the save (#1469) ─────────────
//
// Saving the settings persists the whole signals list of the build that was
// running, and loadRules merges the saved row over the defaults at the top level
// only — so the saved array shadows the shipped one wholesale and a tenant that
// has ever pressed Save is frozen on that build's signals. Every signal shipped
// afterwards is inert for them, with no sign that anything is missing: linking
// still completes, the account it should have matched simply stays orphaned.
//
// The pair below is the discriminating case, because only `loginNameForm`
// (shipped in #1466, weight 55) can bridge it: the mailbox carries two initials
// and the admin login one, so emailPrefix's exact local-part comparison fails
// ("fhogenbirk" ≠ "f.h.hogenbirk"), and the display name carries no person name
// for the name signals to read. engine.test.js proves this same pair links under
// the shipped DEFAULT_RULES.

describe('loadRules — a saved dictionary vs newly shipped signals (#1469)', () => {
  const FAY = {
    id: 'idy-fay', displayName: 'Fay Hogenbirk', givenName: 'Fay', surname: 'Hogenbirk',
    email: 'f.h.hogenbirk@fortigidemo.com', employeeId: 'E100',
  };
  const ADM_FAY = { id: 'p-adm', displayName: 'Admin account 042', email: 'adm-fhogenbirk@fortigidemo.com' };

  // The link the login route makes, read off the real INSERT: who to whom, on
  // what evidence, at what confidence. The weight pins that the signal arrived
  // with its shipped definition (55) rather than some value of the merge's own.
  const FAY_LOGIN_LINK = {
    identityId: 'idy-fay', principalId: 'p-adm', signals: 'loginNameForm', confidence: 55,
  };

  /** Run linking over the pair; `savedRules` null = a tenant with no config row. */
  async function linkTheAdminAccount(savedRules) {
    const db = makeDb({ orphans: [ADM_FAY], identities: [FAY] });
    if (savedRules) {
      const noConfigRow = db.queryOne.getMockImplementation();
      db.queryOne = vi.fn(async (sql, params) =>
        /AccountLinkingConfig/.test(sql) ? { rules: savedRules } : noConfigRow(sql, params));
    }
    const { runLinking } = await loadEngine(db);
    await runLinking(RUN_ID);
    return db;
  }

  it('still applies a shipped signal the saved dictionary predates (loginNameForm)', async () => {
    // An upgraded tenant: its config row holds the dictionary the administrator
    // saved before loginNameForm shipped.
    const db = await linkTheAdminAccount(PRE_LOGIN_NAME_FORM_RULES);

    expect(insertedLinks(db)).toEqual([FAY_LOGIN_LINK]);
    expect(completionFields(db).linksCreated).toBe(1);
  });

  it('links that same pair for a tenant that has never saved its settings', async () => {
    // The paired case on identical input bar the config row, and the reason the
    // assertion above discriminates: nothing about this pair is unlinkable — the
    // shipped dictionary attaches it. Only a saved row shadowing the shipped
    // signals keeps the account orphaned.
    const db = await linkTheAdminAccount(null);

    expect(insertedLinks(db)).toEqual([FAY_LOGIN_LINK]);
  });

  it('leaves the account orphaned for a tenant that switched the signal off at weight 0', async () => {
    // The off-switch that makes merging shipped signals back in safe: a signal
    // the tenant deleted returns, a signal the tenant set to 0 stays off. Same
    // input as the first case bar that one weight, so this is the case that
    // tells "the tenant's definition won" apart from "the shipped one did".
    const db = await linkTheAdminAccount({
      ...PRE_LOGIN_NAME_FORM_RULES,
      signals: [
        ...PRE_LOGIN_NAME_FORM_RULES.signals,
        { name: 'loginNameForm', type: 'loginName', field: 'email', weight: 0, stripPrefixes: ['adm-'] },
      ],
    });

    expect(insertedLinks(db)).toEqual([]);
    expect(completionFields(db).linksCreated).toBe(0);
  });

  it("scores the link at the tenant's own weight where they set one", async () => {
    // A tenant who upgraded and then raised the signal to 70 — their number is
    // what the link is recorded at, not the shipped 55, so an analyst reading
    // the confidence is reading this tenant's policy.
    const db = await linkTheAdminAccount({
      ...PRE_LOGIN_NAME_FORM_RULES,
      signals: [
        ...PRE_LOGIN_NAME_FORM_RULES.signals,
        { name: 'loginNameForm', type: 'loginName', field: 'email', weight: 70, stripPrefixes: ['adm-'] },
      ],
    });

    expect(insertedLinks(db)).toEqual([{ ...FAY_LOGIN_LINK, confidence: 70 }]);
  });
});

// ── live-rows filter ─────────────────────────────────────────────────────────
//
// A full sync stamps "deletedAt" on principals that vanished from the source
// instead of removing the row, so an account a sync has removed must not be a
// linking candidate and must not count as a remaining orphan. The mocked db is
// SQL-blind, so these pin the query text; the behaviour is proven against real
// PostgreSQL in contract-tests/accountLinking.contract.test.js.

const LIVE_ROWS_FILTER = /"deletedAt" IS NULL/;

describe('runLinking — soft-deleted principals', () => {
  it('restricts the orphan candidate set to live principals', async () => {
    const db = makeDb();
    const { runLinking } = await loadEngine(db);
    await runLinking(RUN_ID);

    const orphanLoad = db.query.mock.calls.map(c => c[0]).find(sql => /FROM "Principals"/.test(sql));
    expect(orphanLoad).toMatch(LIVE_ROWS_FILTER);
  });

  it('restricts the orphansRemaining count to live principals', async () => {
    const db = makeDb();
    const { runLinking } = await loadEngine(db);
    await runLinking(RUN_ID);

    const countQuery = db.queryOne.mock.calls.map(c => c[0]).find(sql => /COUNT\(\*\)/.test(sql));
    expect(countQuery).toMatch(LIVE_ROWS_FILTER);
  });
});

// ── The name-uniqueness guard, end to end through a run ──────────────────────
//
// Three things the run owes the operator: it must not create a name-only link to a person
// somebody else answers to, it must remove the ones made before the guard existed
// (otherwise the data that motivated the guard stays wrong forever), and it must report
// both on its own row. Every one of these is silent when broken -- the run still says
// "completed".

// A name-only match against the IDENTITY fixture: same parsed name, unrelated email,
// no employee id. Scores 60 on fullName alone.
const NAME_ONLY_ORPHAN = { id: 'p-namesake', displayName: 'Doe, John', email: 'jd@elsewhere.com' };
// A second identity really called the same thing, which is what makes the account's
// name ambiguous: both are spelled it, so the name says nothing about which of them the
// account belongs to. (Someone merely one initial away is not a rival to a name this
// account is an exact match for -- see the #1460 suite in engine.test.js.)
const NAMESAKE_IDENTITY = { id: 'idy-2', displayName: 'Doe, John', email: 'j.doe@contoso.com', employeeId: 'E2' };

/** The fields written by the run's final 'completed' UPDATE, as a column→value object. */
function completionFields(db) {
  const call = db.query.mock.calls.find(c =>
    /UPDATE "AccountLinkingRuns"/.test(c[0]) && Array.isArray(c[1]) && c[1].includes('completed'));
  if (!call) return null;
  const cols = [...call[0].matchAll(/"(\w+)" = \$\d+/g)].map(m => m[1]);
  return Object.fromEntries(cols.map((c, i) => [c, call[1][i + 1]]));
}

/**
 * The run linked nothing and held exactly one name-only match for review, shaped as `suggestion`
 * (an expect.objectContaining subset).
 */
function expectHeldForReview(db, suggestion) {
  expect(memberWrites(db)).toHaveLength(0);
  const fields = completionFields(db);
  expect(fields.linksCreated).toBe(0);
  expect(fields.nameOnlyMatches).toBe(1);
  expect(JSON.parse(fields.nameOnlySuggestions)).toEqual([expect.objectContaining(suggestion)]);
}

function memberDeletes(db) {
  return db.query.mock.calls.filter(c => /DELETE FROM "IdentityMembers"/.test(c[0]));
}

describe('runLinking — the name-uniqueness guard', () => {
  it('writes no link for an ambiguous name-only orphan and reports it on the run row', async () => {
    const db = makeDb({ orphans: [NAME_ONLY_ORPHAN], identities: [IDENTITY, NAMESAKE_IDENTITY] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expectHeldForReview(db, {
      principalId: 'p-namesake', identityId: 'idy-1', confidence: 60, signals: ['fullName'],
      reason: 'ambiguousName', matchLevel: 'full',
      rivals: [{ identityId: 'idy-2', identityName: 'Doe, John' }],
    });
  });

  it('links that same orphan when nobody else answers to its name', async () => {
    // The paired case on identical input bar the second identity: a display-name-only
    // account whose name is unique IS linked, and the run reports nothing held back.
    const db = makeDb({ orphans: [NAME_ONLY_ORPHAN] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberWrites(db).some(sql => /INSERT\s+INTO\s+"IdentityMembers"/.test(sql))).toBe(true);
    const fields = completionFields(db);
    expect(fields.linksCreated).toBe(1);
    expect(fields.nameOnlyMatches).toBe(0);
    expect(JSON.parse(fields.nameOnlySuggestions)).toEqual([]);
  });

  it('still links the corroborated orphan and reports nothing held back', async () => {
    // The admin account whose email prefix matches is untouched by the guard even with
    // the near-identical identity present, and the run says so.
    const db = makeDb({ identities: [IDENTITY, NAMESAKE_IDENTITY] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberWrites(db).length).toBeGreaterThan(0);
    const fields = completionFields(db);
    expect(fields.nameOnlyMatches).toBe(0);
    expect(JSON.parse(fields.nameOnlySuggestions)).toEqual([]);
  });

  it('reports zeroes rather than nothing on an empty tenant', async () => {
    const db = makeDb({ orphans: [] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const fields = completionFields(db);
    expect(fields.nameOnlyMatches).toBe(0);
    expect(fields.linksRemoved).toBe(0);
    expect(fields.linksRestored).toBe(0);
    expect(fields.nameOnlySuggestions).toBe('[]');
  });
});

describe('runLinking — the restored-links counter (#1460)', () => {
  // One initial away from "Doe, John": the cross-level reading counted her as a rival
  // and held the match, so a link made on this name is one the previous policy refused.
  const NEAR_IDENTITY = { id: 'idy-3', displayName: 'Doe, Jane', email: 'jane.doe@contoso.com', employeeId: 'E3' };

  it('counts a link it made on a name shared only at the weaker level', async () => {
    const db = makeDb({ orphans: [NAME_ONLY_ORPHAN], identities: [IDENTITY, NEAR_IDENTITY] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const fields = completionFields(db);
    expect(fields.linksCreated).toBe(1);
    expect(fields.linksRestored).toBe(1);
  });

  it('counts nothing when no other identity is even near the name', async () => {
    // The paired case on identical input bar the second identity: this link was never
    // held, so reporting it as restored would invite an analyst to review a non-event.
    const db = makeDb({ orphans: [NAME_ONLY_ORPHAN] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(completionFields(db).linksCreated).toBe(1);
    expect(completionFields(db).linksRestored).toBe(0);
  });

  it('counts nothing on the next run, when the link is merely refreshed', async () => {
    // The figure reports the one-off restore. Same orphan, same near-namesake, but the
    // member row already exists — a run that kept counting it would report the same
    // ~2,000 re-links every hour forever.
    const db = makeDb({
      orphans: [NAME_ONLY_ORPHAN], identities: [IDENTITY, NEAR_IDENTITY],
      existing: { analystOverride: null },
    });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const fields = completionFields(db);
    expect(fields.linksUpdated).toBe(1);
    expect(fields.linksRestored).toBe(0);
  });
});

describe('runLinking — retroactive removal of name-only links', () => {
  // A name-only link to idy-1, and an account name that NAMESAKE_IDENTITY is spelled too.
  const scoredNameOnly = { identityId: 'idy-1', principalId: 'p-old', linkSignals: 'fullName', displayName: 'Doe, John' };
  const withNamesake = { orphans: [], members: [scoredNameOnly], identities: [IDENTITY, NAMESAKE_IDENTITY] };

  it('detaches a name-only link the guard would no longer make, and recomputes the count', async () => {
    const db = makeDb(withNamesake);
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberDeletes(db).map(c => c[1])).toEqual([['idy-1', 'p-old']]);
    expect(db.query.mock.calls.some(c =>
      /UPDATE\s+"Identities"/.test(c[0]) && /"accountCount"/.test(c[0]) && c[1][0] === 'idy-1')).toBe(true);
    expect(completionFields(db).linksRemoved).toBe(1);
  });

  it('leaves that same link attached when nobody else answers to its name', async () => {
    // The paired case: the policy removes the links it would no longer make, not every
    // link that rests on a name — an upgrade must not churn a whole tenant's worth.
    const db = makeDb({ orphans: [], members: [scoredNameOnly] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberDeletes(db)).toHaveLength(0);
    expect(completionFields(db).linksRemoved).toBe(0);
  });

  it('removes it under allowNameOnlyLinks: false even though the name is unique', async () => {
    // Under that policy the engine would make no name-only link at all, so none may stay.
    const db = makeDb({ orphans: [], members: [scoredNameOnly] });
    db.queryOne = vi.fn(async (sql) => {
      if (/AccountLinkingConfig/.test(sql)) return { rules: { allowNameOnlyLinks: false } };
      if (/COUNT\(\*\)/.test(sql)) return { n: 0 };
      return null;
    });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberDeletes(db).map(c => c[1])).toEqual([['idy-1', 'p-old']]);
    expect(completionFields(db).linksRemoved).toBe(1);
  });

  it('runs the removal BEFORE loading orphans, so a detached account re-scores in the same run', async () => {
    // Ordering is the whole mechanism: remove first and the account is an orphan again by
    // the time candidates are gathered, so it is re-judged in this run rather than being
    // skipped for one. Reversed, a detached account would simply vanish until the next run.
    const db = makeDb(withNamesake);
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const sqls = db.query.mock.calls.map(c => c[0]);
    const deleteAt = sqls.findIndex(s => /DELETE FROM "IdentityMembers"/.test(s));
    const orphanLoadAt = sqls.findIndex(s => /FROM "Principals" p/.test(s));
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeLessThan(orphanLoadAt);
  });

  it('loads the identities BEFORE the removal, so it can tell unique names from shared ones', async () => {
    // The removal reads the name indexes. Built from an empty list, every name points at
    // nobody and every name-only link on the tenant is detached.
    const db = makeDb(withNamesake);
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const sqls = db.query.mock.calls.map(c => c[0]);
    const identityLoadAt = sqls.findIndex(s => /FROM "Identities" i/.test(s));
    const scanAt = sqls.findIndex(s => /FROM "IdentityMembers" m/.test(s));
    expect(identityLoadAt).toBeGreaterThanOrEqual(0);
    expect(identityLoadAt).toBeLessThan(scanAt);
  });

  it('leaves a corroborated link attached', async () => {
    const db = makeDb({
      ...withNamesake,
      members: [{ identityId: 'idy-1', principalId: 'p-keep', linkSignals: 'email,fullName', displayName: 'Doe, John' }],
    });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberDeletes(db)).toHaveLength(0);
    expect(completionFields(db).linksRemoved).toBe(0);
  });

  it('only considers engine-scored, analyst-untouched rows', async () => {
    // The exclusions are in the WHERE clause, so what is asserted here is that the clause
    // is actually there -- an analyst decision and a crawler-sourced link must never be
    // candidates for removal, whatever their signals say.
    const db = makeDb({ orphans: [], members: [] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const scan = db.query.mock.calls.map(c => c[0]).find(s => /FROM "IdentityMembers" m/.test(s));
    expect(scan).toMatch(/"linkConfidence" IS NOT NULL/);
    expect(scan).toMatch(/"analystOverride" IS NULL/);
  });
});

describe('countOrphans', () => {
  it('reports zero rather than throwing when the count query returns nothing', async () => {
    // `r?.n ?? 0`. Drop the optional chaining and a database that returns no row -- a
    // fresh install, or a driver that yields undefined for an empty result -- throws on
    // property access and takes the entire run down, where the correct answer is 0.
    const db = makeDb();
    db.queryOne = vi.fn(async (sql) => {
      if (/AccountLinkingConfig/.test(sql)) return null;
      if (/COUNT\(\*\)/.test(sql)) return undefined;   // no row at all
      return null;
    });
    const { runLinking } = await loadEngine(db);
    await expect(runLinking(RUN_ID)).resolves.not.toThrow();
    expect(reachedCompleted(db)).toBe(true);
  });
});

// ── Logins a provisioning convention shortened or numbered (#1468) ───────────
//
// Three conventions write an admin login in a form the shipped dictionary could
// not spell back to a name: the surname particle dropped (`adm-ddongen`), one
// half of a double surname (`adm-wvelde`), and a trailing digit numbering a
// namesake (`adm-svisser2`). The account reached no candidate, so it was neither
// linked nor held — invisible rather than contested, which is the half of the
// report that only a whole run shows: a run over it completes, reports zero
// name-only matches, and leaves the account orphaned with nothing to review.
//
// Each fixture rests on its login alone: the display name carries no person's
// name and there is no employee id, so any other signal firing would prove
// nothing about the login.

describe('runLinking — a login a convention shortened (#1468)', () => {
  const DANIELLE = {
    id: 'idy-danielle', displayName: 'Daniëlle van Dongen', givenName: 'Daniëlle',
    surname: 'van Dongen', email: 'danielle.vandongen@fortigidemo.com', employeeId: 'E200',
  };
  const WILMA = {
    id: 'idy-wilma', displayName: 'Wilma van der Velde-Bierma', givenName: 'Wilma',
    surname: 'van der Velde-Bierma', email: 'wilma.vandervelde@fortigidemo.com', employeeId: 'E201',
  };
  const ADM_DANIELLE = { id: 'p-adm-dd', displayName: 'Admin account 128', email: 'adm-ddongen@fortigidemo.com' };
  const ADM_WILMA = { id: 'p-adm-wv', displayName: 'Admin account 129', email: 'adm-wvelde@fortigidemo.com' };

  /** One orphan against one identity, through a whole run. */
  async function linkOne(orphan, identity) {
    const db = makeDb({ orphans: [orphan], identities: [identity] });
    const { runLinking } = await loadEngine(db);
    await runLinking(RUN_ID);
    return db;
  }

  it('links an admin account whose login drops the surname particle', async () => {
    const db = await linkOne(ADM_DANIELLE, DANIELLE);

    expect(insertedLinks(db)).toEqual([{
      identityId: 'idy-danielle', principalId: 'p-adm-dd', signals: 'loginNameForm', confidence: 55,
    }]);
    expect(completionFields(db).linksCreated).toBe(1);
  });

  it('links an admin account whose login keeps one half of a double surname', async () => {
    const db = await linkOne(ADM_WILMA, WILMA);

    expect(insertedLinks(db)).toEqual([{
      identityId: 'idy-wilma', principalId: 'p-adm-wv', signals: 'loginNameForm', confidence: 55,
    }]);
  });

  it('links neither account to a person whose surname shortens to something else', async () => {
    // The control: the shortened forms are not a wildcard. Swap the two owners and
    // every link above disappears, which is what says the match was on the name.
    const db = makeDb({ orphans: [ADM_DANIELLE, ADM_WILMA], identities: [] });
    const { runLinking } = await loadEngine(db);
    await runLinking(RUN_ID);

    expect(insertedLinks(db)).toEqual([]);
    const fields = completionFields(db);
    expect(fields.linksCreated).toBe(0);
    expect(fields.nameOnlyMatches).toBe(0);
  });

  it('holds a numbered login between the namesakes it numbers, and names the rival', async () => {
    // Two people answer to 'svisser', so the login the convention numbered is
    // contested — and being contested is what puts the account in the Name-only
    // matches review list instead of leaving it invisible.
    const vissers = [
      {
        id: 'idy-s1', displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser',
        email: 'sanne.visser@fortigidemo.com', employeeId: 'E202',
      },
      {
        id: 'idy-s2', displayName: 'Sanne Visser', givenName: 'Sanne', surname: 'Visser',
        email: 's.visser@fortigidemo.com', employeeId: 'E203',
      },
    ];
    const orphan = { id: 'p-adm-sv', displayName: 'Admin account 130', email: 'adm-svisser2@fortigidemo.com' };
    const db = makeDb({ orphans: [orphan], identities: vissers });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expectHeldForReview(db, {
      principalId: 'p-adm-sv', confidence: 55, signals: ['loginNameForm'],
      reason: 'ambiguousName', matchLevel: 'loginName', rivalCount: 1,
    });
  });
});

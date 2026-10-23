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

const IDENTITY = { id: 'idy-1', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E1' };
const ORPHAN   = { id: 'p-adm', displayName: '(ADM-azure) Doe, John', email: 'adm-jdoe@contoso.com' };
const RUN_ID = 'run-1';

// A mocked db whose queryOne dispatches by SQL fragment. The caller supplies the
// responses for the two preservation lookups.
function makeDb({ rejected = null, existing = null, orphans = [ORPHAN], members = [] } = {}) {
  const query = vi.fn(async (sql) => {
    if (/FROM "Principals"/.test(sql)) return { rows: orphans };
    if (/FROM "IdentityMembers"/.test(sql) && /^\s*SELECT/.test(sql.trim())) return { rows: members };
    if (/FROM "Identities"/.test(sql)) return { rows: [IDENTITY] };
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

// ── The name-only corroboration guard, end to end through a run ──────────────
//
// Three things the run owes the operator: it must not create a name-only link, it must
// remove the ones made before the guard existed (otherwise the data that motivated the
// guard stays wrong forever), and it must report both on its own row. Every one of these
// is silent when broken -- the run still says "completed".

// A name-only match against the IDENTITY fixture: same parsed name, unrelated email,
// no employee id. Scores 60 on fullName alone.
const NAME_ONLY_ORPHAN = { id: 'p-namesake', displayName: 'Doe, John', email: 'jd@elsewhere.com' };

/** The fields written by the run's final 'completed' UPDATE, as a column→value object. */
function completionFields(db) {
  const call = db.query.mock.calls.find(c =>
    /UPDATE "AccountLinkingRuns"/.test(c[0]) && Array.isArray(c[1]) && c[1].includes('completed'));
  if (!call) return null;
  const cols = [...call[0].matchAll(/"(\w+)" = \$\d+/g)].map(m => m[1]);
  return Object.fromEntries(cols.map((c, i) => [c, call[1][i + 1]]));
}

function memberDeletes(db) {
  return db.query.mock.calls.filter(c => /DELETE FROM "IdentityMembers"/.test(c[0]));
}

describe('runLinking — the corroboration guard', () => {
  it('writes no link for a name-only orphan and reports it on the run row', async () => {
    const db = makeDb({ orphans: [NAME_ONLY_ORPHAN] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberWrites(db)).toHaveLength(0);
    const fields = completionFields(db);
    expect(fields.linksCreated).toBe(0);
    expect(fields.nameOnlyMatches).toBe(1);
    expect(JSON.parse(fields.nameOnlySuggestions)).toEqual([expect.objectContaining({
      principalId: 'p-namesake', identityId: 'idy-1', confidence: 60, signals: ['fullName'], ties: 1,
    })]);
  });

  it('still links the corroborated orphan and reports nothing held back', async () => {
    // The paired case on the same run: the admin account whose email prefix matches is
    // untouched by the guard, and the run says so rather than reporting a suppression.
    const db = makeDb();
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
    expect(fields.nameOnlySuggestions).toBe('[]');
  });
});

describe('runLinking — retroactive removal of name-only links', () => {
  const scoredNameOnly = { identityId: 'idy-1', principalId: 'p-old', linkSignals: 'fullName' };

  it('detaches an engine-scored name-only link and recomputes the identity account count', async () => {
    const db = makeDb({ orphans: [], members: [scoredNameOnly] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberDeletes(db).map(c => c[1])).toEqual([['idy-1', 'p-old']]);
    expect(db.query.mock.calls.some(c =>
      /UPDATE\s+"Identities"/.test(c[0]) && /"accountCount"/.test(c[0]) && c[1][0] === 'idy-1')).toBe(true);
    expect(completionFields(db).linksRemoved).toBe(1);
  });

  it('runs the removal BEFORE loading orphans, so a detached account re-scores in the same run', async () => {
    // Ordering is the whole mechanism: remove first and the account is an orphan again by
    // the time candidates are gathered, so a corroborated one re-links immediately and an
    // uncorroborated one becomes a suggestion. Reversed, it would be skipped for a run.
    const db = makeDb({ orphans: [], members: [scoredNameOnly] });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const sqls = db.query.mock.calls.map(c => c[0]);
    const deleteAt = sqls.findIndex(s => /DELETE FROM "IdentityMembers"/.test(s));
    const orphanLoadAt = sqls.findIndex(s => /FROM "Principals"/.test(s));
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeLessThan(orphanLoadAt);
  });

  it('leaves a corroborated link attached', async () => {
    const db = makeDb({
      orphans: [],
      members: [{ identityId: 'idy-1', principalId: 'p-keep', linkSignals: 'email,fullName' }],
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

    const scan = db.query.mock.calls.map(c => c[0])
      .find(s => /SELECT "identityId", "principalId", "linkSignals"/.test(s));
    expect(scan).toMatch(/"linkConfidence" IS NOT NULL/);
    expect(scan).toMatch(/"analystOverride" IS NULL/);
  });

  it('does not run the removal at all when the tenant allows name-only links', async () => {
    const db = makeDb({ orphans: [], members: [scoredNameOnly] });
    db.queryOne = vi.fn(async (sql) => {
      if (/AccountLinkingConfig/.test(sql)) return { rules: { allowNameOnlyLinks: true } };
      if (/COUNT\(\*\)/.test(sql)) return { n: 0 };
      return null;
    });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberDeletes(db)).toHaveLength(0);
    expect(completionFields(db).linksRemoved).toBe(0);
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

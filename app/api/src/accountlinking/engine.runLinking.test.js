// Unit tests for engine.runLinking — the analyst-decision PRESERVATION logic.
//
// runLinking is the orchestrator: it loads orphans + identities, calls the pure
// buildLinks(), then for every proposed link consults IdentityMembers before
// writing. This file exercises that write loop:
//   (a) an orphan rejected anywhere is NOT re-linked,
//   (b) an existing member with a non-null analystOverride is NOT overwritten,
//   (c) a normal scored link IS upserted.
//
// We drive a single, deterministic link through buildLinks by feeding one orphan
// + one identity that match strongly (admin email-prefix + full name → ≥70), and
// route the per-link IdentityMembers lookups by inspecting the SQL.
//
// db/connection.js is mocked; the contexts plugin runner is stubbed so the
// "Building Orphaned Accounts context" step is a no-op. Does not touch the pure
// scoreMatch/buildLinks coverage in engine.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// A matching orphan/identity pair (same person, admin alt-account). buildLinks
// scores this ≥ threshold so exactly one link is proposed.
const IDENTITY = { id: 'idy-1', displayName: 'Doe, John', email: 'jdoe@contoso.com', employeeId: 'E1' };
const ORPHAN   = { id: 'p-adm', displayName: '(ADM-azure) Doe, John', email: 'adm-jdoe@contoso.com' };

const RUN_ID = 'run-1';

// Build a fresh mocked db whose queryOne dispatches by SQL fragment. The caller
// supplies the responses for the two preservation lookups.
function makeDb({ rejected = null, existing = null } = {}) {
  const query = vi.fn(async (sql) => {
    if (/FROM "Principals"/.test(sql)) return { rows: [ORPHAN] };
    if (/FROM "Identities"/.test(sql)) return { rows: [IDENTITY] };
    // UPDATE/INSERT IdentityMembers, UPDATE Identities, UPDATE AccountLinkingRuns…
    return { rows: [] };
  });
  const queryOne = vi.fn(async (sql) => {
    if (/AccountLinkingConfig/.test(sql)) return null;                  // loadRules → DEFAULT_RULES
    if (/analystOverride" = 'rejected'/.test(sql)) return rejected;     // rejected-anywhere check
    if (/SELECT "analystOverride"/.test(sql)) return existing;          // existing-member check
    if (/COUNT\(\*\)/.test(sql)) return { n: 0 };                       // countOrphans
    return null;
  });
  return { query, queryOne };
}

async function loadEngine(db) {
  vi.resetModules();
  vi.doMock('../db/connection.js', () => db);
  vi.doMock('../contexts/plugins/runner.js', () => ({
    enqueueRun: vi.fn(async () => {}),
  }));
  const mod = await import('./engine.js');
  return mod;
}

// Pull the UPDATE/INSERT calls that target IdentityMembers out of db.query.
function memberWrites(db) {
  return db.query.mock.calls
    .map(c => c[0])
    .filter(sql => /IdentityMembers/.test(sql) && /(UPDATE|INSERT)/.test(sql));
}

describe('runLinking — analyst-decision preservation', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('(a) does NOT re-link an orphan that was rejected anywhere', async () => {
    const db = makeDb({ rejected: { '?column?': 1 } });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    // No UPDATE/INSERT against IdentityMembers — the link was skipped.
    expect(memberWrites(db)).toHaveLength(0);

    // The run is reported with one skip.
    const completed = db.query.mock.calls
      .map(c => c[1])
      .find(args => Array.isArray(args) && JSON.stringify(args).includes('completed'));
    expect(completed).toBeTruthy();
    expect(completed[1]).toMatchObject({ skippedAnalystOverride: 1, linksCreated: 0, linksUpdated: 0 });
  });

  it('(b) does NOT overwrite an existing member that has an analystOverride', async () => {
    const db = makeDb({ rejected: null, existing: { analystOverride: 'confirmed' } });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    expect(memberWrites(db)).toHaveLength(0);

    const completed = db.query.mock.calls
      .map(c => c[1])
      .find(args => Array.isArray(args) && JSON.stringify(args).includes('completed'));
    expect(completed[1]).toMatchObject({ skippedAnalystOverride: 1, linksCreated: 0, linksUpdated: 0 });
  });

  it('(b2) UPDATES an existing member whose analystOverride is null', async () => {
    const db = makeDb({ rejected: null, existing: { analystOverride: null } });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const writes = memberWrites(db);
    expect(writes.some(sql => /UPDATE\s+"IdentityMembers"/.test(sql))).toBe(true);
    expect(writes.some(sql => /INSERT\s+INTO\s+"IdentityMembers"/.test(sql))).toBe(false);

    const completed = db.query.mock.calls
      .map(c => c[1])
      .find(args => Array.isArray(args) && JSON.stringify(args).includes('completed'));
    expect(completed[1]).toMatchObject({ linksUpdated: 1, linksCreated: 0, skippedAnalystOverride: 0 });
  });

  it('(c) INSERTS a normal scored link when no member row exists yet', async () => {
    const db = makeDb({ rejected: null, existing: null });
    const { runLinking } = await loadEngine(db);

    await runLinking(RUN_ID);

    const writes = memberWrites(db);
    expect(writes.some(sql => /INSERT\s+INTO\s+"IdentityMembers"/.test(sql))).toBe(true);

    const completed = db.query.mock.calls
      .map(c => c[1])
      .find(args => Array.isArray(args) && JSON.stringify(args).includes('completed'));
    expect(completed[1]).toMatchObject({ linksCreated: 1, linksUpdated: 0, skippedAnalystOverride: 0 });
  });
});

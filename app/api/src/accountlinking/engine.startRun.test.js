// Unit tests for startAccountLinkingRun — the run-kickoff wrapper shared by the
// route and the post-crawl auto-run. Covers the onlyIfConfigured guard, the
// active-config lookup + configId ?? null fallback, and the awaited-completion
// path. db/connection is mocked so an awaited runLinking completes with no
// orphans/identities and no side effects.

import { describe, it, expect, vi } from 'vitest';

const RUN_ID = 'run-start-1';

function makeDb({ config = null } = {}) {
  const query = vi.fn(async () => ({ rows: [] })); // Principals/Identities empty; all writes no-op
  const queryOne = vi.fn(async (sql) => {
    if (/SELECT id FROM "AccountLinkingConfig"/.test(sql)) return config; // startRun's active-config lookup
    if (/INSERT INTO "AccountLinkingRuns"/.test(sql)) return { id: RUN_ID };
    if (/AccountLinkingConfig/.test(sql)) return null; // loadRules → DEFAULT_RULES
    if (/COUNT\(\*\)/.test(sql)) return { n: 0 }; // countOrphans
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

const insertCall = (db) => db.queryOne.mock.calls.find((c) => /INSERT INTO "AccountLinkingRuns"/.test(c[0]));

describe('startAccountLinkingRun', () => {
  it('returns null and inserts nothing when onlyIfConfigured and no active config exists', async () => {
    const db = makeDb({ config: null });
    const { startAccountLinkingRun } = await loadEngine(db);

    const res = await startAccountLinkingRun('system', { onlyIfConfigured: true });

    expect(res).toBeNull();
    expect(insertCall(db)).toBeUndefined();
  });

  it('creates a run bound to the active configId and awaits completion', async () => {
    const db = makeDb({ config: { id: 'cfg-1' } });
    const { startAccountLinkingRun } = await loadEngine(db);

    const res = await startAccountLinkingRun('user', { awaitCompletion: true });

    expect(res).toEqual({ id: RUN_ID });
    expect(insertCall(db)[1]).toEqual(['cfg-1', 'user']);
  });

  it('creates a run with a null configId when no config exists and onlyIfConfigured is false', async () => {
    const db = makeDb({ config: null });
    const { startAccountLinkingRun } = await loadEngine(db);

    const res = await startAccountLinkingRun('crawl', { awaitCompletion: true });

    expect(res).toEqual({ id: RUN_ID });
    expect(insertCall(db)[1]).toEqual([null, 'crawl']);
  });
});

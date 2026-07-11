// Unit tests for refreshGeneratedContexts (runner.js).
//
// Focus: the post-crawl refresh must UPDATE existing trees in place and never
// spawn a new tree. Legacy trees (created before migration 034) have a NULL
// sourceInstanceKey; the refresh must backfill a stable key onto them first so
// reconcile matches the existing rows instead of minting a fresh key and
// inserting a duplicate tree on every crawl.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/connection.js', () => ({
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
  tx: async (fn) => fn({ query: (...a) => query(...a) }),
  default: {},
}));

const PLUGIN = { name: 'ad-ou-from-dn', targetType: 'Principal', parametersSchema: {}, run: vi.fn() };
vi.mock('./registry.js', () => ({ getPlugin: () => PLUGIN }));

const { refreshGeneratedContexts } = await import('./runner.js');

// A row as returned by the "trees to refresh" SELECT.
function tree({ ikey, scope = 1 }) {
  return { algo: 'ad-ou-from-dn', algorithmId: 'algo-1', scopeSystemId: scope, ikey, params: { scopeSystemId: scope } };
}

// Wire the db mock: the trees SELECT returns `trees`; the ContextAlgorithms
// lookup returns an id; every other query is a harmless no-op.
function wire(trees) {
  query.mockReset();
  queryOne.mockReset();
  PLUGIN.run.mockReset().mockResolvedValue({ contexts: [], members: [] });
  query.mockImplementation(async (sql) => {
    if (/array_agg\(r\.parameters/.test(sql)) return { rows: trees };
    return { rows: [], rowCount: 0 };
  });
  queryOne.mockResolvedValue({ id: 'algo-1' });
}

const backfillCalls = () => query.mock.calls.filter(([sql]) => /SET "sourceInstanceKey"/.test(sql));
const runInsert = () => query.mock.calls.find(([sql]) => /INSERT INTO "ContextAlgorithmRuns"/.test(sql));

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('refreshGeneratedContexts', () => {
  it('backfills a NULL-key legacy tree and refreshes it in place (no duplicate)', async () => {
    wire([tree({ ikey: null })]);

    const started = await refreshGeneratedContexts('crawl-refresh', { awaitCompletion: true });
    expect(started).toBe(1);

    // A backfill UPDATE was issued for the legacy tree, scoped to its algorithm + system.
    const bf = backfillCalls();
    expect(bf).toHaveLength(1);
    const [, bfParams] = bf[0];
    const backfilledKey = bfParams[0];
    expect(typeof backfilledKey).toBe('string');
    expect(backfilledKey.length).toBeGreaterThan(0);
    expect(bfParams[1]).toBe('algo-1');
    expect(bfParams[2]).toBe(1);

    // The run reconciles against that same backfilled key — i.e. it targets the
    // existing tree, it does NOT mint a fresh random key (which would duplicate).
    const insert = runInsert();
    expect(insert).toBeTruthy();
    expect(insert[1][2].instanceKey).toBe(backfilledKey);
  });

  it('refreshes a keyed tree in place without any backfill', async () => {
    wire([tree({ ikey: 'existing-key' })]);

    const started = await refreshGeneratedContexts('crawl-refresh', { awaitCompletion: true });
    expect(started).toBe(1);

    expect(backfillCalls()).toHaveLength(0);
    expect(runInsert()[1][2].instanceKey).toBe('existing-key');
  });

  it('skips trees opted out via autoRefresh=false', async () => {
    wire([{ algo: 'ad-ou-from-dn', algorithmId: 'algo-1', scopeSystemId: 1, ikey: 'k', params: { scopeSystemId: 1, autoRefresh: false } }]);

    const started = await refreshGeneratedContexts('crawl-refresh', { awaitCompletion: true });
    expect(started).toBe(0);
    expect(runInsert()).toBeFalsy();
  });
});

describe('refreshGeneratedContexts — parent-cycle prevention (A3)', () => {
  it('skips a parent link that would create a cycle, writes the acyclic one', async () => {
    wire([tree({ ikey: 'k1' })]);
    // P is a root; C->P is a normal link; S->S is a self-loop (a cycle). The
    // guard skips S (wouldCreateCycle short-circuits when id === parentId),
    // leaving it a root, while the acyclic C->P link is written.
    PLUGIN.run.mockResolvedValue({
      contexts: [
        { externalId: 'P', displayName: 'Parent' },
        { externalId: 'C', parentExternalId: 'P', displayName: 'Child' },
        { externalId: 'S', parentExternalId: 'S', displayName: 'Self' },
      ],
      members: [],
    });

    await refreshGeneratedContexts('crawl-refresh', { awaitCompletion: true });

    const parentUpdates = query.mock.calls.filter(([sql]) =>
      /UPDATE\s+"Contexts"\s+SET\s+"parentContextId"\s*=\s*\$2\s+WHERE\s+id\s*=\s*\$1/.test(sql));
    // Exactly one parent link written — the acyclic C->P.
    expect(parentUpdates).toHaveLength(1);
    // ...and it is not a self-loop (id !== parentId).
    expect(parentUpdates[0][1][0]).not.toBe(parentUpdates[0][1][1]);
    // No self-loop link slipped through the guard.
    expect(parentUpdates.some(([, params]) => params[0] === params[1])).toBe(false);
  });
});

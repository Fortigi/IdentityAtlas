import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks the db module before importing memberCounts so we can capture
// every SQL call the helper issues. The helper is a thin wrapper around
// three SQL statements:
//   1. walk-up (queryOne loop) to collect ancestor ids
//   2. UPDATE directMemberCount on the affected context
//   3. UPDATE totalMemberCount via recursive-CTE on every ancestor

const ROOT     = '00000000-0000-0000-0000-000000000001';
const PARENT   = '00000000-0000-0000-0000-000000000002';
const CHILD    = '00000000-0000-0000-0000-000000000003';
const GRANDKID = '00000000-0000-0000-0000-000000000004';

async function loadHelperWithChain(chain /* { id -> parentId } */) {
  vi.resetModules();
  const calls = { queryOne: [], query: [] };

  vi.doMock('../db/connection.js', () => {
    return {
      queryOne: vi.fn(async (sql, params) => {
        calls.queryOne.push({ sql, params });
        // Walk-up step: SELECT "parentContextId" FROM "Contexts" WHERE id = $1
        if (/SELECT "parentContextId"/.test(sql)) {
          const id = params?.[0];
          return { parentContextId: chain[id] || null };
        }
        return null;
      }),
      query: vi.fn(async (sql, params) => {
        calls.query.push({ sql, params });
        return { rowCount: 0 };
      }),
    };
  });

  const mod = await import('./memberCounts.js');
  return { ...mod, calls };
}

describe('recalcMemberCountsForChain', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('walks up the parent chain to collect ancestor ids', async () => {
    // GRANDKID -> CHILD -> PARENT -> ROOT (no parent)
    const { recalcMemberCountsForChain, calls } = await loadHelperWithChain({
      [GRANDKID]: CHILD,
      [CHILD]:    PARENT,
      [PARENT]:   ROOT,
      [ROOT]:     null,
    });
    await recalcMemberCountsForChain(GRANDKID);

    // queryOne should have been called once per ancestor in the chain.
    expect(calls.queryOne.length).toBe(4);
    expect(calls.queryOne[0].params).toEqual([GRANDKID]);
    expect(calls.queryOne[1].params).toEqual([CHILD]);
    expect(calls.queryOne[2].params).toEqual([PARENT]);
    expect(calls.queryOne[3].params).toEqual([ROOT]);
  });

  it('updates directMemberCount on the affected context only', async () => {
    const { recalcMemberCountsForChain, calls } = await loadHelperWithChain({
      [CHILD]:  PARENT,
      [PARENT]: null,
    });
    await recalcMemberCountsForChain(CHILD);

    // First UPDATE: directMemberCount on CHILD
    const direct = calls.query.find(q => /UPDATE "Contexts"\s+SET "directMemberCount"/.test(q.sql));
    expect(direct).toBeDefined();
    expect(direct.params).toEqual([CHILD]);
  });

  it('updates totalMemberCount on every node in the chain via recursive CTE', async () => {
    const { recalcMemberCountsForChain, calls } = await loadHelperWithChain({
      [CHILD]:  PARENT,
      [PARENT]: ROOT,
      [ROOT]:   null,
    });
    await recalcMemberCountsForChain(CHILD);

    // Second UPDATE: totalMemberCount with recursive CTE keyed on the chain
    const total = calls.query.find(q => /WITH RECURSIVE subtree/.test(q.sql));
    expect(total).toBeDefined();
    // The chain (self + 2 ancestors) should be passed as a uuid[]
    expect(total.params[0]).toEqual([CHILD, PARENT, ROOT]);
  });

  it('breaks the walk-up after 100 hops (cycle safety)', async () => {
    // Build a self-referential cycle: A -> A.
    const A = '00000000-0000-0000-0000-0000000000aa';
    const { recalcMemberCountsForChain, calls } = await loadHelperWithChain({
      [A]: A,
    });
    await recalcMemberCountsForChain(A);
    // The early-exit short-circuits as soon as we'd add a duplicate.
    // Self -> queryOne returns parent=A -> chain.includes(A) -> break.
    // So only one queryOne call.
    expect(calls.queryOne.length).toBe(1);
  });

  it('handles a root context (no parent) gracefully', async () => {
    const { recalcMemberCountsForChain, calls } = await loadHelperWithChain({
      [ROOT]: null,
    });
    await recalcMemberCountsForChain(ROOT);
    // Walk-up sees parent=null and breaks.
    expect(calls.queryOne.length).toBe(1);
    // Both UPDATE queries fire (direct + total).
    expect(calls.query.length).toBe(2);
    const total = calls.query.find(q => /WITH RECURSIVE subtree/.test(q.sql));
    expect(total.params[0]).toEqual([ROOT]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { markInitialLoad, initialLoadRowId } from './initialLoad.js';

function client(initialLoad) {
  return {
    query: vi.fn(async (sql) => (/lastSyncDateTime/.test(sql)
      ? { rows: initialLoad === undefined ? [] : [{ initialLoad }] }
      : { rows: [] })),
  };
}
const setCalls = (c) => c.query.mock.calls.filter(([sql]) => /SET LOCAL/.test(sql));

describe('markInitialLoad', () => {
  it('sets the transaction-local flag for a system that never completed a sync', async () => {
    const c = client(true);
    await expect(markInitialLoad(c, 7)).resolves.toBe(true);
    expect(c.query.mock.calls[0][1]).toEqual([7]);
    expect(setCalls(c)).toEqual([[`SET LOCAL identity_atlas.initial_load = 'on'`]]);
  });

  it('leaves it unset once the system has synced', async () => {
    const c = client(false);
    await expect(markInitialLoad(c, 7)).resolves.toBe(false);
    expect(setCalls(c)).toHaveLength(0);
  });

  it('leaves it unset for an unknown system', async () => {
    const c = client(undefined);
    await expect(markInitialLoad(c, 99)).resolves.toBe(false);
    expect(setCalls(c)).toHaveLength(0);
  });

  it('does not even look when the batch has no system', async () => {
    for (const id of [null, undefined]) {
      const c = client(true);
      await expect(markInitialLoad(c, id)).resolves.toBe(false);
      expect(c.query).not.toHaveBeenCalled();
    }
  });
});

describe('markInitialLoad — the anchor event', () => {
  const anchorCalls = (c) => c.query.mock.calls.filter(([sql]) => /INSERT INTO "_history"/.test(sql));

  it('records the load once for the table and system, before the flag is set', async () => {
    const c = client(true);
    await markInitialLoad(c, 7, 'ResourceAssignments');
    const [[sql, params]] = anchorCalls(c);
    expect(params).toEqual(['ResourceAssignments', 'initial-load:7', 7]);
    // Idempotent per (table, rowId): later batches of the same load add nothing.
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM "_history" WHERE "tableName" = \$1 AND "rowId" = \$2\)/);
    // An INSERT with no previous state: inert in the as-of reconstruction.
    expect(sql).toMatch(/'I', jsonb_build_object\('initialLoad', true, 'systemId', \$3::int\), NULL/);
    const calls = c.query.mock.calls.map(([s]) => s);
    expect(calls.findIndex(s => /INSERT INTO "_history"/.test(s)))
      .toBeLessThan(calls.findIndex(s => /SET LOCAL/.test(s)));
  });

  it('writes no anchor once the system has synced', async () => {
    const c = client(false);
    await markInitialLoad(c, 7, 'Resources');
    expect(anchorCalls(c)).toHaveLength(0);
  });

  it('writes no anchor when the caller names no table', async () => {
    const c = client(true);
    await expect(markInitialLoad(c, 7)).resolves.toBe(true);
    expect(anchorCalls(c)).toHaveLength(0);
  });

  it('names the anchor so no entity id can collide with it', () => {
    expect(initialLoadRowId(12)).toBe('initial-load:12');
  });
});

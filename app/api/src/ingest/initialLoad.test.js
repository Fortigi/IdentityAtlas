import { describe, it, expect, vi } from 'vitest';
import { markInitialLoad } from './initialLoad.js';

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

// Unit tests for the shared recent-changes accumulation loop (#1031). The
// per-handler classifiers are covered end-to-end by recentChanges.data.test.js;
// here we pin collectHistoryEvents — the limit break, the event/count
// accumulation, and the "no event → no slot, no count" rule — with a fake
// classify function so the logic is exercised without a DB.

import { describe, it, expect, vi } from 'vitest';
import { collectHistoryEvents } from './classify.js';

describe('collectHistoryEvents', () => {
  it('accumulates events and add/remove counts from classify results', async () => {
    const classify = async (row) => {
      if (row.op === 'I') return { event: { e: 'in' }, added: 1, removed: 0 };
      if (row.op === 'D') return { event: { e: 'out' }, added: 0, removed: 1 };
      return { event: null, added: 0, removed: 0 };
    };
    const out = await collectHistoryEvents([{ op: 'I' }, { op: 'D' }, { op: 'x' }], 10, classify);
    expect(out.events).toEqual([{ e: 'in' }, { e: 'out' }]);
    expect(out.addedCount).toBe(1);
    expect(out.removedCount).toBe(1);
  });

  it('stops once limit events are collected and does not classify further rows', async () => {
    const classify = vi.fn(async () => ({ event: {}, added: 0, removed: 0 }));
    const out = await collectHistoryEvents([1, 2, 3, 4, 5], 2, classify);
    expect(out.events).toHaveLength(2);
    expect(classify).toHaveBeenCalledTimes(2); // limit break happens before classifying row 3
  });

  it('skips rows that classify to no event without consuming a slot or counting', async () => {
    const classify = async (r) =>
      r === 'skip' ? { event: null, added: 5, removed: 5 } : { event: { r }, added: 0, removed: 0 };
    const out = await collectHistoryEvents(['skip', 'a', 'skip', 'b'], 2, classify);
    expect(out.events).toEqual([{ r: 'a' }, { r: 'b' }]);
    expect(out.addedCount).toBe(0);   // the skipped rows' counts never apply
    expect(out.removedCount).toBe(0);
  });
});

// The ratchet arithmetic. Every case pairs a count that moved with one that did
// not, so "report everything" and "report nothing" both fail.

import { describe as suite, it, expect } from 'vitest';
import { compare, describe, tighten } from './docsRatchet.js';

suite('compare', () => {
  it('reports a count above its baseline and stays silent on an equal one', () => {
    const baseline = { 'a.md': { SOLL: 2, IST: 1 } };
    const current = { 'a.md': { SOLL: 3, IST: 1 } };
    expect(compare(current, baseline)).toEqual({
      regressions: [{ page: 'a.md', item: 'SOLL', was: 2, now: 3 }],
      improvements: [],
    });
  });

  it('treats a count that DROPPED as an improvement, never a regression', () => {
    const { regressions, improvements } = compare({ 'a.md': { SOLL: 1 } }, { 'a.md': { SOLL: 4 } });
    expect(regressions).toEqual([]);
    expect(improvements).toEqual([{ page: 'a.md', item: 'SOLL', was: 4, now: 1 }]);
  });

  it('treats a page that became clean as an improvement to zero', () => {
    // The page is absent from the measurement altogether — the common case
    // after somebody fixes it — and must not throw or count as a regression.
    expect(compare({}, { 'a.md': { IST: 2 } })).toEqual({
      regressions: [],
      improvements: [{ page: 'a.md', item: 'IST', was: 2, now: 0 }],
    });
  });

  it('fails a page the baseline has never seen', () => {
    const { regressions } = compare({ 'new.md': { SOLL: 1 } }, { 'old.md': { SOLL: 1 } });
    expect(regressions).toEqual([{ page: 'new.md', item: 'SOLL', was: 0, now: 1 }]);
  });

  it('fails a new term on a page that is grandfathered for a different one', () => {
    // Being in the baseline for SOLL buys nothing for IST.
    const { regressions } = compare({ 'a.md': { SOLL: 5, IST: 1 } }, { 'a.md': { SOLL: 5 } });
    expect(regressions).toEqual([{ page: 'a.md', item: 'IST', was: 0, now: 1 }]);
  });

  it('does not let an improvement on one page pay for a regression on another', () => {
    const { regressions, improvements } = compare(
      { 'a.md': { SOLL: 1 }, 'b.md': { SOLL: 3 } },
      { 'a.md': { SOLL: 2 }, 'b.md': { SOLL: 2 } },
    );
    expect(regressions.map(r => r.page)).toEqual(['b.md']);
    expect(improvements.map(r => r.page)).toEqual(['a.md']);
  });

  it('orders findings by page, then item', () => {
    const { regressions } = compare({ 'b.md': { Y: 1, X: 1 }, 'a.md': { Z: 1 } }, {});
    expect(regressions.map(r => `${r.page}:${r.item}`)).toEqual(['a.md:Z', 'b.md:X', 'b.md:Y']);
  });
});

suite('tighten', () => {
  it('lowers a count that dropped and keeps one that did not move', () => {
    expect(tighten({ 'a.md': { SOLL: 1, IST: 2 } }, { 'a.md': { SOLL: 4, IST: 2 } }))
      .toEqual({ 'a.md': { SOLL: 1, IST: 2 } });
  });

  it('drops a page that is clean now', () => {
    expect(tighten({ 'b.md': { IST: 1 } }, { 'a.md': { SOLL: 4 }, 'b.md': { IST: 1 } }))
      .toEqual({ 'b.md': { IST: 1 } });
  });

  it('does not absorb a regression: the old ceiling stays', () => {
    // 5 measured against 2 allowed must leave 2, or regenerating the baseline
    // would be a way to make any failure go away.
    expect(tighten({ 'a.md': { SOLL: 5 } }, { 'a.md': { SOLL: 2 } })).toEqual({ 'a.md': { SOLL: 2 } });
  });

  it('does not grandfather a new page or a new term', () => {
    expect(tighten({ 'a.md': { SOLL: 1, IST: 1 }, 'new.md': { SOLL: 1 } }, { 'a.md': { SOLL: 1 } }))
      .toEqual({ 'a.md': { SOLL: 1 } });
  });

  it('writes the measurement as it is with allowIncrease', () => {
    expect(tighten({ 'a.md': { SOLL: 5 }, 'new.md': { IST: 1 } }, { 'a.md': { SOLL: 2 } }, { allowIncrease: true }))
      .toEqual({ 'a.md': { SOLL: 5 }, 'new.md': { IST: 1 } });
  });

  it('sorts pages and items so the committed file diffs cleanly', () => {
    const out = tighten({ 'b.md': { Y: 1, X: 1 }, 'a.md': { Z: 1 } }, {}, { allowIncrease: true });
    expect(JSON.stringify(out)).toBe('{"a.md":{"Z":1},"b.md":{"X":1,"Y":1}}');
  });
});

suite('describe', () => {
  it('names the page, the item and both counts', () => {
    expect(describe({ page: 'a.md', item: 'SOLL', was: 2, now: 3 })).toBe('a.md: SOLL — 3 now, 2 allowed');
  });
});

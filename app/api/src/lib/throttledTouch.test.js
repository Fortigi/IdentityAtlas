import { describe, it, expect, vi } from 'vitest';
import { createThrottledTouch, skipLockedStampSql } from './throttledTouch.js';

const flush = () => new Promise(r => setTimeout(r, 0));

describe('createThrottledTouch', () => {
  function setup(run = vi.fn().mockResolvedValue({ rowCount: 1 })) {
    let t = 1_000_000;
    const clock = { now: () => t, advance: (ms) => { t += ms; } };
    return { run, clock, touch: createThrottledTouch(run, 'SQL', { intervalMs: 60_000, now: clock.now }) };
  }

  it('stamps an id once per interval, however many requests arrive', async () => {
    const { run, touch } = setup();
    expect(touch(7)).toBe(true);
    for (let i = 0; i < 50; i++) expect(touch(7)).toBe(false);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('SQL', [7]);
  });

  it('keeps a separate interval per id', async () => {
    const { run, touch } = setup();
    touch(7); touch(8); touch(7);
    await flush();
    expect(run.mock.calls.map(c => c[1][0])).toEqual([7, 8]);
  });

  it('stamps again once the interval has passed — not a millisecond before', async () => {
    const { run, touch, clock } = setup();
    touch(7);
    clock.advance(59_999);
    expect(touch(7)).toBe(false);
    clock.advance(1);
    expect(touch(7)).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed stamp so the next request retries it', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('pool timeout')).mockResolvedValue({ rowCount: 1 });
    const { touch } = setup(run);
    touch(7);
    await flush(); await flush();
    expect(touch(7)).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never throws into the request, even when the query function throws synchronously', async () => {
    const { touch } = setup(vi.fn(() => { throw new Error('boom'); }));
    expect(() => touch(7)).not.toThrow();
    await flush();
  });
});

describe('skipLockedStampSql', () => {
  it('updates the one row only if it can lock it without waiting', () => {
    const sql = skipLockedStampSql('Crawlers', 'lastUsedAt', 'now()');
    expect(sql).toMatch(/^UPDATE "Crawlers" SET "lastUsedAt" = now\(\)/);
    expect(sql).toContain('WHERE id = (SELECT id FROM "Crawlers" WHERE id = $1 FOR UPDATE SKIP LOCKED)');
  });
});

import { describe, it, expect } from 'vitest';
import { createFailureLimiter } from './crawlerAuthFailureLimiter.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('createFailureLimiter', () => {
  it('blocks a (client, prefix) exactly at maxPerPrefix failures, not one before', () => {
    const c = clock();
    const lim = createFailureLimiter({ now: c.now, maxPerPrefix: 3, maxPerClient: 100 });
    lim.recordFailure('10.0.0.1', 'fgc_aaaa');
    lim.recordFailure('10.0.0.1', 'fgc_aaaa');
    expect(lim.isBlocked('10.0.0.1', 'fgc_aaaa')).toBe(false);
    lim.recordFailure('10.0.0.1', 'fgc_aaaa');
    expect(lim.isBlocked('10.0.0.1', 'fgc_aaaa')).toBe(true);
  });

  it('keeps the prefix bucket separate per client and per prefix', () => {
    const c = clock();
    const lim = createFailureLimiter({ now: c.now, maxPerPrefix: 2, maxPerClient: 100 });
    lim.recordFailure('10.0.0.1', 'fgc_aaaa');
    lim.recordFailure('10.0.0.1', 'fgc_aaaa');
    expect(lim.isBlocked('10.0.0.1', 'fgc_aaaa')).toBe(true);
    expect(lim.isBlocked('10.0.0.2', 'fgc_aaaa')).toBe(false);
    expect(lim.isBlocked('10.0.0.1', 'fgc_bbbb')).toBe(false);
  });

  it('blocks a client walking through many prefixes once the client bucket fills', () => {
    const c = clock();
    const lim = createFailureLimiter({ now: c.now, maxPerPrefix: 100, maxPerClient: 5 });
    for (let i = 0; i < 5; i++) lim.recordFailure('10.0.0.1', `fgc_${i}000`);
    expect(lim.isBlocked('10.0.0.1', 'fgc_ffff')).toBe(true);
  });

  it('forgets failures once the window has fully elapsed, and not a millisecond earlier', () => {
    const c = clock();
    const lim = createFailureLimiter({ now: c.now, windowMs: 1000, maxPerPrefix: 1 });
    lim.recordFailure('10.0.0.1', 'fgc_aaaa');
    c.advance(999);
    expect(lim.isBlocked('10.0.0.1', 'fgc_aaaa')).toBe(true);
    c.advance(1);
    expect(lim.isBlocked('10.0.0.1', 'fgc_aaaa')).toBe(false);
    lim.recordFailure('10.0.0.1', 'fgc_aaaa');
    expect(lim.isBlocked('10.0.0.1', 'fgc_aaaa')).toBe(true);
  });

  it('bounds memory: sweeps expired entries, then resets if still over the cap', () => {
    const c = clock();
    const lim = createFailureLimiter({ now: c.now, windowMs: 1000, maxEntries: 4 });
    lim.recordFailure('a', 'p'); // 2 entries
    lim.recordFailure('b', 'p'); // 4 entries
    c.advance(1000);
    lim.recordFailure('c', 'p'); // 6 → sweep drops the 4 expired → 2
    expect(lim.size()).toBe(2);
    lim.recordFailure('d', 'p'); // 4, at cap
    lim.recordFailure('e', 'p'); // 6 live → cleared
    expect(lim.size()).toBe(0);
  });

  it('does not sweep at exactly the cap, and keeps a sweep result that lands exactly on the cap', () => {
    const c = clock();
    const lim = createFailureLimiter({ now: c.now, windowMs: 1000, maxEntries: 4 });
    lim.recordFailure('a', 'p'); // 2 entries
    c.advance(1000);             // a's entries are now expired
    lim.recordFailure('b', 'p'); // 4 = cap → no sweep, expired entries stay
    expect(lim.size()).toBe(4);
    lim.recordFailure('c', 'p'); // 6 → sweep drops a's 2 → exactly 4 live → kept
    expect(lim.size()).toBe(4);
    expect(lim.isBlocked('b', 'p')).toBe(false);
  });
});

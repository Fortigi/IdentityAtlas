// The cache decides whether a caller sees a freshly computed access decision or a stored
// one. Both failure directions are silent: evict too eagerly and it is merely slow, evict
// too late (or never) and it serves access that is no longer true, or grows without bound.
// None of this was exercised while the cache lived inside engine.js, because reaching it
// meant going through resolve() with a database and enough distinct keys to force eviction.
import { describe, it, expect } from 'vitest';
import { createLru } from './lru.js';

describe('createLru - basics', () => {
  it('stores and returns a value', () => {
    const c = createLru(3);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(1);
  });

  it('returns undefined for a key it does not hold', () => {
    // The miss path must not throw or return a stale/adjacent value; the caller treats
    // undefined as "recompute".
    expect(createLru(3).get('nope')).toBeUndefined();
  });

  it('overwrites a key in place rather than storing it twice', () => {
    const c = createLru(3);
    c.set('a', 1);
    c.set('a', 2);
    expect(c.get('a')).toBe(2);
    expect(c.size).toBe(1);
  });

  it('clear() empties it', () => {
    const c = createLru(3);
    c.set('a', 1);
    c.set('b', 2);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });
});

describe('createLru - eviction', () => {
  it('evicts the OLDEST entry once it is over capacity, and only then', () => {
    // Exactly at capacity nothing may be dropped -- the boundary between `size > max` and
    // `size >= max` is one whole entry of cache, and the second reading throws away a live
    // result on every single write.
    const c = createLru(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.size).toBe(2);
    expect(c.get('a')).toBe(1); // still there at exactly max

    c.set('c', 3); // now over capacity
    expect(c.size).toBe(2);
  });

  it('evicts by insertion order when nothing has been read', () => {
    const c = createLru(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('c', 3);
    expect(c.get('a')).toBeUndefined(); // oldest, dropped
    expect(c.get('b')).toBe(2);
    expect(c.get('c')).toBe(3);
  });

  it('never grows past capacity, however many writes arrive', () => {
    const c = createLru(3);
    for (let i = 0; i < 50; i++) c.set(`k${i}`, i);
    expect(c.size).toBe(3);
    expect(c.get('k49')).toBe(49);
    expect(c.get('k0')).toBeUndefined();
  });
});

describe('createLru - recency', () => {
  it('a READ protects an entry from the next eviction', () => {
    // This is the whole point of the L in LRU. Without the re-insert on get(), 'a' is still
    // the oldest by insertion order and gets dropped despite being the most recently used
    // -- so the hottest access decision is the one thrown away.
    const c = createLru(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1); // 'a' becomes most-recent, 'b' is now oldest
    c.set('c', 3);

    expect(c.get('a')).toBe(1); // survived because it was read
    expect(c.get('b')).toBeUndefined(); // evicted instead
    expect(c.get('c')).toBe(3);
  });

  it('a re-WRITE also refreshes recency', () => {
    const c = createLru(2);
    c.set('a', 1);
    c.set('b', 2);
    c.set('a', 11); // refreshes 'a'
    c.set('c', 3);

    expect(c.get('a')).toBe(11);
    expect(c.get('b')).toBeUndefined();
  });

  it('a MISSED read does not disturb the eviction order', () => {
    // get() on an absent key must return early: if it fell through to the re-insert it
    // would create an entry, or reorder the ones already there.
    const c = createLru(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('ghost')).toBeUndefined();
    expect(c.size).toBe(2);
    c.set('c', 3);
    expect(c.get('a')).toBeUndefined(); // still the oldest; the miss changed nothing
    expect(c.get('b')).toBe(2);
  });
});

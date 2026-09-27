// Tests for the cache in front of filter-value discovery.
//
// The policy here is what decides whether a user ever waits for discovery:
// how long a page stays fresh, whether an expired page is handed out while a
// refresh runs, and how long that may go on when the refresh keeps failing.
// None of it touches the database, so all of it is pinned here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createValueCache, valuePageSize, STALE_GRACE, COLUMN_CACHE_TTL,
  DEFAULT_VALUE_PAGE_SIZE, MAX_VALUE_PAGE_SIZE, VALUE_SEARCH_LIMIT,
} from './valueCache.js';

describe('valuePageSize — the deployment-tunable preload cap', () => {
  const original = process.env.MATRIX_VALUE_PAGE_SIZE;
  afterEach(() => {
    if (original === undefined) delete process.env.MATRIX_VALUE_PAGE_SIZE;
    else process.env.MATRIX_VALUE_PAGE_SIZE = original;
  });

  it('defaults to 500 and clamps at the maximum', () => {
    delete process.env.MATRIX_VALUE_PAGE_SIZE;
    expect(valuePageSize()).toBe(DEFAULT_VALUE_PAGE_SIZE);
    expect(DEFAULT_VALUE_PAGE_SIZE).toBe(500);

    process.env.MATRIX_VALUE_PAGE_SIZE = '5';
    expect(valuePageSize()).toBe(5);

    process.env.MATRIX_VALUE_PAGE_SIZE = '999999';
    expect(valuePageSize()).toBe(MAX_VALUE_PAGE_SIZE);
    expect(MAX_VALUE_PAGE_SIZE).toBe(5000);
  });

  it('accepts the boundary values rather than clamping them', () => {
    process.env.MATRIX_VALUE_PAGE_SIZE = '1';
    expect(valuePageSize()).toBe(1);
    process.env.MATRIX_VALUE_PAGE_SIZE = String(MAX_VALUE_PAGE_SIZE);
    expect(valuePageSize()).toBe(MAX_VALUE_PAGE_SIZE);
  });

  it('falls back to the default for an unusable value', () => {
    for (const bad of ['', '   ', 'lots', '0', '-10']) {
      process.env.MATRIX_VALUE_PAGE_SIZE = bad;
      expect(valuePageSize()).toBe(500);
    }
  });

  it('keeps the search limit below the preload cap — it is the escape hatch, not a second page', () => {
    expect(VALUE_SEARCH_LIMIT).toBe(50);
    expect(VALUE_SEARCH_LIMIT).toBeLessThan(DEFAULT_VALUE_PAGE_SIZE);
  });
});

// ─── Stale-while-revalidate ─────────────────────────────────────────
//
// Discovery is seconds of work on a large tenant. With a plain TTL every
// fifth minute one user paid all of it; now the expired page is served
// immediately and refreshed behind the request.

describe('createValueCache — stale-while-revalidate', () => {
  let load, calls;

  // Pinned as absolute durations, not as whatever the module happens to say.
  // Every timing case below advances the clock BY these constants, so the
  // constants themselves are the one thing those cases cannot check: halve the
  // TTL and each of them moves with it and still passes.
  it('is five minutes fresh, with twenty minutes of grace behind it', () => {
    expect(COLUMN_CACHE_TTL).toBe(300_000);
    expect(STALE_GRACE).toBe(1_200_000);
  });

  beforeEach(() => {
    calls = 0;
    load = vi.fn(async () => { calls += 1; return { values: { a: [`gen${calls}`] }, truncated: {} }; });
  });

  afterEach(() => { vi.useRealTimers(); });

  it('stamps the page size it was built for onto the result', async () => {
    const cache = createValueCache('T', load);
    expect((await cache.get()).pageSize).toBe(500);
  });

  it('loads once and serves the same page while it is fresh', async () => {
    const cache = createValueCache('T', load);
    expect((await cache.get()).values.a).toEqual(['gen1']);
    expect((await cache.get()).values.a).toEqual(['gen1']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('is still fresh one millisecond before the TTL', async () => {
    vi.useFakeTimers();
    const cache = createValueCache('T', load);
    await cache.get();
    vi.advanceTimersByTime(COLUMN_CACHE_TTL - 1);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('is stale AT the TTL, not one tick later', async () => {
    vi.useFakeTimers();
    const cache = createValueCache('T', load);
    await cache.get();
    vi.advanceTimersByTime(COLUMN_CACHE_TTL);      // exactly, not past
    expect((await cache.get()).values.a).toEqual(['gen1']);   // still stale-served
    expect(load).toHaveBeenCalledTimes(2);          // …but refreshing
  });

  it('is out of grace AT the grace deadline, not one tick later', async () => {
    vi.useFakeTimers();
    const cache = createValueCache('T', load);
    await cache.get();
    vi.advanceTimersByTime(STALE_GRACE);            // exactly, not past
    expect((await cache.get()).values.a).toEqual(['gen2']);   // awaited, not stale
  });

  it('hands back the STALE page past the TTL and refreshes behind it', async () => {
    vi.useFakeTimers();
    const cache = createValueCache('T', load);
    await cache.get();

    vi.advanceTimersByTime(COLUMN_CACHE_TTL + 1);
    // The caller gets the old page without waiting for the new one…
    expect((await cache.get()).values.a).toEqual(['gen1']);
    expect(load).toHaveBeenCalledTimes(2);
    // …and the refresh it kicked off is what the next caller sees.
    await vi.waitFor(async () => expect((await cache.get()).values.a).toEqual(['gen2']));
  });

  it('waits for a real answer once the stale page is past the grace period', async () => {
    vi.useFakeTimers();
    const cache = createValueCache('T', load);
    await cache.get();

    expect(STALE_GRACE).toBeGreaterThan(COLUMN_CACHE_TTL);
    vi.advanceTimersByTime(STALE_GRACE + 1);
    expect((await cache.get()).values.a).toEqual(['gen2']);   // awaited, not stale
  });

  it('re-loads instead of serving a stale page cut to a different page size', async () => {
    vi.useFakeTimers();
    const cache = createValueCache('T', load);
    await cache.get();

    process.env.MATRIX_VALUE_PAGE_SIZE = '7';
    vi.advanceTimersByTime(COLUMN_CACHE_TTL + 1);
    const result = await cache.get();
    delete process.env.MATRIX_VALUE_PAGE_SIZE;

    expect(result.values.a).toEqual(['gen2']);   // awaited, not the 500-sized page
    expect(result.pageSize).toBe(7);
  });

  it('does not stampede: concurrent refreshes share one load', async () => {
    let release;
    const slow = vi.fn(() => new Promise(res => { release = () => res({ values: {}, truncated: {} }); }));
    const cache = createValueCache('T', slow);
    const a = cache.get(), b = cache.get(), c = cache.get();
    release();
    await Promise.all([a, b, c]);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('keeps serving stale when the background refresh fails, and logs which cache it was', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi.fn()
      .mockResolvedValueOnce({ values: { a: ['ok'] }, truncated: {} })
      .mockRejectedValue(new Error('db gone'));
    const cache = createValueCache('Principals', failing);
    await cache.get();

    vi.advanceTimersByTime(COLUMN_CACHE_TTL + 1);
    expect((await cache.get()).values.a).toEqual(['ok']);
    await vi.waitFor(() => expect(err).toHaveBeenCalledWith('Principals value refresh failed:', 'db gone'));
    err.mockRestore();
  });

  it('surfaces the error when there is no page to fall back on', async () => {
    const cache = createValueCache('T', vi.fn().mockRejectedValue(new Error('db gone')));
    await expect(cache.get()).rejects.toThrow('db gone');
  });

  it('retries after a failure rather than latching the rejected promise', async () => {
    const load2 = vi.fn()
      .mockRejectedValueOnce(new Error('db gone'))
      .mockResolvedValue({ values: { a: ['ok'] }, truncated: {} });
    const cache = createValueCache('T', load2);
    await expect(cache.get()).rejects.toThrow('db gone');
    expect((await cache.get()).values.a).toEqual(['ok']);
  });

  it('clear() drops the page so the next get() loads again', async () => {
    const cache = createValueCache('T', load);
    await cache.get();
    cache.clear();
    expect((await cache.get()).values.a).toEqual(['gen2']);
  });

  it('clear() during a refresh does not resurrect the cache from it', async () => {
    let release;
    const slow = vi.fn(() => new Promise(res => { release = () => res({ values: { a: ['late'] }, truncated: {} }); }));
    const cache = createValueCache('T', slow);
    const pending = cache.get();
    cache.clear();
    release();
    await pending;

    // The next get() must load again rather than serve what the cleared
    // generation's in-flight refresh produced.
    slow.mockResolvedValue({ values: { a: ['fresh'] }, truncated: {} });
    expect((await cache.get()).values.a).toEqual(['fresh']);
  });

  it('keeps two caches independent', async () => {
    const a = createValueCache('A', load);
    const b = createValueCache('B', load);
    expect((await a.get()).values.a).toEqual(['gen1']);
    expect((await b.get()).values.a).toEqual(['gen2']);
    a.clear();
    expect((await b.get()).values.a).toEqual(['gen2']);   // untouched
  });
});

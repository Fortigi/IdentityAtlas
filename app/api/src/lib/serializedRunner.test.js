// Unit tests for createSerializedRunner (SEC-2026-09 M-05): one run at a time,
// callers mid-run share one follow-up, and runs are spaced by a minimum interval.

import { describe, it, expect, vi } from 'vitest';
import { createSerializedRunner } from './serializedRunner.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(r => setImmediate(r));

describe('createSerializedRunner', () => {
  it('never runs two at once, and callers that arrive mid-run share ONE follow-up run', async () => {
    const gates = [deferred(), deferred()];
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const fn = vi.fn(async () => {
      const gate = gates[calls++];
      active++; maxActive = Math.max(maxActive, active);
      const value = await gate.promise;
      active--;
      return value;
    });
    const run = createSerializedRunner(fn);

    const first = run();
    const second = run();
    const third = run();
    expect(second).toBe(third);           // the same follow-up
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);  // the follow-up waits for the first

    gates[0].resolve('one');
    expect(await first).toBe('one');
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
    gates[1].resolve('two');
    expect(await second).toBe('two');
    expect(maxActive).toBe(1);
  });

  it('starts a fresh run once nothing is in flight', async () => {
    const fn = vi.fn(async () => 'x');
    const run = createSerializedRunner(fn);
    await run();
    await run();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('still runs the follow-up when the in-flight run failed', async () => {
    let n = 0;
    const run = createSerializedRunner(async () => { n++; if (n === 1) throw new Error('first failed'); return 'ok'; });
    const first = run();
    const second = run();
    await expect(first).rejects.toThrow('first failed');
    expect(await second).toBe('ok');
  });

  it('waits out the minimum interval measured from the end of the previous run', async () => {
    let clock = 1000;
    const sleeps = [];
    const run = createSerializedRunner(async () => { clock += 50; }, {
      minIntervalMs: 200,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    });
    await run();                 // first run: nothing to wait for
    expect(sleeps).toEqual([]);
    clock += 30;                 // 30ms after it finished
    await run();
    expect(sleeps).toEqual([170]);
    clock += 500;                // long after
    await run();
    expect(sleeps).toEqual([170]);
  });

  it('uses a real timer for the default sleep', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(async () => {});
      const run = createSerializedRunner(fn, { minIntervalMs: 1000 });
      await run();
      const pending = run();
      await vi.advanceTimersByTimeAsync(999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

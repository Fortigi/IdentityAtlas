import { describe, it, expect } from 'vitest';
import { createViewRefreshCoordinator, matrixRefreshDebounceMs } from './viewRefresh.js';

// A task whose runs the test finishes by hand, and a timer the test fires by hand.
function harness() {
  const runs = [];
  const task = () => new Promise((resolve, reject) => { runs.push({ resolve, reject }); });
  const timers = [];
  const setTimer = (fn) => { timers.push(fn); return timers.length; };
  const fireTimer = () => timers.shift()();
  const flush = () => new Promise(r => setTimeout(r, 0));
  return { runs, task, timers, setTimer, fireTimer, flush };
}

describe('view refresh coordinator', () => {
  it('a request returns at once; nothing runs until the debounce fires', async () => {
    const h = harness();
    const c = createViewRefreshCoordinator(h.task, { setTimer: h.setTimer });
    const s = c.schedule('crawler');
    expect(s).toMatchObject({ state: 'scheduled', pending: true, requests: 1, runs: 0 });
    await h.flush();
    expect(h.runs).toHaveLength(0);
    h.fireTimer();
    await h.flush();
    expect(h.runs).toHaveLength(1);
    expect(c.status().state).toBe('running');
    expect(c.status().current.reasons).toEqual(['crawler']);
  });

  it('requests inside the debounce window become ONE refresh (classify + refresh-views)', async () => {
    const h = harness();
    const c = createViewRefreshCoordinator(h.task, { setTimer: h.setTimer });
    c.schedule('classify');
    c.schedule('refresh-views');
    expect(h.timers).toHaveLength(1);
    h.fireTimer();
    await h.flush();
    h.runs[0].resolve();
    const done = await c.whenIdle();
    expect(h.runs).toHaveLength(1);
    expect(done).toMatchObject({ state: 'idle', pending: false, requests: 2, runs: 1 });
    expect(done.last.reasons).toEqual(['classify', 'refresh-views']);
    expect(done.last.ok).toBe(true);
  });

  it('requests during a run share exactly one follow-up — never a queue', async () => {
    const h = harness();
    const c = createViewRefreshCoordinator(h.task, { setTimer: h.setTimer });
    c.schedule('first');
    h.fireTimer();
    await h.flush();
    // Three retries arrive while the first refresh is still running.
    for (const r of ['retry-1', 'retry-2', 'retry-3']) {
      c.schedule(r);
      if (h.timers.length) h.fireTimer();
      await h.flush();
    }
    expect(h.runs).toHaveLength(1);
    h.runs[0].resolve();
    await h.flush();
    expect(h.runs).toHaveLength(2);           // the one follow-up
    expect(c.status().current.reasons).toEqual(['retry-1', 'retry-2', 'retry-3']);
    h.runs[1].resolve();
    const done = await c.whenIdle();
    expect(done.runs).toBe(2);
    expect(h.runs).toHaveLength(2);
  });

  it('records a failed refresh truthfully, and the next success replaces it', async () => {
    const h = harness();
    let t = 1000;
    const c = createViewRefreshCoordinator(h.task, { setTimer: h.setTimer, now: () => t });
    c.schedule('a');
    h.fireTimer();
    await h.flush();
    t = 4000;
    h.runs[0].reject(new Error('could not extend file: No space left on device'));
    const failed = await c.whenIdle();
    expect(failed.last).toMatchObject({ ok: false, error: 'could not extend file: No space left on device', durationMs: 3000 });
    c.schedule('b');
    h.fireTimer();
    await h.flush();
    h.runs[1].resolve();
    const ok = await c.whenIdle();
    expect(ok.last).toMatchObject({ ok: true, error: null });
    expect(ok.runs).toBe(2);
  });

  it('whenIdle resolves immediately when nothing was asked for', async () => {
    const c = createViewRefreshCoordinator(async () => {}, { setTimer: () => 1 });
    await expect(c.whenIdle()).resolves.toMatchObject({ state: 'idle', requests: 0, runs: 0, last: null });
  });

  it('runs with the real timer and a zero debounce', async () => {
    let calls = 0;
    const c = createViewRefreshCoordinator(async () => { calls++; }, { debounceMs: 0 });
    c.schedule('x');
    const done = await c.whenIdle();
    expect(calls).toBe(1);
    expect(done.last.ok).toBe(true);
  });
});

describe('matrixRefreshDebounceMs', () => {
  it('defaults to 3 s and honours a non-negative integer override', () => {
    expect(matrixRefreshDebounceMs({})).toBe(3000);
    expect(matrixRefreshDebounceMs({ MATRIX_REFRESH_DEBOUNCE_MS: '0' })).toBe(0);
    expect(matrixRefreshDebounceMs({ MATRIX_REFRESH_DEBOUNCE_MS: '250' })).toBe(250);
    expect(matrixRefreshDebounceMs({ MATRIX_REFRESH_DEBOUNCE_MS: '-5' })).toBe(3000);
    expect(matrixRefreshDebounceMs({ MATRIX_REFRESH_DEBOUNCE_MS: 'soon' })).toBe(3000);
  });
});

// Background refresh of the matrix materialized views after ingest.
//
// A refresh used to run INSIDE the HTTP request that asked for it
// (/ingest/refresh-views, and /ingest/classify-business-role-assignments). At
// 41M assignments the first build of the matrix view takes ~20 minutes; the
// crawler's HTTP client gives up after 300 s and retries, and every retry queued
// another full refresh behind the first — while the job logged the failure as
// "non-critical" and reported success (docs/architecture/scale-rehearsal.md).
//
// Now a request only ASKS for a refresh and returns at once. The refresh runs
// here, in the background:
//   - requests are debounced (`debounceMs`), so the classify call and the
//     refresh-views call a crawler makes seconds apart become ONE refresh;
//   - at most one refresh runs at a time, and requests that arrive while one is
//     running share ONE follow-up (their data may have landed after the running
//     refresh read it) — the serialized runner, reused as-is;
//   - the outcome of the last run is kept and readable (status()), so whoever is
//     waiting — the worker, at the end of a job — can report it truthfully.

import { createSerializedRunner } from '../lib/serializedRunner.js';

export function createViewRefreshCoordinator(task, options = {}) {
  const {
    debounceMs = 3000,
    minIntervalMs = 0,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
  } = options;

  let timer = null;          // a debounced request waiting to fire
  let inFlight = 0;          // fired requests whose refresh has not finished
  let requests = 0;
  let runs = 0;
  let waitingReasons = new Set();
  let current = null;        // the refresh running right now
  let last = null;           // the outcome of the last finished refresh
  let idleWaiters = [];

  const iso = (ms) => new Date(ms).toISOString();

  async function runOnce() {
    const startedAt = now();
    const reasons = [...waitingReasons];
    waitingReasons = new Set();
    current = { startedAt: iso(startedAt), reasons };
    try {
      await task();
      last = { startedAt: iso(startedAt), finishedAt: iso(now()), durationMs: now() - startedAt, ok: true, error: null, reasons };
    } catch (err) {
      console.error('Matrix view refresh failed:', err.message);
      last = { startedAt: iso(startedAt), finishedAt: iso(now()), durationMs: now() - startedAt, ok: false, error: err.message, reasons };
    } finally {
      runs++;
      current = null;
    }
  }

  const runSerialized = createSerializedRunner(runOnce, { minIntervalMs, now });

  function isPending() {
    return timer !== null || inFlight > 0;
  }

  function settle() {
    if (isPending()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve(status());
  }

  function fire() {
    timer = null;
    inFlight++;
    runSerialized().finally(() => {
      inFlight--;
      settle();
    });
  }

  function status() {
    let state = 'idle';
    if (current) state = 'running';
    else if (isPending()) state = 'scheduled';
    return { state, pending: isPending(), requests, runs, current, last };
  }

  // Ask for a refresh. Never waits for it.
  function schedule(reason = 'unspecified') {
    requests++;
    waitingReasons.add(String(reason).slice(0, 60));
    if (timer === null) timer = setTimer(fire, debounceMs);
    return status();
  }

  // Resolves with the status once nothing is scheduled or running.
  function whenIdle() {
    if (!isPending()) return Promise.resolve(status());
    return new Promise(resolve => { idleWaiters.push(resolve); });
  }

  return { schedule, status, whenIdle };
}

// Debounce for the shared coordinator. MATRIX_REFRESH_DEBOUNCE_MS overrides it
// (tests set 0).
export function matrixRefreshDebounceMs(env = process.env) {
  const n = Number.parseInt(env.MATRIX_REFRESH_DEBOUNCE_MS ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 3000;
}

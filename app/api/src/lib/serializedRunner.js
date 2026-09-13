// Serialise a costly job that many callers may ask for at once — the matrix
// materialized-view refresh (SEC-2026-09 M-05).
//
//   - at most ONE run is in flight;
//   - callers that arrive while a run is in flight all share ONE follow-up run
//     (their change may have landed after the in-flight run read the data, so it
//     is not enough to hand them the in-flight result);
//   - a run never starts sooner than `minIntervalMs` after the previous finished.
//
// So a caller looping on the endpoint gets one refresh at a time, spaced out,
// instead of a queue of back-to-back REFRESH + ANALYZE passes.

export function createSerializedRunner(fn, options = {}) {
  const {
    minIntervalMs = 0,
    now = () => Date.now(),
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  } = options;
  let running = null;
  let queued = null;
  let lastFinishedAt = -Infinity;

  async function execute() {
    const wait = lastFinishedAt + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastFinishedAt = now();
    }
  }

  function start() {
    running = execute().finally(() => { running = null; });
    return running;
  }

  return function run() {
    if (queued) return queued;
    if (!running) return start();
    queued = running.catch(() => {}).then(() => {
      queued = null;
      return start();
    });
    return queued;
  };
}

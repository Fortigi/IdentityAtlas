// SQL query timer — runs a native pg query and captures per-query execution
// time for the Server-Timing header.
//
// Usage in a route handler:
//   const r = await timedQuery(pool, 'user-attributes', res,
//     'SELECT ... WHERE id = $1', [userId]);
//   r.rows

import { isEnabled } from './collector.js';

const TIMINGS_KEY = Symbol('sqlTimings');

// Native-pg perf-timed query. Runs `pool.query(text, params)` directly and
// records the Server-Timing metric. Returns the pg result ({ rows, rowCount }).
// (Replaced the `timedRequest` compat wrapper, removed with the shim in #663.)
export async function timedQuery(pool, label, res, text, params = []) {
  if (!isEnabled() || !res) return pool.query(text, params);

  if (!res[TIMINGS_KEY]) res[TIMINGS_KEY] = [];
  const timings = res[TIMINGS_KEY];

  const start = performance.now();
  try {
    const result = await pool.query(text, params);
    timings.push({ label, ms: +(performance.now() - start).toFixed(1), rows: result.rows?.length ?? 0 });
    return result;
  } catch (err) {
    timings.push({ label, ms: +(performance.now() - start).toFixed(1), error: err.message });
    throw err;
  }
}

export function getQueryTimings(res) {
  return res?.[TIMINGS_KEY] || [];
}

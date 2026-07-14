// SQL query timer — wraps the (compat) pool.request() to capture per-query
// execution time. In v5 the underlying driver is pg, but the public surface
// is the same as v4 so route handlers don't need to change.
//
// Usage in a route handler:
//   const r = timedRequest(pool, 'user-attributes', res);
//   r.input('id', userId);
//   await r.query('SELECT ...');

import { isEnabled } from './collector.js';

const TIMINGS_KEY = Symbol('sqlTimings');

export function timedRequest(pool, label, res) {
  const request = pool.request();

  if (!isEnabled() || !res) return request;

  if (!res[TIMINGS_KEY]) res[TIMINGS_KEY] = [];
  const timings = res[TIMINGS_KEY];

  const originalQuery = request.query.bind(request);
  request.query = async function (sqlText) {
    const start = performance.now();
    try {
      const result = await originalQuery(sqlText);
      const ms = +(performance.now() - start).toFixed(1);
      timings.push({ label, ms, rows: result.recordset?.length ?? 0 });
      return result;
    } catch (err) {
      const ms = +(performance.now() - start).toFixed(1);
      timings.push({ label, ms, error: err.message });
      throw err;
    }
  };

  return request;
}

// Native-pg perf-timed query — the replacement for `timedRequest` as callers
// move off the compat shim (#663). Runs `pool.query(text, params)` directly and
// records the same Server-Timing metric. Returns the pg result ({ rows, rowCount }).
//
//   const r = await timedQuery(pool, 'user-attributes', res,
//     'SELECT ... WHERE id = $1', [userId]);
//   r.rows
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

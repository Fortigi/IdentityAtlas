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

export function getQueryTimings(res) {
  return res?.[TIMINGS_KEY] || [];
}

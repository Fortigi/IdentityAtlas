// Express middleware for automatic request-level performance capture.
//
// When PERF_METRICS_ENABLED=true:
//   1. Records total request duration
//   2. Collects per-SQL-query timings (attached by timedRequest in route handlers)
//   3. Emits Server-Timing HTTP header (visible in browser DevTools → Network)
//   4. Stores entry in the ring buffer collector
//
// When disabled: middleware is a no-op passthrough.

import { isEnabled, record } from '../perf/collector.js';
import { getQueryTimings } from '../perf/sqlTimer.js';

/**
 * Normalize Express route path from req to a pattern like '/user/:id'
 * instead of '/user/abc-123-def' to group metrics by endpoint.
 */
function getRoutePattern(req) {
  if (req.route?.path) {
    // Express populates req.route when matched; includes :param placeholders
    return req.baseUrl + req.route.path;
  }
  return req.path;
}

export function perfMetrics(req, res, next) {
  if (!isEnabled()) return next();

  const start = performance.now();

  // Hook into response finish to capture timing
  const originalEnd = res.end;
  res.end = function (...args) {
    const totalMs = +(performance.now() - start).toFixed(1);
    const sqlQueries = getQueryTimings(res);

    // Server-Timing header — shows in browser DevTools Network tab
    const timingParts = [`total;dur=${totalMs};desc="Total"`];
    let sqlTotal = 0;
    for (const q of sqlQueries) {
      sqlTotal += q.ms;
      timingParts.push(`${q.label.replace(/[^a-zA-Z0-9_-]/g, '_')};dur=${q.ms};desc="${q.label}"`);
    }
    if (sqlQueries.length > 0) {
      timingParts.push(`sql-total;dur=${sqlTotal.toFixed(1)};desc="SQL Total (${sqlQueries.length} queries)"`);
    }

    // Only set header if response hasn't been sent yet
    if (!res.headersSent) {
      res.setHeader('Server-Timing', timingParts.join(', '));
    }

    // Record to collector
    const contentLength = res.getHeader('content-length');
    record({
      route: getRoutePattern(req),
      method: req.method,
      statusCode: res.statusCode,
      totalMs,
      sqlQueries,
      sqlTotalMs: +sqlTotal.toFixed(1),
      sqlQueryCount: sqlQueries.length,
      responseBytes: contentLength ? parseInt(contentLength) : null,
      timestamp: Date.now(),
      url: req.originalUrl,
    });

    return originalEnd.apply(this, args);
  };

  next();
}

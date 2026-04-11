// Performance metrics collector — ring buffer with aggregation.
// Stores the last BUFFER_SIZE request entries and computes
// per-endpoint percentiles on demand.  Zero allocations when disabled.

const BUFFER_SIZE = 1000;

let enabled = false;
const buffer = [];          // ring buffer of RequestEntry objects
let writeIndex = 0;
let totalRecorded = 0;

// ── Public API ──────────────────────────────────────────────────

export function isEnabled() { return enabled; }

export function enable() { enabled = true; }
export function disable() { enabled = false; }

/**
 * Record a completed request.
 * @param {RequestEntry} entry
 *   { route, method, statusCode, totalMs, sqlQueries: [{ label, ms }], responseBytes, timestamp }
 */
export function record(entry) {
  if (!enabled) return;
  if (buffer.length < BUFFER_SIZE) {
    buffer.push(entry);
  } else {
    buffer[writeIndex % BUFFER_SIZE] = entry;
  }
  writeIndex++;
  totalRecorded++;
}

/**
 * Return per-endpoint aggregations (p50, p95, p99, avg, min, max, count)
 * plus per-query breakdowns for the slowest endpoints.
 */
export function summarize() {
  const byRoute = {};

  for (const entry of buffer) {
    if (!entry) continue;
    const key = `${entry.method} ${entry.route}`;
    if (!byRoute[key]) {
      byRoute[key] = { method: entry.method, route: entry.route, durations: [], sqlBreakdowns: [], entries: [] };
    }
    byRoute[key].durations.push(entry.totalMs);
    byRoute[key].entries.push(entry);
    if (entry.sqlQueries?.length) {
      byRoute[key].sqlBreakdowns.push(entry.sqlQueries);
    }
  }

  const summaries = [];
  for (const [, group] of Object.entries(byRoute)) {
    const d = group.durations.sort((a, b) => a - b);
    const count = d.length;

    // Aggregate SQL query labels across all requests for this endpoint
    const sqlLabelStats = {};
    for (const queries of group.sqlBreakdowns) {
      for (const q of queries) {
        if (!sqlLabelStats[q.label]) sqlLabelStats[q.label] = [];
        sqlLabelStats[q.label].push(q.ms);
      }
    }
    const sqlSummary = Object.entries(sqlLabelStats).map(([label, times]) => {
      times.sort((a, b) => a - b);
      return {
        label,
        count: times.length,
        avg: +(times.reduce((s, v) => s + v, 0) / times.length).toFixed(1),
        p50: percentile(times, 50),
        p95: percentile(times, 95),
        max: times[times.length - 1],
      };
    });

    summaries.push({
      method: group.method,
      route: group.route,
      count,
      avg: +(d.reduce((s, v) => s + v, 0) / count).toFixed(1),
      min: d[0],
      max: d[count - 1],
      p50: percentile(d, 50),
      p95: percentile(d, 95),
      p99: percentile(d, 99),
      sqlBreakdown: sqlSummary,
    });
  }

  summaries.sort((a, b) => b.p95 - a.p95); // slowest first
  return { totalRecorded, bufferSize: buffer.length, endpoints: summaries };
}

/**
 * Return the last N raw entries (newest first).
 */
export function recent(n = 50) {
  const entries = buffer.filter(Boolean);
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries.slice(0, n);
}

/**
 * Return the N slowest individual requests.
 */
export function slowest(n = 20) {
  const entries = buffer.filter(Boolean);
  entries.sort((a, b) => b.totalMs - a.totalMs);
  return entries.slice(0, n);
}

/**
 * Clear all collected metrics.
 */
export function clear() {
  buffer.length = 0;
  writeIndex = 0;
  totalRecorded = 0;
}

// ── Helpers ─────────────────────────────────────────────────────

function percentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * pct / 100) - 1;
  return +sorted[Math.max(0, idx)].toFixed(1);
}

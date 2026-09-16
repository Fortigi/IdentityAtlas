// Performance metrics API routes.
// These endpoints expose collected metrics for viewing and export.
// Only available when PERF_METRICS_ENABLED=true.

import { Router } from 'express';
import { isEnabled, enable, disable, summarize, recent, slowest, clear } from '../perf/collector.js';
import { requirePermission, rejectReadTokens } from '../middleware/auth.js';
import { ALL_PERMISSION_KEYS } from '../auth/permissions.js';

const router = Router();

// Reads: the Performance tab is shown to every mapped role, so any catalog
// permission passes; zero-role users and fgr_ read tokens are refused — the
// request log is operational data about other users' activity, not tenant
// data a BI export needs (SEC-2026-09 L-02).
const readPerf = [rejectReadTokens, requirePermission(...ALL_PERMISSION_KEYS)];

// Security (SEC-NEW-4): perfRouter is mounted with authMiddleware only. Reads are
// gated by readPerf above, and the state-changing /perf/clear and /perf/toggle
// had NO gate — any authenticated
// user could wipe metrics or disable the collector. Those two are gated on
// admin.feature-flags below (runtime-toggle territory). No-op when auth disabled.

// ─── GET /api/perf ──────────────────────────────────────────────
// Summary view: per-endpoint aggregations (p50, p95, p99, avg, min, max)
// with SQL query breakdowns for each endpoint.
router.get('/perf', readPerf, (req, res) => {
  if (!isEnabled()) {
    return res.json({
      enabled: false,
      message: 'Set PERF_METRICS_ENABLED=true to enable performance monitoring',
    });
  }
  res.json({ enabled: true, ...summarize() });
});

// ─── GET /api/perf/recent ───────────────────────────────────────
// Last N raw request entries (newest first).
// Query params: n (int, default 50, max 200)
router.get('/perf/recent', readPerf, (req, res) => {
  if (!isEnabled()) return res.json({ enabled: false, data: [] });
  const n = Math.min(Math.max(parseInt(req.query.n) || 50, 1), 200);
  res.json({ enabled: true, data: recent(n) });
});

// ─── GET /api/perf/slow ────────────────────────────────────────
// N slowest individual requests (by total duration).
// Query params: n (int, default 20, max 100)
router.get('/perf/slow', readPerf, (req, res) => {
  if (!isEnabled()) return res.json({ enabled: false, data: [] });
  const n = Math.min(Math.max(parseInt(req.query.n) || 20, 1), 100);
  res.json({ enabled: true, data: slowest(n) });
});

// ─── GET /api/perf/export ──────────────────────────────────────
// Full JSON export: summary + all raw entries.
// Designed for downloading and sharing with an AI assistant for analysis.
router.get('/perf/export', readPerf, (req, res) => {
  if (!isEnabled()) return res.json({ enabled: false });
  const summary = summarize();
  const all = recent(1000); // all buffered entries

  res.setHeader('Content-Disposition', `attachment; filename="identity-atlas-perf-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json"`);
  res.json({
    enabled: true,
    exportedAt: new Date().toISOString(),
    summary,
    requests: all,
  });
});

// ─── POST /api/perf/clear ──────────────────────────────────────
// Clear all collected metrics.
router.post('/perf/clear', requirePermission('admin.feature-flags'), (req, res) => {
  clear();
  res.json({ ok: true, message: 'Metrics cleared' });
});

// ─── POST /api/perf/toggle ─────────────────────────────────────
// Enable or disable the metrics collector at runtime.
// body: { enabled: boolean }
router.post('/perf/toggle', requirePermission('admin.feature-flags'), (req, res) => {
  const { enabled: target } = req.body || {};
  if (typeof target !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }
  if (target) enable(); else disable();
  res.json({ enabled: isEnabled() });
});

export default router;

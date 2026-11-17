// Database-maintenance endpoints — /api/admin/clean-database (+ its /plan) and the
// /api/admin/history-retention read/write/prune trio.
//
// Extracted from routes/admin.js (audit finding C1). Mounted by routes/admin.js
// via router.use(), so the public paths are unchanged.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as db from '../../db/connection.js';
import { requirePermission } from '../../middleware/auth.js';
import { purgeExpiredTombstones } from '../../ingest/tombstonePurge.js';
import { principalRateLimitKey } from '../../middleware/rateLimitKeys.js';
import { cleanDatabase } from '../../db/cleanDatabase.js';
import { cleanDatabasePlan } from '../../db/tableClassification.js';
import { viewRefresh } from '../ingest/matrixViews.js';

const router = Router();

const writeSystems = requirePermission('admin.systems');

// Rate limiter for destructive admin operations (5 requests per minute, per
// signed-in admin rather than per proxy address — SEC-2026-09 M-09)
const adminDestructiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: principalRateLimitKey,
  message: { error: 'Too many admin requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Clean Database — removes what a crawler or plugin can recreate ──────────
//
// What goes and what stays is db/tableClassification.js; db/cleanDatabase.js
// carries it out on one transaction, so a failing statement rolls the whole
// clean back and the call answers 500 without SQL detail.

// The wipe must be confirmed explicitly in the JSON body, in every auth mode, so
// no request that merely reaches the endpoint (a form post, a stray script) can
// trigger it (SEC-2026-09 H-07).
export const CLEAN_DATABASE_CONFIRMATION = 'DELETE ALL DATA';
export const CLEAN_DATABASE_FAILED = 'Clean database failed. Nothing was removed.';

// What the confirmation dialog lists — read from the classification, so the
// dialog cannot promise what the clean does not do.
router.get('/admin/clean-database/plan', writeSystems, (_req, res) => {
  res.json({ confirmation: CLEAN_DATABASE_CONFIRMATION, ...cleanDatabasePlan() });
});

// ANALYZE so pg_class.reltuples (dashboard-stats' fast estimates) drops to the
// new counts at once instead of when autovacuum gets round to it. Best effort.
async function analyzeTables(tables) {
  for (const table of tables) {
    try { await db.query(`ANALYZE "${table}"`); } catch { /* non-critical */ }
  }
}

router.post('/admin/clean-database', writeSystems, adminDestructiveLimiter, async (req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });
  if (req.body?.confirm !== CLEAN_DATABASE_CONFIRMATION) {
    return res.status(400).json({
      error: `Confirmation required: send {"confirm": "${CLEAN_DATABASE_CONFIRMATION}"}`,
    });
  }

  let result;
  try {
    result = await db.tx(client => cleanDatabase(client));
  } catch (err) {
    console.error('Clean database failed (rolled back):', err.message);
    return res.status(500).json({ error: CLEAN_DATABASE_FAILED });
  }
  const { touched, ...summary } = result;
  await analyzeTables(touched);
  // The matrix views still hold the removed rows until they are rebuilt.
  viewRefresh.schedule('clean-database');
  res.json({ message: 'Database cleaned', ...summary });
});

// ─── History retention setting ──────────────────────────────────────────────
// Controls how long rows in the `_history` audit table are kept before being
// pruned. Default is 180 days. Setting to 0 disables pruning entirely.
//
// The setting is persisted in WorkerConfig under "HISTORY_RETENTION_DAYS"
// and read by the periodic prune job (started in bootstrap.js).
const HISTORY_RETENTION_KEY = 'HISTORY_RETENTION_DAYS';
const HISTORY_RETENTION_DEFAULT = 180;

router.get('/admin/history-retention', writeSystems, async (_req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });
  try {
    const r = await db.queryOne(
      `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
      [HISTORY_RETENTION_KEY]
    );
    const days = r ? parseInt(r.configValue, 10) : HISTORY_RETENTION_DEFAULT;
    // Best-effort current row count for the UI
    let totalRows = null;
    try {
      const c = await db.queryOne(`SELECT count(*)::bigint AS n FROM "_history"`);
      totalRows = Number(c?.n || 0);
    } catch { /* table may not exist on very old deployments */ }
    res.json({ retentionDays: days, totalRows });
  } catch (err) {
    console.error('history-retention read failed:', err.message);
    res.status(500).json({ error: 'Failed to read history retention' });
  }
});

router.put('/admin/history-retention', writeSystems, async (req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });
  const { retentionDays } = req.body || {};
  const days = parseInt(retentionDays, 10);
  if (isNaN(days) || days < 0 || days > 3650) {
    return res.status(400).json({ error: 'retentionDays must be an integer between 0 and 3650' });
  }
  try {
    await db.query(
      `INSERT INTO "WorkerConfig" ("configKey","configValue")
       VALUES ($1, $2)
       ON CONFLICT ("configKey") DO UPDATE
         SET "configValue" = EXCLUDED."configValue",
             "updatedAt"   = now() AT TIME ZONE 'utc'`,
      [HISTORY_RETENTION_KEY, String(days)]
    );
    res.json({ retentionDays: days });
  } catch (err) {
    console.error('history-retention write failed:', err.message);
    res.status(500).json({ error: 'Failed to save history retention' });
  }
});

router.post('/admin/history-retention/prune', writeSystems, adminDestructiveLimiter, async (_req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });
  try {
    const r = await db.queryOne(
      `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
      [HISTORY_RETENTION_KEY]
    );
    const days = r ? parseInt(r.configValue, 10) : HISTORY_RETENTION_DEFAULT;
    if (days <= 0) return res.json({ deleted: 0, purged: {}, message: 'Retention disabled (0 days) — nothing pruned' });
    // Finalise tombstones (hard-delete soft-deleted rows past the window), then
    // prune the history table — same retention governs both.
    const { purged } = await purgeExpiredTombstones(db, days);
    const del = await db.query(
      `DELETE FROM "_history" WHERE "changedAt" < now() - ($1::int * interval '1 day')`,
      [days]
    );
    res.json({ deleted: del.rowCount || 0, purged, retentionDays: days });
  } catch (err) {
    console.error('history-retention prune failed:', err.message);
    res.status(500).json({ error: 'Prune failed' });
  }
});

export default router;

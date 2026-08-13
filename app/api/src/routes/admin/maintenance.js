// Database-maintenance endpoints — /api/admin/clean-database and the
// /api/admin/history-retention read/write/prune trio.
//
// Extracted verbatim from routes/admin.js (audit finding C1). Mounted by
// routes/admin.js via router.use(), so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as db from '../../db/connection.js';
import { requirePermission } from '../../middleware/auth.js';
import { purgeExpiredTombstones } from '../../ingest/tombstonePurge.js';

const router = Router();

const writeSystems = requirePermission('admin.systems');

// Rate limiter for destructive admin operations (5 requests per minute)
const adminDestructiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many admin requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Clean Database — wipes all identity data, keeps configs ─────────────────
//
// Deletes all rows from data tables (Principals, Resources, Identities, etc.)
// but preserves crawler configs, risk profiles, and audit log so the user can
// re-sync from a clean slate without losing their setup.
// DELETE each existing table (+ its _history rows); collect wiped/skipped.
async function wipeTables(tables, existingTables) {
  const wiped = [];
  const skipped = [];
  for (const table of tables) {
    if (!existingTables.has(table)) {
      skipped.push({ table, reason: 'does not exist' });
      continue;
    }
    try {
      const result = await db.query(`DELETE FROM "${table}"`);
      wiped.push({ table, rowsAffected: result.rowCount || 0 });
      // Clean the _history audit table for this table too
      try {
        await db.query(`DELETE FROM "_history" WHERE "tableName" = $1`, [table]);
      } catch (err) { console.warn('Could not clean _history for', table, ':', err.message); }
    } catch (err) {
      skipped.push({ table, reason: err.message });
    }
  }
  return { wiped, skipped };
}

router.post('/admin/clean-database', writeSystems, adminDestructiveLimiter, async (req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });

  // Tables to wipe (data only — configs/profiles/audit preserved)
  // Listed in dependency order: child tables first to avoid FK issues
  const TABLES_TO_WIPE = [
    // Identity correlation
    'IdentityMembers', 'Identities',
    // Resource graph
    'ResourceAssignments', 'ResourceRelationships',
    'AssignmentRequests', 'AssignmentPolicies', 'CertificationDecisions',
    'Resources',
    // Principals, contexts, systems
    'Principals', 'Contexts', 'OrgUnits',
    // Governance + risk artifacts
    'GovernanceCatalogs', 'RiskScores',
    // Systems is wiped LAST so any FK references from above are gone first
    'Systems',
    // Crawler runtime artifacts (jobs, sync log) — but NOT configs
    'CrawlerJobs', 'SyncLog', 'GraphSyncLog',
  ];

  try {
    // Batch check: discover which tables actually exist (1 query instead of N)
    const existResult = await db.query(
      `SELECT t AS tbl, to_regclass('public."' || t || '"') AS oid
       FROM unnest($1::text[]) AS t`,
      [TABLES_TO_WIPE]
    );
    const existingTables = new Set(
      (existResult.rows || []).filter(r => r.oid).map(r => r.tbl)
    );

    const { wiped, skipped } = await wipeTables(TABLES_TO_WIPE, existingTables);

    // ANALYZE all wiped tables so pg_class.reltuples (used by dashboard-stats for
    // fast estimates) resets to 0 immediately. Without this the dashboard keeps
    // showing the old row counts after a clean until autovacuum runs.
    for (const { table } of wiped) {
      try { await db.query(`ANALYZE "${table}"`); } catch { /* non-critical */ }
    }

    // Reset SERIAL sequences for all wiped tables so re-inserted rows start from 1.
    // Without this, Systems gets IDs like 10, 11, 12 after a clean, breaking
    // demo data which hardcodes systemId references.
    if (wiped.length > 0) {
      try {
        const wipedNames = wiped.map(w => w.table);
        const seqResult = await db.query(
          `SELECT t.relname AS table_name, s.relname AS seq_name
           FROM pg_class t
           JOIN pg_attribute a ON a.attrelid = t.oid
           JOIN pg_depend d ON d.refobjid = t.oid AND d.refobjsubid = a.attnum
           JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
           WHERE t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
             AND t.relname = ANY($1)`,
          [wipedNames]
        );
        for (const row of seqResult.rows) {
          await db.query(`SELECT setval(quote_ident($1), 1, false)`, [row.seq_name]);
        }
      } catch (err) {
        console.warn('Could not reset sequences during cleanup:', err.message);
      }
    }

    // Reset lastRunAt on crawler configs so the UI shows them as "never run"
    try {
      await db.query(`UPDATE "CrawlerConfigs" SET "lastRunAt" = NULL, "lastRunStatus" = NULL`);
    } catch (err) {
      console.warn('Could not reset CrawlerConfigs during cleanup:', err.message);
    }

    res.json({ message: 'Database cleaned', wiped, skipped });
  } catch (err) {
    console.error('Clean database failed:', err.message);
    res.status(500).json({ error: 'Clean database failed' });
  }
});
// ─── History retention setting ──────────────────────────────────────────────
// Controls how long rows in the `_history` audit table are kept before being
// pruned. Default is 180 days. Setting to 0 disables pruning entirely.
//
// The setting is persisted in WorkerConfig under "HISTORY_RETENTION_DAYS"
// and read by the periodic prune job (started in bootstrap.js).
const HISTORY_RETENTION_KEY = 'HISTORY_RETENTION_DAYS';
const HISTORY_RETENTION_DEFAULT = 180;

router.get('/admin/history-retention', async (_req, res) => {
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

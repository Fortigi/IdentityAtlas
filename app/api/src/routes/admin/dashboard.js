// Dashboard read endpoints — /api/admin/dashboard-stats (one-shot overview) and
// /api/admin/dashboard-timeseries (daily snapshot history for the Trends tab).
//
// Extracted verbatim from routes/admin.js (audit finding C1). Mounted by
// routes/admin.js via router.use(), so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';

const router = Router();

// ─── Dashboard stats — one-shot overview of loaded data ────────────────────
//
// Used by the Dashboard / landing page to show a summary of what's in the
// system. Returns counts for every entity type, plus the risk-scoring
// feature status and a flag indicating whether any crawler has ever run.
//
// Single round-trip to the database: one multi-value SELECT. If any table
// doesn't exist yet (fresh install before migrations fully land) each
// subquery falls back to zero via COALESCE.
router.get('/admin/dashboard-stats', async (_req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });
  try {
    // Two-pass approach to keep the Home page snappy on large datasets:
    //  1. Use `pg_class.reltuples` for the big tables where an exact count
    //     would require a sequential scan (ResourceAssignments is 1.5M rows
    //     in the load-test dataset and `SELECT COUNT(*)` takes ~1 second
    //     per query — 15 of these in a row is the bottleneck). reltuples
    //     is an estimate maintained by ANALYZE and is accurate to within
    //     a few percent for a dashboard. Good enough for Home.
    //  2. Use exact COUNT(*) only for the small tables and for filtered
    //     counts that can go through an index.
    //
    // The dashboard is never treated as a source of truth — detail pages
    // compute their own exact counts. For the landing page, fast + close
    // beats slow + perfect.
    const stats = await db.queryOne(`
      WITH estimates AS (
        SELECT relname, reltuples::bigint AS est
          FROM pg_class
         WHERE relname IN (
           'Systems','Resources','Principals','Identities',
           'ResourceAssignments','ResourceRelationships','Contexts',
           'IdentityMembers','CertificationDecisions','GraphSyncLog','RiskScores'
         )
           AND relkind = 'r'
      )
      SELECT
        (SELECT COUNT(*)::int FROM "Systems")                                                              AS "systems",
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname = 'Resources'), 0), 0)::int              AS "resources",
        (SELECT COUNT(*)::int FROM "Resources" WHERE "resourceType" = 'BusinessRole')          AS "businessRoles",
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname = 'Principals'), 0), 0)::int             AS "users",
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname = 'Identities'), 0), 0)::int             AS "identities",
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname = 'ResourceAssignments'), 0), 0)::int    AS "assignments",
        (SELECT COUNT(*)::int FROM "ResourceAssignments" WHERE "governed" = true)  AS "governedAssignments",
        (SELECT COUNT(*)::int FROM "ResourceAssignments" WHERE "identityId" IS NOT NULL)       AS "identityAssignments",
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname = 'ResourceRelationships'), 0), 0)::int  AS "relationships",
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname = 'Contexts'), 0), 0)::int               AS "contexts",
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname = 'IdentityMembers'), 0), 0)::int       AS "identityMembers",
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname = 'CertificationDecisions'), 0), 0)::int AS "certifications",
        (SELECT COUNT(*)::int FROM "GraphSyncLog")                                                         AS "syncLogEntries",
        (SELECT MAX("StartTime") FROM "GraphSyncLog")                                          AS "lastSyncAt",
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname = 'RiskScores'), 0), 0)::int             AS "riskScores",
        (SELECT COUNT(*)::int FROM "RiskProfiles" WHERE "isActive")                            AS "activeRiskProfile",
        (SELECT COUNT(*)::int FROM "RiskClassifiers" WHERE "isActive")                         AS "activeClassifiers",
        (  (SELECT COUNT(*)::int FROM "CrawlerConfigs" WHERE enabled)
         + (SELECT COUNT(*)::int FROM "Crawlers" WHERE enabled AND "displayName" != 'Built-in Worker')
        )                                                                                      AS "enabledCrawlers",
        (SELECT COUNT(*)::int FROM "CrawlerJobs" WHERE status = 'running')                     AS "runningJobs"
    `);

    // Is the LLM configured? (needed for risk-scoring readiness)
    let llmConfigured = false;
    try {
      const cfg = await db.queryOne(
        `SELECT 1 FROM "WorkerConfig" WHERE "configKey" = 'LLM_CONFIG'`
      );
      const key = await db.queryOne(`SELECT 1 FROM "Secrets" WHERE id = 'llm.apikey'`);
      llmConfigured = !!(cfg && key);
    } catch { /* Secrets table may not exist on very old deployments */ }

    // pg_class.reltuples is always 0 in PGlite (no stats collector process),
    // so fall back to an exact COUNT when DESKTOP_MODE is set and reltuples says empty.
    let hasData = (stats.users || 0) + (stats.resources || 0) > 0;
    if (!hasData && process.env.DESKTOP_MODE === 'true') {
      const check = await db.queryOne(
        `SELECT (SELECT COUNT(*)::int FROM "Principals") + (SELECT COUNT(*)::int FROM "Resources") AS total`
      );
      hasData = (check?.total || 0) > 0;
    }
    res.json({ ...stats, llmConfigured, hasData });
  } catch (err) {
    console.error('dashboard-stats failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

// ─── Dashboard timeseries — daily snapshot history for the Trends tab ──────
//
// Returns the last N days of dashboard counts, written daily by the
// scheduler (see scheduler.js → captureDashboardSnapshotIfMissing). Used
// by the Trends tab to plot growth over time for users, resources,
// assignments, and the % of assignments that are governed.
//
// We deliberately do NOT backfill from history — the chart starts on the
// day migration 027 applied and grows from there.
router.get('/admin/dashboard-timeseries', async (req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 730);
    // Existence check — table won't exist on a fresh DB before migration 027.
    const exists = await db.queryOne(`SELECT to_regclass('"DashboardSnapshots"') AS t`);
    if (!exists?.t) return res.json({ days, data: [] });

    const result = await db.query(
      `SELECT
         "snapshotDate"::text AS date,
         "systems", "resources", "businessRoles", "principals",
         "identities", "assignments", "governedAssignments",
         "relationships", "contexts", "identityMembers", "certifications"
       FROM "DashboardSnapshots"
       WHERE "snapshotDate" >= (CURRENT_DATE - ($1 || ' days')::interval)
       ORDER BY "snapshotDate" ASC`,
      [String(days)],
    );
    res.json({ days, data: result.rows || [] });
  } catch (err) {
    console.error('dashboard-timeseries failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard timeseries' });
  }
});

export default router;

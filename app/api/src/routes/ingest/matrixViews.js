// Matrix materialized-view refresh + default-filter seed endpoints —
// /api/ingest/refresh-views and /api/ingest/matrix-default-filter — plus the
// refreshKeyword / refreshMatrixViews helpers (refreshMatrixViews is also called
// by bootstrap.js).
//
// Extracted verbatim from routes/ingest.js (audit finding C1). Mounted by
// routes/ingest.js via router.use() so the public paths are unchanged; the two
// helpers are re-exported by routes/ingest.js. No behaviour change.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { crawlerHasPermission } from '../../middleware/crawlerAuth.js';
import { bumpSyncVersion } from '../../lib/syncVersion.js';
import { breakCycles } from '../../contexts/cycleGuard.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

router.post('/ingest/refresh-views', async (req, res) => {
  if (!crawlerHasPermission(req, 'refreshViews') && !crawlerHasPermission(req, 'admin')) {
    return res.status(403).json({ error: 'Insufficient permissions (requires refreshViews)' });
  }
  if (!useSql) {
    return res.json({ message: 'SQL disabled — nothing to refresh' });
  }
  try {
    await refreshMatrixViews();

    // Mark every system that has synced data with the current timestamp so the
    // Systems page shows "Last sync: <date>" instead of "Never".
    try {
      await db.query(`
        UPDATE "Systems" s
           SET "lastSyncDateTime" = now() AT TIME ZONE 'utc'
         WHERE s.id IN (
           SELECT DISTINCT "systemId" FROM "Resources"  WHERE "systemId" IS NOT NULL
           UNION
           SELECT DISTINCT "systemId" FROM "Principals" WHERE "systemId" IS NOT NULL
         )
      `);
    } catch (tsErr) {
      console.warn('lastSyncDateTime update failed (non-fatal):', tsErr.message);
    }

    // Fix-at-source: a crawler can emit a mis-parented context tree (or an IGA
    // export with a loop), persisting a cyclic parentContextId. The roll-up
    // below is CYCLE-guarded so it won't hang, but a stored cycle would still
    // leave totalMemberCount undefined for the looped subtree — so repair the
    // stored state first (NULL the offending parent link, logged).
    try {
      const broken = await breakCycles(db);
      if (broken) console.warn(`Context cycle guard: broke ${broken} cyclic parentContextId link(s) after ingest`);
    } catch (cycErr) {
      console.warn('Context cycle repair failed (non-fatal):', cycErr.message);
    }

    // Recalculate directMemberCount and totalMemberCount on all Contexts
    // that have ContextMembers. The ingest engine doesn't trigger the
    // per-context recalc helper (that's for manual analyst writes), so we
    // do a bulk UPDATE here instead.
    try {
      const pool = await db.getPool();
      await pool.request().query(`
        UPDATE "Contexts" c
           SET "directMemberCount" = (
                 SELECT COUNT(*)::int FROM "ContextMembers" WHERE "contextId" = c.id
               ),
               "lastCalculatedAt"  = now() AT TIME ZONE 'utc';

        WITH RECURSIVE subtree AS (
          SELECT id AS root_id, id AS node_id FROM "Contexts"
          UNION ALL
          SELECT s.root_id, c.id
            FROM "Contexts" c JOIN subtree s ON c."parentContextId" = s.node_id
        )
        -- CYCLE guard: this seeds from every context and runs on each sync,
        -- so a single corrupt parent chain would otherwise hang ingest.
        CYCLE node_id SET "isCycle" USING "cyclePath",
        totals AS (
          SELECT s.root_id, COUNT(DISTINCT cm."memberId")::int AS cnt
            FROM subtree s
            LEFT JOIN "ContextMembers" cm ON cm."contextId" = s.node_id
           GROUP BY s.root_id
        )
        UPDATE "Contexts" c
           SET "totalMemberCount" = t.cnt
          FROM totals t
         WHERE c.id = t.root_id;
      `);
    } catch (countErr) {
      console.warn('Context member count refresh failed (non-fatal):', countErr.message);
    }

    // Advance the effective-access cache version. The crawler calls this endpoint only
    // after all ingest writes are durable, so bumping here invalidates engine cache entries
    // exactly once per completed sync — never mid-sync. Non-fatal: a failed bump just means
    // the cache serves slightly stale data until the next sync. See spec §13.2.
    try {
      await bumpSyncVersion();
    } catch (svErr) {
      console.warn('syncVersion bump failed (non-fatal):', svErr.message);
    }

    res.json({ message: 'Materialized views refreshed' });
  } catch (err) {
    console.error('refresh-views failed:', err.message);
    res.status(500).json({ error: 'refresh-views failed: ' + err.message });
  }
});

// Shared helper used by /ingest/refresh-views, the classify endpoint, and
// bootstrap's initial refresh. CONCURRENTLY falls back to a plain REFRESH
// on the very first run (CONCURRENTLY requires the matview to already have
// data, which it doesn't on first boot). After refreshing we ANALYZE both
// matviews and the big base tables so the planner has accurate row counts
// (dashboard-stats uses pg_class.reltuples for its fast-path counts and
// that field is only updated by ANALYZE).
// Pure helper — determines whether CONCURRENTLY can be used for a given view.
// Exported for unit testing.
export function refreshKeyword(viewName, populatedSet, isDesktop) {
  return !isDesktop && populatedSet.has(viewName) ? 'CONCURRENTLY' : '';
}

async function refreshMatrixViews() {
  const views = [
    '"vw_ResourceUserPermissionAssignments"',
    '"vw_UserPermissionAssignmentViaBusinessRole"',
  ];
  // PGlite (DESKTOP_MODE) runs in a single WASM process with no background
  // worker, so CONCURRENTLY is not supported. Always use plain REFRESH there.
  const isDesktop = process.env.DESKTOP_MODE === 'true';
  let populatedSet = new Set();
  if (!isDesktop) {
    // Fetch which matviews are already populated so we can choose CONCURRENTLY
    // vs plain REFRESH without letting PostgreSQL log an ERROR on first boot.
    const { rows: populated } = await db.query(
      `SELECT matviewname FROM pg_matviews WHERE ispopulated = true AND matviewname = ANY($1)`,
      [views.map(v => v.replace(/"/g, ''))],
    );
    populatedSet = new Set(populated.map(r => r.matviewname));
  }
  for (const v of views) {
    const concurrently = refreshKeyword(v.replace(/"/g, ''), populatedSet, isDesktop);
    await db.query(`REFRESH MATERIALIZED VIEW ${concurrently} ${v}`);
  }
  // Refresh planner statistics on the matviews and the big base tables.
  // Cheap (milliseconds) and gives dashboard-stats fast reltuples-based
  // counts that stay close to reality.
  const tables = [
    '"vw_ResourceUserPermissionAssignments"',
    '"vw_UserPermissionAssignmentViaBusinessRole"',
    '"ResourceAssignments"',
    '"Resources"',
    '"Principals"',
    '"ResourceRelationships"',
    '"Contexts"',
    '"Identities"',
    '"IdentityMembers"',
    '"Systems"',
    '"CertificationDecisions"',
    '"GraphSyncLog"',
    '"RiskScores"',
  ];
  for (const t of tables) {
    try { await db.query(`ANALYZE ${t}`); } catch { /* best effort */ }
  }
}

// ─── Seed default matrix filter ─────────────────────────────────────────────
// Creates or replaces the org-wide default matrix filter (isDefault = true).
// Called by Ingest-DemoDataset.ps1 to pre-configure the Matrix tab so new
// installs with demo data don't require the wizard on first visit.

router.post('/ingest/matrix-default-filter', async (req, res) => {
  if (!crawlerHasPermission(req, 'admin') && !crawlerHasPermission(req, 'ingest')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : 'Default';
  const description = typeof body.description === 'string' ? body.description.slice(0, 1000) : null;
  if (!body.filter || typeof body.filter !== 'object') {
    return res.status(400).json({ error: 'filter is required' });
  }
  try {
    const p = await db.getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS "SavedMatrixFilters" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name"        TEXT NOT NULL,
        "description" TEXT,
        "filter"      JSONB NOT NULL,
        "isDefault"   BOOLEAN NOT NULL DEFAULT false,
        "createdBy"   TEXT,
        "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
        "updatedBy"   TEXT,
        "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
      )
    `);
    await p.query(`ALTER TABLE "SavedMatrixFilters" ADD COLUMN IF NOT EXISTS "isDefault" BOOLEAN NOT NULL DEFAULT false`);
    await p.query(`UPDATE "SavedMatrixFilters" SET "isDefault" = false WHERE "isDefault" = true`);
    await p.query(
      `INSERT INTO "SavedMatrixFilters" (id, "name", "description", "filter", "isDefault", "createdBy", "updatedBy")
       VALUES (gen_random_uuid(), $1, $2, $3, true, 'seed', 'seed')
       ON CONFLICT (LOWER("name")) DO UPDATE
         SET "filter"      = EXCLUDED."filter",
             "description" = EXCLUDED."description",
             "isDefault"   = true,
             "updatedBy"   = 'seed',
             "updatedAt"   = (now() AT TIME ZONE 'utc')`,
      [name, description, body.filter],
    );
    const row = await db.queryOne(`SELECT * FROM "SavedMatrixFilters" WHERE "isDefault" = true LIMIT 1`);
    res.status(201).json(row);
  } catch (err) {
    console.error('POST ingest/matrix-default-filter failed:', err.message);
    res.status(500).json({ error: 'Failed to seed default filter' });
  }
});


export default router;

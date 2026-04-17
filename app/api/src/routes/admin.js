import { Router } from 'express';
import http from 'http';
import rateLimit from 'express-rate-limit';
import * as db from '../db/connection.js';
import { getAuthState } from '../config/authConfig.js';

// Rate limiter for destructive admin operations (5 requests per minute)
const adminDestructiveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many admin requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// ── Helpers ──────────────────────────────────────────────────────

async function tableExists(_pool, tableName) {
  // Postgres: use to_regclass() instead of OBJECT_ID. Returns NULL when the
  // table doesn't exist, otherwise the OID. The script translation broke the
  // template literal interpolation here — restored manually.
  const r = await db.query(
    `SELECT to_regclass($1) AS oid`,
    ['"' + tableName + '"']
  );
  return r.rows[0].oid !== null;
}

function safeParseJson(str) {
  try { return str ? JSON.parse(str) : null; } catch { return null; }
}

// ── GET /api/admin/risk-profile ───────────────────────────────────
// Returns the active v5 risk profile (or the most recent one if none is active).
// v5 moved off the legacy GraphRiskProfiles table — profiles now live in
// RiskProfiles and are created by the in-browser wizard (Admin → Risk Scoring →
// New profile). The response shape is kept compatible with the existing
// AdminPage renderer: domain/industry/country are promoted to top-level fields,
// `profile` carries the full structured customer_profile object.
router.get('/admin/risk-profile', async (req, res) => {
  if (!useSql) return res.json({ available: false });

  try {
    const r = await db.query(`
      SELECT id, "displayName", domain, industry, country, "llmProvider", "llmModel",
             version, "isActive", "createdAt", "updatedAt", profile
        FROM "RiskProfiles"
        ORDER BY "isActive" DESC, "createdAt" DESC
        LIMIT 1
    `);

    if (r.rows.length === 0) {
      return res.json({ available: false });
    }

    const row = r.rows[0];
    res.json({
      available: true,
      source: 'sql',
      id: row.id,
      displayName: row.displayName,
      domain: row.domain || row.profile?.domain || null,
      industry: row.industry || row.profile?.industry || null,
      country: row.country || row.profile?.country || null,
      llmProvider: row.llmProvider,
      llmModel: row.llmModel,
      version: row.version,
      isActive: row.isActive,
      generatedAt: row.createdAt,
      profile: row.profile, // jsonb parsed by pg
    });
  } catch (err) {
    console.error('Error fetching risk profile:', err.message);
    res.json({ available: false });
  }
});

// ── GET /api/admin/classifiers ────────────────────────────────────
// Returns the active v5 classifier set (or the most recent one if none active).
// Like /admin/risk-profile, this reads from the v5 RiskClassifiers table used
// by the wizard, not the retired GraphRiskClassifiers table.
router.get('/admin/classifiers', async (req, res) => {
  if (!useSql) return res.json({ available: false });

  try {
    const r = await db.query(`
      SELECT id, "profileId", "displayName", "llmProvider", "llmModel", version,
             "isActive", "createdAt", "updatedAt", classifiers, schedules
        FROM "RiskClassifiers"
        ORDER BY "isActive" DESC, "createdAt" DESC
        LIMIT 1
    `);
    if (r.rows.length === 0) return res.json({ available: false });

    const row = r.rows[0];
    res.json({
      available: true,
      source: 'sql',
      id: row.id,
      profileId: row.profileId,
      displayName: row.displayName,
      version: row.version,
      isActive: row.isActive,
      generatedAt: row.createdAt,
      llmProvider: row.llmProvider,
      llmModel: row.llmModel,
      classifiers: row.classifiers, // jsonb parsed by pg
      schedules: row.schedules || [], // jsonb parsed by pg
    });
  } catch (err) {
    console.error('Error fetching classifiers:', err.message);
    res.json({ available: false });
  }
});

// ── GET /api/admin/correlation-ruleset ───────────────────────────
// Returns the most recently saved correlation ruleset from GraphCorrelationRulesets.
router.get('/admin/correlation-ruleset', async (req, res) => {
  if (!useSql) return res.json({ available: false });

  try {
    const pool = await db.getPool();
    if (!await tableExists(pool, 'GraphCorrelationRulesets')) {
      return res.json({ available: false });
    }

    const r = await pool.request().query(`
      SELECT id, version, "generatedAt", "rulesetJson"
      FROM "GraphCorrelationRulesets"
      ORDER BY "generatedAt" DESC
    `);

    if (r.recordset.length === 0) return res.json({ available: false });

    const row = r.recordset[0];
    res.json({
      available: true,
      id: row.id,
      version: row.version,
      generatedAt: row.generatedAt,
      ruleset: safeParseJson(row.rulesetJson),
    });
  } catch (err) {
    console.error('Error fetching correlation ruleset:', err.message);
    res.status(500).json({ error: 'Failed to load correlation ruleset' });
  }
});

// ── GET /api/admin/export/curated ────────────────────────────────
// Exports tags (with assignments) and categories (with AP assignments) to JSON.
// Compatible with the PowerShell Export-FGCuratedData / Import-FGCuratedData format.
router.get('/admin/export/curated', async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL mode required' });

  try {
    const pool = await db.getPool();

    // ── Tags + assignments ────────────────────────────────────────
    let tags = [];
    if (await tableExists(pool, 'GraphTags')) {
      // Detect which tables exist for display-name resolution
      const hasPrincipals = await tableExists(pool, 'Principals');
      const hasResources  = await tableExists(pool, 'Resources');

      // Postgres: tag entityIds are stored as text. Cast to uuid only when the
      // value is shaped like a uuid, otherwise the cast errors out and breaks
      // the whole query. uuid_or_null() is a tiny inline plpgsql helper.
      const userJoin = hasPrincipals
        ? `LEFT JOIN "Principals" gu ON t."entityType" = 'user'
             AND ta."entityId" ~* '^[0-9a-f-]{36}$'
             AND gu.id = ta."entityId"::uuid`
        : '';
      const resourceJoin = hasResources
        ? `LEFT JOIN "Resources" r ON t."entityType" IN ('resource','group')
             AND ta."entityId" ~* '^[0-9a-f-]{36}$'
             AND r.id = ta."entityId"::uuid`
        : '';

      const tagRows = await pool.request().query(`
        SELECT t.id, t.name, t.color, t."entityType",
               ta."entityId",
               COALESCE(gu."displayName", r."displayName") AS entityDisplayName,
               ${hasResources ? 'r."resourceType"' : 'NULL'} AS "resourceType"
        FROM "GraphTags" t
        LEFT JOIN "GraphTagAssignments" ta ON ta."tagId" = t.id
        ${userJoin}
        ${resourceJoin}
        ORDER BY t."entityType", t.name, ta."entityId"
      `);

      // Group into tag objects
      const byId = new Map();
      for (const row of tagRows.recordset) {
        const key = String(row.id);
        if (!byId.has(key)) {
          byId.set(key, { name: row.name, color: row.color, entityType: row.entityType, assignments: [] });
        }
        if (row.entityId) {
          byId.get(key).assignments.push({
            entityId:    row.entityId,
            displayName: row.entityDisplayName || null,
            resourceType: row.resourceType || null,
          });
        }
      }
      tags = Array.from(byId.values());
    }

    // ── Categories + AP assignments ───────────────────────────────
    let categories = [];
    if (await tableExists(pool, 'GovernanceCategories')) {
      const catRows = await pool.request().query(`
        SELECT c.id, c.name, c.color, ca."resourceId", ap."displayName" AS businessRoleDisplayName
        FROM "GovernanceCategories" c
        LEFT JOIN "GovernanceCategoryAssignments" ca ON ca."categoryId" = c.id
        LEFT JOIN "Resources" ap
          ON LOWER(ap.id) = ca."resourceId"
          AND ap."resourceType" = 'BusinessRole'
        ORDER BY c.name, ca."resourceId"
      `);

      const byCatId = new Map();
      for (const row of catRows.recordset) {
        const key = String(row.id);
        if (!byCatId.has(key)) {
          byCatId.set(key, { name: row.name, color: row.color, assignments: [] });
        }
        if (row.resourceId) {
          byCatId.get(key).assignments.push({
            accessPackageId:          row.resourceId,
            accessPackageDisplayName: row.businessRoleDisplayName || null,
          });
        }
      }
      categories = Array.from(byCatId.values());
    }

    const payload = {
      exportedAt:       new Date().toISOString(),
      version:          '1.0',
      tags,
      categories,
      analystOverrides: [],   // not managed via UI — exported by PowerShell only
    };

    res.setHeader('Content-Disposition', `attachment; filename="FGCuratedData_${new Date().toISOString().slice(0,10)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('Export curated data failed:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ── POST /api/admin/import/curated ───────────────────────────────
// Imports tags and categories from a JSON file (same format as export).
// Strategy per assignment:
//   1. GUID match — look up entityId / accessPackageId directly.
//   2. Soft-match — if GUID not found, search by displayName
//      (+ resourceType for group/resource entities).
// Skips assignments whose entity cannot be resolved in either way.
router.post('/admin/import/curated', async (req, res) => {
  if (!useSql) return res.status(400).json({ error: 'SQL mode required' });

  const { tags = [], categories = [] } = req.body;
  if (!Array.isArray(tags) || !Array.isArray(categories)) {
    return res.status(400).json({ error: 'tags and categories must be arrays' });
  }

  const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
  const stats = {
    tagsInserted: 0, tagsSkipped: 0,
    assignmentsInserted: 0, assignmentsSkipped: 0,
    assignmentsSoftMatched: 0, assignmentsNotFound: 0,
    catsInserted: 0, catsSkipped: 0,
    catAssignInserted: 0, catAssignSkipped: 0,
    catAssignSoftMatched: 0, catAssignNotFound: 0,
  };

  try {
    const pool = await db.getPool();

    // Ensure tag + category tables exist
    const { ensureTagTables }      = await import('./tags.js');
    const { ensureCategoryTables } = await import('./categories.js');
    await ensureTagTables(pool);
    await ensureCategoryTables(pool);

    // Detect available tables for entity resolution
    const hasPrincipals = await tableExists(pool, 'Principals');
    const hasResources  = await tableExists(pool, 'Resources');

    // ── Helper: resolve entity GUID ──────────────────────────────
    async function resolveEntity(entityId, entityType, displayName, resourceType) {
      // 1. GUID match — check if the entity still exists with this ID
      let exists = false;
      try {
        if (entityType === 'user') {
          const tbl = hasPrincipals ? 'Principals' : 'GraphUsers';
          const vtFilter = hasPrincipals ? `AND ValidTo = '9999-12-31 23:59:59.9999999'` : '';
          const r = await pool.request()
            .input('id', entityId)
            .query(`SELECT COUNT(*) AS n FROM ${tbl} WHERE UPPER((id)::text) = UPPER(@id) ${vtFilter}`);
          exists = r.recordset[0].n > 0;
        } else {
          const tbl = hasResources ? 'Resources' : 'GraphGroups';
          const vtFilter = hasResources ? `AND ValidTo = '9999-12-31 23:59:59.9999999'` : '';
          const r = await pool.request()
            .input('id', entityId)
            .query(`SELECT COUNT(*) AS n FROM ${tbl} WHERE UPPER((id)::text) = UPPER(@id) ${vtFilter}`);
          exists = r.recordset[0].n > 0;
        }
      } catch { /* table might not exist */ }

      if (exists) return { id: entityId.toUpperCase(), softMatched: false };

      // 2. Soft-match by displayName (+ resourceType for resources/groups)
      if (!displayName) return null;
      try {
        if (entityType === 'user') {
          const tbl = hasPrincipals ? 'Principals' : 'GraphUsers';
          const vtFilter = hasPrincipals ? `AND ValidTo = '9999-12-31 23:59:59.9999999'` : '';
          const r = await pool.request()
            .input('displayName', displayName)
            .query(`SELECT UPPER((id)::text) AS id FROM ${tbl}
                    WHERE "displayName" = @displayName ${vtFilter}`);
          if (r.recordset.length > 0) return { id: r.recordset[0].id, softMatched: true };
        } else {
          // group / resource — match on displayName + resourceType if available
          const tbl = hasResources ? 'Resources' : 'GraphGroups';
          const vtFilter = hasResources ? `AND ValidTo = '9999-12-31 23:59:59.9999999'` : '';
          let req2 = pool.request().input('displayName', displayName);
          let rtClause = '';
          if (resourceType && hasResources) {
            req2 = req2.input('resourceType', resourceType);
            rtClause = 'AND resourceType = @resourceType';
          }
          const r = await req2.query(
            `SELECT UPPER((id)::text) AS id FROM ${tbl}
             WHERE "displayName" = @displayName ${rtClause} ${vtFilter}`
          );
          if (r.recordset.length > 0) return { id: r.recordset[0].id, softMatched: true };
        }
      } catch { /* ignore */ }

      return null; // not found
    }

    // ── Tags ─────────────────────────────────────────────────────
    for (const tag of tags) {
      if (!tag.name || !tag.entityType) continue;
      const color = HEX_COLOR_RE.test(tag.color || '') ? tag.color : '#3b82f6';

      // Upsert tag (name + entityType unique). xmax = 0 → fresh INSERT, otherwise UPDATE.
      const upsert = await db.query(
        `INSERT INTO "GraphTags" (name, color, "entityType")
         VALUES ($1, $2, $3)
         ON CONFLICT (name, "entityType") DO UPDATE SET color = EXCLUDED.color
         RETURNING id, (xmax = 0) AS "wasInsert"`,
        [String(tag.name).slice(0, 100), color, tag.entityType]
      );
      const tagId = upsert.rows[0]?.id;
      if (!tagId) continue;
      if (upsert.rows[0].wasInsert) stats.tagsInserted++;
      else stats.tagsSkipped++;

      for (const a of (tag.assignments || [])) {
        if (!a.entityId) continue;
        const resolved = await resolveEntity(a.entityId, tag.entityType, a.displayName, a.resourceType);
        if (!resolved) { stats.assignmentsNotFound++; continue; }

        const ins = await db.query(
          `INSERT INTO "GraphTagAssignments" ("tagId", "entityId")
           VALUES ($1, $2)
           ON CONFLICT ("tagId", "entityId") DO NOTHING
           RETURNING 1 AS inserted`,
          [tagId, resolved.id]
        );
        if (ins.rows.length > 0) {
          stats.assignmentsInserted++;
          if (resolved.softMatched) stats.assignmentsSoftMatched++;
        } else {
          stats.assignmentsSkipped++;
        }
      }
    }

    // ── Categories ───────────────────────────────────────────────
    for (const cat of categories) {
      if (!cat.name) continue;
      const color = HEX_COLOR_RE.test(cat.color || '') ? cat.color : '#3b82f6';

      // Upsert category (name is unique)
      const catUp = await db.query(
        `INSERT INTO "GovernanceCategories" (name, color)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color
         RETURNING id`,
        [String(cat.name).slice(0, 100), color]
      );
      const catId = catUp.rows[0]?.id;
      if (!catId) continue;
      stats.catsInserted++;

      for (const a of (cat.assignments || [])) {
        if (!a.accessPackageId) continue;

        // 1. GUID match
        let apId = null;
        try {
          const r = await db.query(
            `SELECT LOWER(id::text) AS id FROM "Resources"
              WHERE LOWER(id::text) = $1 AND "resourceType" = 'BusinessRole'`,
            [a.accessPackageId.toLowerCase()]
          );
          if (r.rows.length > 0) apId = r.rows[0].id;
        } catch { /* ignore */ }

        let softMatched = false;
        if (!apId && a.accessPackageDisplayName) {
          try {
            const r = await db.query(
              `SELECT LOWER(id::text) AS id FROM "Resources"
                WHERE "displayName" = $1 AND "resourceType" = 'BusinessRole'`,
              [a.accessPackageDisplayName]
            );
            if (r.rows.length > 0) { apId = r.rows[0].id; softMatched = true; }
          } catch { /* ignore */ }
        }

        if (!apId) { stats.catAssignNotFound++; continue; }

        // Insert or skip (AP can only have one category — caller must remove first)
        const ins = await db.query(
          `INSERT INTO "GovernanceCategoryAssignments" ("resourceId", "categoryId")
           VALUES ($1, $2)
           ON CONFLICT ("resourceId", "categoryId") DO NOTHING
           RETURNING 1 AS inserted`,
          [apId, catId]
        );
        if (ins.rows.length > 0) {
          stats.catAssignInserted++;
          if (softMatched) stats.catAssignSoftMatched++;
        } else {
          stats.catAssignSkipped++;
        }
      }
    }

    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Import curated data failed:', err.message);
    res.status(500).json({ error: 'Import failed' });
  }
});

// ─── Clean Database — wipes all identity data, keeps configs ─────────────────
//
// Deletes all rows from data tables (Principals, Resources, Identities, etc.)
// but preserves crawler configs, risk profiles, and audit log so the user can
// re-sync from a clean slate without losing their setup.
router.post('/admin/clean-database', adminDestructiveLimiter, async (req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });

  // Tables to wipe (data only — configs/profiles/audit preserved)
  // Listed in dependency order: child tables first to avoid FK issues
  //
  // PRESERVED (NOT wiped):
  //   - Systems (connection config: tenantId, systemType, etc.)
  //   - Crawlers (API keys for custom connectors)
  //   - CrawlerConfigs (crawler configuration settings)
  //   - CrawlerAuditLog (crawler audit history)
  //   - RiskProfiles, RiskClassifiers (risk scoring config)
  //   - WorkerConfig (feature flags, LLM config, etc.)
  //   - Secrets (encrypted credentials)
  // WIPED:
  //   - All identity data (Principals, Resources, Assignments, etc.)
  //   - Crawler runtime artifacts (CrawlerJobs)
  //   - Sync logs
  const TABLES_TO_WIPE = [
    // Identity correlation
    'IdentityMembers', 'Identities',
    // Resource graph
    'ResourceAssignments', 'ResourceRelationships',
    'AssignmentRequests', 'AssignmentPolicies', 'CertificationDecisions',
    'Resources',
    // Principals, contexts, org units
    'Principals', 'Contexts', 'OrgUnits',
    // Governance + risk artifacts
    'GovernanceCatalogs', 'RiskScores',
    // Crawler runtime artifacts (jobs, sync log)
    'CrawlerJobs', 'SyncLog', 'GraphSyncLog',
    // Legacy tables
    'GraphGroupMembers', 'GraphGroupOwners', 'GraphGroups', 'GraphUsers',
  ];

  try {
    const wiped = [];
    const skipped = [];

    // Batch check: discover which tables actually exist (1 query instead of N)
    const existResult = await db.query(
      `SELECT t AS tbl, to_regclass('public."' || t || '"') AS oid
       FROM unnest($1::text[]) AS t`,
      [TABLES_TO_WIPE]
    );
    const existingTables = new Set(
      (existResult.rows || []).filter(r => r.oid).map(r => r.tbl)
    );

    for (const table of TABLES_TO_WIPE) {
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
    res.status(500).json({ error: 'Clean database failed: ' + err.message });
  }
});

// ─── Feature flag toggle (persisted in WorkerConfig) ─────────────────────────
// POST /api/admin/features/toggle  body: { feature: 'riskScoring'|'accountCorrelation', enabled: boolean }
//
// Stores the override in WorkerConfig as FEATURE_<UPPER_SNAKE>. The /api/features
// endpoint reads this and overrides the matching env var. Survives container restarts.
router.post('/admin/features/toggle', async (req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });
  const { feature, enabled } = req.body || {};
  const VALID = { riskScoring: 'FEATURE_RISK_SCORING', accountCorrelation: 'FEATURE_ACCOUNT_CORRELATION' };
  const key = VALID[feature];
  if (!key) return res.status(400).json({ error: `feature must be one of: ${Object.keys(VALID).join(', ')}` });
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });

  try {
    await db.query(
      `INSERT INTO "WorkerConfig" ("configKey", "configValue")
       VALUES ($1, $2)
       ON CONFLICT ("configKey") DO UPDATE
         SET "configValue" = EXCLUDED."configValue",
             "updatedAt"   = now() AT TIME ZONE 'utc'`,
      [key, enabled ? 'true' : 'false']
    );
    res.json({ feature, enabled });
  } catch (err) {
    console.error('Feature toggle failed:', err.message);
    res.status(500).json({ error: 'Feature toggle failed' });
  }
});

// ─── Refresh derived OrgUnit contexts ───────────────────────────────────────
// Replaces v4's Build-FGContexts.ps1 (which talked directly to SQL Server).
// Recomputes the Contexts table from Principals: one row per (systemId, department)
// for users that have a department set. Members get a managerId derived from
// the most common manager in the department. Idempotent — safe to call after
// every sync. The crawler/dispatcher calls this once at end-of-sync.
router.post('/admin/refresh-contexts', async (req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });
  if (!isAdminRequest(req)) {
    // Allow when called from a crawler with the 'admin' permission too
    if (!req.crawler || !(req.crawler.permissions || []).includes('admin')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  try {
    const start = Date.now();
    // Wipe and rebuild — Contexts is fully derived, no manual edits to preserve.
    // The unique key on (systemId, department) keeps the table small (a few hundred rows).
    const r = await db.tx(async (client) => {
      await client.query(`DELETE FROM "Contexts"`);
      const ins = await client.query(`
        INSERT INTO "Contexts" (id, "systemId", "contextType", "displayName", department, "memberCount", "lastCalculatedAt", "sourceType")
        SELECT
          gen_random_uuid(),
          "systemId",
          'Department',
          department,
          department,
          COUNT(*)::int,
          now(),
          'derived'
        FROM "Principals"
        WHERE department IS NOT NULL AND department <> ''
          AND "systemId" IS NOT NULL
        GROUP BY "systemId", department
        RETURNING id
      `);
      return ins.rowCount;
    });
    return res.json({ ok: true, contextsCreated: r, durationMs: Date.now() - start });
  } catch (err) {
    console.error('refresh-contexts failed:', err.message);
    return res.status(500).json({ error: 'refresh-contexts failed', message: err.message });
  }
});

// Helper: detect whether the request came from an interactive admin user.
// In v5, the only mutation surface for admin endpoints is either an authenticated
// UI session or a crawler with the 'admin' permission. We check both.
function isAdminRequest(req) {
  return !!req.user; // any signed-in UI user
}

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
        (SELECT COUNT(*)::int FROM "ResourceAssignments" WHERE "assignmentType" = 'Governed')  AS "governedAssignments",
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

    res.json({
      ...stats,
      llmConfigured,
      hasData: (stats.users || 0) + (stats.resources || 0) > 0,
    });
  } catch (err) {
    console.error('dashboard-stats failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
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

router.put('/admin/history-retention', async (req, res) => {
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

router.post('/admin/history-retention/prune', adminDestructiveLimiter, async (_req, res) => {
  if (process.env.USE_SQL !== 'true') return res.status(503).json({ error: 'SQL not configured' });
  try {
    const r = await db.queryOne(
      `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
      [HISTORY_RETENTION_KEY]
    );
    const days = r ? parseInt(r.configValue, 10) : HISTORY_RETENTION_DEFAULT;
    if (days <= 0) return res.json({ deleted: 0, message: 'Retention disabled (0 days) — nothing pruned' });
    const del = await db.query(
      `DELETE FROM "_history" WHERE "changedAt" < now() - ($1::int * interval '1 day')`,
      [days]
    );
    res.json({ deleted: del.rowCount || 0, retentionDays: days });
  } catch (err) {
    console.error('history-retention prune failed:', err.message);
    res.status(500).json({ error: 'Prune failed' });
  }
});

// ─── Authentication settings (read-only) ────────────────────────────────────
// Returns the current snapshot so the Admin → Authentication page can show
// status. There is intentionally NO mutation endpoint — changing auth requires
// `docker compose exec web node /app/backend/src/cli/auth-config.js`. This
// avoids the chicken-and-egg of an unauthenticated mutation surface (the only
// time you'd ever need to change auth from inside the app is when you're
// not signed in yet, which would require leaving the API write-open).
router.get('/admin/auth-settings', (req, res) => {
  const s = getAuthState();
  res.json({
    enabled:       s.enabled,
    tenantId:      s.tenantId || '',
    clientId:      s.clientId || '',
    requiredRoles: s.requiredRoles || [],
    loaded:        s.loaded,
  });
});

// ─── Container stats (Docker socket) ─────────────────────────────────────────
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

function dockerRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: DOCKER_SOCKET, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`Docker API ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('Docker API timeout')); });
    req.end();
  });
}

function calcCpuPercent(stats) {
  const cpu = stats.cpu_stats || {};
  const pre = stats.precpu_stats || {};
  const cpuDelta = (cpu.cpu_usage?.total_usage || 0) - (pre.cpu_usage?.total_usage || 0);
  const sysDelta = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0);
  const cores = cpu.online_cpus || cpu.cpu_usage?.percpu_usage?.length || 1;
  if (sysDelta > 0 && cpuDelta > 0) return (cpuDelta / sysDelta) * cores * 100;
  return 0;
}

function sumNet(stats) {
  const nets = stats.networks || {};
  let rx = 0, tx = 0;
  for (const k of Object.keys(nets)) { rx += nets[k].rx_bytes || 0; tx += nets[k].tx_bytes || 0; }
  return { rx, tx };
}

router.get('/admin/container-stats', async (req, res) => {
  try {
    const containers = await dockerRequest('/containers/json?all=0');
    const wanted = containers.filter(c => {
      const names = (c.Names || []).map(n => n.replace(/^\//, ''));
      return names.some(n => /(?:fortigigraph|identityatlas|identity[-_]atlas)[-_](postgres|web|worker)/i.test(n));
    });

    const results = await Promise.all(wanted.map(async (c) => {
      const name = (c.Names[0] || '').replace(/^\//, '');
      const service = (name.match(/(postgres|web|worker)/i) || [])[1]?.toLowerCase() || name;
      try {
        const stats = await dockerRequest(`/containers/${c.Id}/stats?stream=false`);
        const memUsage = stats.memory_stats?.usage || 0;
        const memLimit = stats.memory_stats?.limit || 0;
        const net = sumNet(stats);
        return {
          name, service,
          state: c.State,
          status: c.Status,
          cpuPercent: calcCpuPercent(stats),
          memUsageBytes: memUsage,
          memLimitBytes: memLimit,
          memPercent: memLimit > 0 ? (memUsage / memLimit) * 100 : 0,
          netRxBytes: net.rx,
          netTxBytes: net.tx,
          pids: stats.pids_stats?.current || 0,
        };
      } catch (err) {
        return { name, service, state: c.State, status: c.Status, error: err.message };
      }
    }));

    const order = { web: 0, worker: 1, postgres: 2 };
    results.sort((a, b) => (order[a.service] ?? 99) - (order[b.service] ?? 99));
    res.json({ containers: results, timestamp: new Date().toISOString() });
  } catch (err) {
    // Docker socket not mounted or not accessible — degrade gracefully.
    // This is a monitoring endpoint; a hard 500 breaks the nightly smoke test
    // and the Admin dashboard for no good reason.
    res.json({ containers: [], unavailable: true, reason: err.message, timestamp: new Date().toISOString() });
  }
});

export default router;

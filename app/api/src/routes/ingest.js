// Ingest API routes — translates HTTP requests into engine.ingest() calls.
//
// Same external contract as v4: { systemId, syncMode, records, scope?,
// syncSession?, syncId? } → { inserted, updated, deleted, durationMs }.
// The crawlers don't need to change.

import { Router } from 'express';
import * as db from '../db/connection.js';
import { ingest, writeSyncLog, SOFT_DELETE_TABLES } from '../ingest/engine.js';
import { normalizeRecords } from '../ingest/normalization.js';
import { validateEnvelope, validateRecords, ENTITY_TABLE_MAP, ENTITY_KEY_MAP, ENTITY_SCOPE_MAP } from '../ingest/validation.js';
import { startSession, continueSession, endSession, hasSession } from '../ingest/sessions.js';
import { crawlerHasSystemAccess, crawlerHasPermission } from '../middleware/crawlerAuth.js';
import { bumpSyncVersion } from '../lib/syncVersion.js';
import { breakCycles } from '../contexts/cycleGuard.js';
import { normalizePresenceQuery, lookupCrawlerPresence } from '../ingest/crawlerPresence.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// Normalise a body's records array + fill NOT-NULL key defaults the engine
// relies on. Pure (mutates `body.records`). Exported for unit tests.
//   • records may arrive as null from PS crawlers sending delta-only-deletes.
//   • `governed` is part of the assignment unique key (migration 047), NOT NULL.
//   • `governanceResource` is NOT NULL on Resources — derived from resourceType.
export function applyIngestDefaults(entityType, body) {
  if (!Array.isArray(body.records)) body.records = [];
  if (entityType === 'resource-assignments' || entityType === 'resource-assignments-identity') {
    for (const r of body.records) { if (r && r.governed === undefined) r.governed = false; }
  }
  if (entityType === 'resources') {
    for (const r of body.records) {
      if (r && r.governanceResource === undefined) r.governanceResource = (r.resourceType === 'BusinessRole');
    }
  }
}

// Recover the system-only prefix used to namespace deterministic GUIDs.
// Callers build idPrefix as "<systemPrefix>-<entitySuffix>" where the suffix is
// this endpoint's slug (e.g. "context-members"). Stripping that known suffix
// recovers <systemPrefix> intact even when it contains hyphens, so cross-entity
// externalId references resolve to the SAME GUID the referenced entity was
// created under. Pure. Exported for unit tests.
export function recoverSystemPrefix(entityType, rawIdPrefix) {
  const idPrefix = rawIdPrefix || '';
  const entitySuffix = '-' + entityType.split('/').pop();
  const systemPrefix = idPrefix.endsWith(entitySuffix)
    ? idPrefix.slice(0, -entitySuffix.length)
    : idPrefix.split('-')[0];
  return { idPrefix, systemPrefix };
}

// Project a caller-supplied scope onto this entity's allowed scope columns.
// Pure. Exported for unit tests.
export function buildScope(bodyScope, scopeColumns) {
  const scope = {};
  if (bodyScope) {
    for (const col of scopeColumns) {
      if (bodyScope[col] !== undefined) scope[col] = bodyScope[col];
    }
  }
  return scope;
}

// Both resource-assignments endpoints use partial unique indexes (migration 036
// replaced the composite PK). The returned WHERE clause is required for
// PostgreSQL to resolve the ON CONFLICT target against the partial index, and is
// reused as the scope-delete filter to prevent full-sync cross-contamination
// between the two arms. Pure. Exported for unit tests.
export function conflictFilterFor(entityType) {
  return entityType === 'resource-assignments'          ? '"principalId" IS NOT NULL' :
         entityType === 'resource-assignments-identity' ? '"identityId" IS NOT NULL'  :
         null;
}

// Discover a table's real columns (snake_case) and return them camelCased for
// the normalizer (records arrive in camelCase). Exported for unit tests.
export async function discoverCoreColumns(tableName) {
  const colResult = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return colResult.rows.map(r => r.column_name.replace(/_([a-z])/g, (_, c) => c.toUpperCase()));
}

// Handle the multi-batch session commands (start / continue / end). Returns a
// { status, body } response to send, or null when this isn't a session request
// (fall through to the single-batch path). Exported for unit tests.
export async function handleSessionPath(body, ctx) {
  const { tableName, keyColumns, normalized, scope, scopeDeleteFilter, conflictFilter } = ctx;
  if (body.syncSession === 'start') {
    const result = await startSession(null, tableName, keyColumns, normalized, {
      systemId: body.systemId, scope, syncMode: body.syncMode || 'full',
      scopeDeleteFilter, conflictFilter,
    });
    return { status: 201, body: {
      syncId: result.syncId, table: tableName,
      inserted: result.inserted, updated: result.updated, session: 'started',
    } };
  }
  if (body.syncSession === 'continue') {
    if (!body.syncId || !hasSession(body.syncId)) return { status: 400, body: { error: 'Invalid or expired syncId' } };
    const result = await continueSession(body.syncId, null, normalized, keyColumns);
    return { status: 200, body: {
      syncId: result.syncId, table: tableName,
      inserted: result.inserted, updated: result.updated, session: 'continued',
    } };
  }
  if (body.syncSession === 'end') {
    if (!body.syncId || !hasSession(body.syncId)) return { status: 400, body: { error: 'Invalid or expired syncId' } };
    const result = await endSession(body.syncId, null, normalized, keyColumns, { syncMode: body.syncMode || 'full' });
    return { status: 200, body: {
      syncId: result.syncId, table: tableName,
      inserted: result.inserted, updated: result.updated, deleted: result.deleted,
      totalRecords: result.totalRecords, session: 'completed',
    } };
  }
  return null;
}

// Explicit delete-by-id path (Graph /delta @removed rows). Validates the ids are
// UUIDs, soft- or hard-deletes them, and adds the count to `result.deleted`.
// Returns a { status, body } error response, or null on success / no-op.
// Exported for unit tests.
export async function applyDeleteByIds(body, tableName, result) {
  if (!Array.isArray(body.deletedIds) || body.deletedIds.length === 0) return null;
  // Reject the whole batch if any entry isn't a UUID to avoid ambiguous deletes.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const bad = body.deletedIds.find(v => typeof v !== 'string' || !uuidRe.test(v));
  if (bad) return { status: 400, body: { error: `deletedIds must be UUIDs (got '${String(bad).slice(0, 50)}')` } };
  try {
    // Soft-delete tables stamp deletedAt (kept for audit); others hard-delete.
    const delRes = SOFT_DELETE_TABLES.has(tableName)
      ? await db.query(`UPDATE "${tableName}" SET "deletedAt" = now() WHERE id = ANY($1::uuid[]) AND "deletedAt" IS NULL`, [body.deletedIds])
      : await db.query(`DELETE FROM "${tableName}" WHERE id = ANY($1::uuid[])`, [body.deletedIds]);
    result.deleted += delRes.rowCount || 0;
    return null;
  } catch (delErr) {
    console.error(`Delete-by-id failed on ${tableName}:`, delErr.message);
    return { status: 500, body: { error: 'Delete-by-id failed', message: delErr.message } };
  }
}

// Systems endpoint only: resolve the resulting system IDs so crawlers can use
// them in subsequent calls without hardcoding. Returns an array or undefined.
// Exported for unit tests.
export async function lookupSystemIds(entityType, records) {
  if (entityType !== 'systems' || records.length === 0) return undefined;
  try {
    const ids = [];
    for (const rec of records) {
      let row;
      if (rec.tenantId && rec.systemType) {
        row = await db.queryOne(`SELECT id FROM "Systems" WHERE "tenantId" = $1 AND "systemType" = $2 ORDER BY id DESC LIMIT 1`, [rec.tenantId, rec.systemType]);
      } else if (rec.displayName) {
        row = await db.queryOne(`SELECT id FROM "Systems" WHERE "displayName" = $1 ORDER BY id DESC LIMIT 1`, [rec.displayName]);
      }
      if (row) ids.push(row.id);
    }
    return ids.length > 0 ? ids : undefined;
  } catch (lookupErr) {
    console.error('Failed to look up system IDs after ingest:', lookupErr.message);
    return undefined;
  }
}

// Best-effort crawler audit-log row. Fire-and-forget. Exported for unit tests.
export function writeAuditLog(req, body) {
  if (!req.crawler) return;
  db.query(
    `INSERT INTO "CrawlerAuditLog" ("crawlerId", "action", "endpoint", "recordCount", "statusCode", "ipAddress")
     VALUES ($1, 'ingest', $2, $3, 201, $4)`,
    [req.crawler.id, req.originalUrl, body.records.length, (req.ip || '').slice(0, 45)]
  ).catch(() => {});
}

// Contexts self-reference via parentContextId; a mis-parented synced tree can
// persist a cycle. True prevention isn't feasible for a set-based bulk upsert (a
// batch-internal A->B->A loop is invisible pre-persist), so repair reactively per
// contexts batch — don't wait for the end-of-sync refresh-views call, which a
// delta/partial crawl may never make. No-op on a clean tree. Extracted from the
// handler so the generic ingest path stays under the complexity ceiling.
async function repairContextCyclesAfterIngest(entityType, result) {
  if (entityType !== 'contexts' || (result.inserted + result.updated) <= 0) return;
  try {
    const broken = await breakCycles(db);
    if (broken) console.warn(`Ingest contexts: broke ${broken} cyclic parentContextId link(s)`);
  } catch (cycErr) {
    console.warn('Ingest contexts cycle repair failed (non-fatal):', cycErr.message);
  }
}

function createIngestHandler(entityType) {
  const tableName = ENTITY_TABLE_MAP[entityType];   // snake_case in v5
  const keyColumns = ENTITY_KEY_MAP[entityType];     // camelCase from caller; engine converts
  const scopeColumns = ENTITY_SCOPE_MAP[entityType] || [];

  return async (req, res) => {
    if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
    if (!crawlerHasPermission(req, 'ingest')) return res.status(403).json({ error: 'Insufficient permissions' });

    const body = req.body;

    const envResult = validateEnvelope(body, entityType);
    if (!envResult.valid) {
      console.warn(`Ingest validation failed [${entityType}]:`, envResult.errors);
      return res.status(400).json({ error: 'Validation failed', details: envResult.errors });
    }
    if (entityType !== 'systems' && !crawlerHasSystemAccess(req, body.systemId)) {
      return res.status(403).json({ error: `Crawler does not have access to system ${body.systemId}` });
    }

    applyIngestDefaults(entityType, body);

    const recResult = validateRecords(body.records, entityType, body.idGeneration, body.syncMode);
    if (!recResult.valid) {
      // Both branches are hardcoded literals so syncMode is never tainted (log-injection fix).
      const syncMode = body.syncMode === 'delta' ? 'delta' : 'full';
      console.warn(`Ingest record validation failed (${syncMode} mode): ${recResult.errors.length} error(s)`);
      return res.status(400).json({ error: 'Record validation failed', details: recResult.errors });
    }

    const startTime = new Date();
    try {
      const coreColumns = await discoverCoreColumns(tableName);
      const { idPrefix, systemPrefix } = recoverSystemPrefix(entityType, body.idPrefix);
      const normalized = normalizeRecords(body.records, coreColumns, {
        idGeneration: body.idGeneration || 'native', idPrefix, systemPrefix, systemId: body.systemId,
      });
      const scope = buildScope(body.scope, scopeColumns);
      const conflictFilter = conflictFilterFor(entityType);
      const scopeDeleteFilter = conflictFilter;

      // ── Session paths ─────────────────────────────────────────────
      const sessionRes = await handleSessionPath(body, { tableName, keyColumns, normalized, scope, scopeDeleteFilter, conflictFilter });
      if (sessionRes) return res.status(sessionRes.status).json(sessionRes.body);

      // ── Single-batch path ─────────────────────────────────────────
      const result = body.records.length > 0
        ? await ingest(null, tableName, keyColumns, normalized, {
            syncMode: body.syncMode || 'delta', systemId: body.systemId, scope, scopeDeleteFilter, conflictFilter,
          })
        : { inserted: 0, updated: 0, deleted: 0 };

      const delErr = await applyDeleteByIds(body, tableName, result);
      if (delErr) return res.status(delErr.status).json(delErr.body);

      await repairContextCyclesAfterIngest(entityType, result);

      await writeSyncLog(null, `API-${entityType}`, tableName, startTime,
                         body.records.length, result.inserted, result.updated, result.deleted, null);
      writeAuditLog(req, body);

      const durationMs = Date.now() - startTime.getTime();
      const systemIds = await lookupSystemIds(entityType, body.records);

      return res.status(201).json({
        table: tableName,
        inserted: result.inserted,
        updated: result.updated,
        deleted: result.deleted,
        records: body.records.length,
        durationMs,
        ...(systemIds ? { systemIds } : {}),
      });
    } catch (err) {
      console.error(`Ingest error (${entityType}):`, err.message);
      await writeSyncLog(null, `API-${entityType}`, tableName, startTime,
                         body.records?.length || 0, 0, 0, 0, err.message).catch(() => {});
      return res.status(500).json({ error: 'Ingest failed', message: err.message });
    }
  };
}

router.post('/ingest/systems',                  createIngestHandler('systems'));
router.post('/ingest/principals',               createIngestHandler('principals'));
router.post('/ingest/resources',                createIngestHandler('resources'));
router.post('/ingest/resource-assignments',          createIngestHandler('resource-assignments'));
router.post('/ingest/resource-assignments-identity', createIngestHandler('resource-assignments-identity'));
router.post('/ingest/resource-relationships',   createIngestHandler('resource-relationships'));
router.post('/ingest/principal-relationships',  createIngestHandler('principal-relationships'));
router.post('/ingest/identities',               createIngestHandler('identities'));
router.post('/ingest/identity-members',         createIngestHandler('identity-members'));
router.post('/ingest/contexts',                 createIngestHandler('contexts'));
router.post('/ingest/context-members',          createIngestHandler('context-members'));
router.post('/ingest/governance/catalogs',      createIngestHandler('governance/catalogs'));
router.post('/ingest/governance/policies',      createIngestHandler('governance/policies'));
router.post('/ingest/governance/requests',      createIngestHandler('governance/requests'));
router.post('/ingest/governance/certifications', createIngestHandler('governance/certifications'));
router.post('/ingest/principal-activity',       createIngestHandler('principal-activity'));

// POST /api/ingest/principals-presence — given a set of Azure AD objectIds and a
// tenantId, return which of them the crawler has already loaded from Entra ID (as a
// Principal, or as a Resource such as a group). The Azure RM crawler uses this to
// filter or flag role-assignment holders the Entra crawler hasn't loaded — deleted
// SPs with dangling assignments, or principals outside a scoped (e.g. admins-only)
// Entra crawl. `crawlerDataAvailable=false` means the crawler has loaded no Entra
// data for that tenant yet, so the caller must NOT treat everything as orphaned.
router.post('/ingest/principals-presence', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!crawlerHasPermission(req, 'ingest')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { tenantId, ids } = normalizePresenceQuery(req.body);
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
  try {
    res.json(await lookupCrawlerPresence(db, tenantId, ids));
  } catch (err) {
    console.error('principals-presence lookup failed:', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// POST /api/ingest/refresh-views — no-op in v5.
//
// In v4 we had a materialised table `mat_UserPermissionAssignments` that the
// crawler refreshed at end-of-sync. In postgres we don't need it: the views
// are unmaterialised, postgres MVCC keeps reads cheap during writes, and the
// recursive CTE is fast enough at our scale. The endpoint is kept for
// backward compatibility with crawler scripts that still call it.
// POST /api/ingest/sync-log — write a single GraphSyncLog row.
//
// Per-entity ingest calls already write their own GraphSyncLog rows (via
// writeSyncLog inside each handler), but those reflect only the *bulk insert*
// time, not the time the crawler spent fetching from Microsoft Graph. The
// crawler script calls this endpoint at the end of a run to record one row
// covering the *full* sync duration so the Sync Log page reflects reality.
router.post('/ingest/sync-log', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!crawlerHasPermission(req, 'ingest')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { syncType, tableName, startTime, endTime, recordCount, status, errorMessage } = req.body || {};
  if (!syncType || !startTime) {
    return res.status(400).json({ error: 'syncType and startTime are required' });
  }
  try {
    const start = new Date(startTime);
    const end = endTime ? new Date(endTime) : new Date();
    const duration = Math.max(0, Math.round((end - start) / 1000));
    await db.query(
      `INSERT INTO "GraphSyncLog"
         ("SyncType", "TableName", "StartTime", "EndTime", "DurationSeconds", "RecordCount", "Status", "ErrorMessage")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [syncType, tableName || null, start, end, duration, recordCount || 0, status || 'Success', errorMessage || null]
    );
    return res.status(201).json({ ok: true, durationSeconds: duration });
  } catch (err) {
    console.error('sync-log write failed:', err.message);
    return res.status(500).json({ error: 'Failed to write sync log' });
  }
});

// POST /api/ingest/classify-business-role-assignments — flag memberships in a
// governance resource (business role / access package) as governed=true. Flat
// importers (CSV) don't know which resources are governance resources at
// assignment-import time, so this marks them after the fact. The provisioning
// gap is DERIVED in the matrix matview from these governed memberships + the
// Contains relationships — nothing is materialised here.
router.post('/ingest/classify-business-role-assignments', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!crawlerHasPermission(req, 'ingest')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  try {
    const r = await db.query(`
      UPDATE "ResourceAssignments" ra
         SET "governed" = true
        FROM "Resources" r
       WHERE r.id = ra."resourceId"
         AND r."governanceResource"
         AND ra."governed" = false
    `);
    // The matrix materialized views are now stale — refresh them before
    // returning so the UI sees the new data.
    let viewRefresh;
    try {
      await refreshMatrixViews();
      viewRefresh = 'ok';
    } catch (err) {
      console.error('classify: view refresh failed (non-critical):', err.message);
      viewRefresh = 'failed';
    }
    return res.json({
      ok: true,
      governedMarked: r.rowCount || 0,
      viewRefresh,
    });
  } catch (err) {
    console.error('classify-business-role-assignments failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/ingest/refresh-views — refresh the matrix materialized views.
//
// Called by the CSV crawler at end-of-sync (and by classify-business-role-
// assignments after regenerating governed-intent rows). Uses REFRESH MATERIALIZED
// VIEW CONCURRENTLY so reads during the refresh see the old data rather
// than blocking — the unique index created in migration 013 is required
// for CONCURRENTLY to work.
//
// REFRESH cannot run inside a transaction, so each matview is refreshed
// on a fresh connection.
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

export { refreshMatrixViews };

export default router;

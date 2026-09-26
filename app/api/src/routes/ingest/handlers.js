// Ingest route handlers — the generic per-entity ingest endpoints (built by
// createIngestHandler) plus principals-presence, sync-log and the
// classify-business-role-assignments endpoints.
//
// Extracted verbatim from routes/ingest.js (audit finding C1). Mounted by
// routes/ingest.js via router.use() so the public paths are unchanged. No
// behaviour change — pure code move.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { ingest, writeSyncLog } from '../../ingest/engine.js';
import { normalizeRecords, extendedAttributesBoundsError } from '../../ingest/normalization.js';
import {
  restrictedSystemIds, writableCoreColumns, systemBoundaryDenial,
  preservedOwnerColumns, linkDirectorySystems,
} from '../../ingest/systemBoundary.js';
import { validateEnvelope, validateRecords, ENTITY_TABLE_MAP, ENTITY_KEY_MAP, ENTITY_SCOPE_MAP } from '../../ingest/validation.js';
import { crawlerHasSystemAccess, crawlerHasPermission } from '../../middleware/crawlerAuth.js';
import { normalizePresenceQuery, lookupCrawlerPresence } from '../../ingest/crawlerPresence.js';
import { parseReconcileRequest, reconcileStale, ReconcileRequestError } from '../../ingest/reconcileStale.js';
import { viewRefresh } from './matrixViews.js';
import { buildSyncLogRow, classifyScope } from './dataPlane.js';
import {
  applyIngestDefaults, coerceSystemsSyncMode, recoverSystemPrefix, buildScope, conflictFilterFor, discoverCoreColumns,
  handleSessionPath, applyDeleteByIds, lookupSystemIds, linkSystemDirectories, writeAuditLog, ingestErrorResponse,
} from './helpers.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// Checks on the normalized batch before anything is written: the extendedAttributes
// bounds (every caller, L-16) and, for a key restricted to specific systems, the
// per-system boundary (H-04). Returns { status, error } or null.
async function batchBoundaryError(req, body, allowed, ctx) {
  const boundsErr = extendedAttributesBoundsError(ctx.normalized);
  if (boundsErr) return { status: 400, error: boundsErr };
  if (!allowed) return null;
  const denial = await systemBoundaryDenial({ ...ctx, records: ctx.normalized, syncMode: body.syncMode, allowed });
  if (!denial) return null;
  console.warn(`Ingest denied for crawler ${req.crawler?.id}: ${denial}`);
  return { status: 403, error: denial };
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
    coerceSystemsSyncMode(entityType, body);
    const allowed = restrictedSystemIds(req.crawler);

    const startTime = new Date();
    try {
      const coreColumns = writableCoreColumns(await discoverCoreColumns(tableName));
      const { idPrefix, systemPrefix } = recoverSystemPrefix(entityType, body.idPrefix);
      const normalized = normalizeRecords(body.records, coreColumns, {
        idGeneration: body.idGeneration || 'native', idPrefix, systemPrefix, systemId: body.systemId,
      });
      const scope = buildScope(body.scope, scopeColumns);
      const conflictFilter = conflictFilterFor(entityType);
      const scopeDeleteFilter = conflictFilter;

      const boundaryErr = await batchBoundaryError(req, body, allowed, { tableName, keyColumns, normalized, scope, conflictFilter });
      if (boundaryErr) return res.status(boundaryErr.status).json({ error: boundaryErr.error });

      // A system that declares a directorySystemId reads the directory's principals
      // and resources; it does not own them. Resolved once per batch — one PK lookup
      // on a table with a handful of rows — and applied to both write paths (#1247).
      const preserveColumns = await preservedOwnerColumns(tableName, body.systemId);

      // ── Session paths ─────────────────────────────────────────────
      const sessionRes = await handleSessionPath(body, {
        tableName, keyColumns, normalized, scope, scopeDeleteFilter, conflictFilter, preserveColumns,
        crawlerId: req.crawler?.id, isWorker: crawlerHasPermission(req, 'admin'), restrictSystemIds: allowed,
      });
      if (sessionRes) return res.status(sessionRes.status).json(sessionRes.body);

      // ── Single-batch path ─────────────────────────────────────────
      // Called even for an empty batch: ingest() owns what "no records" means,
      // and the answer differs by sync mode. An empty DELTA does nothing; an
      // empty FULL says "this scope is empty now" and reconciles its rows away,
      // which is how a crawler clears a source that no longer serves anything.
      // Short-circuiting here meant that batch was accepted and silently ignored.
      const result = await ingest(null, tableName, keyColumns, normalized, {
        syncMode: body.syncMode || 'delta', systemId: body.systemId, scope, scopeDeleteFilter, conflictFilter,
        restrictSystemIds: allowed, preserveColumns,
      });

      const delErr = await applyDeleteByIds(body, tableName, result, allowed);
      if (delErr) return res.status(delErr.status).json(delErr.body);

      // Context-tree acyclicity is enforced at the database (migration 059's
      // deferred trigger) — a cyclic batch aborts the ingest() commit above and is
      // handled in catch. The old post-ingest breakCycles repair is gone: it
      // silently NULLed an edge instead of surfacing the malformed input.

      await writeSyncLog(null, `API-${entityType}`, tableName, startTime,
                         body.records.length, result.inserted, result.updated, result.deleted, null);
      writeAuditLog(req, body);

      const durationMs = Date.now() - startTime.getTime();
      await linkSystemDirectories(entityType);
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
      // 422 for a context-cycle rejection (migration 059's trigger), else 500.
      const errRes = ingestErrorResponse(err);
      return res.status(errRes.status).json(errRes.body);
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
  const { tenantId, ids, systemId } = normalizePresenceQuery(req.body);
  if (!tenantId) return res.status(400).json({ error: 'tenantId is required' });
  try {
    // A key restricted to specific systems only sees presence in those systems
    // (SEC-2026-09 M-05); an unrestricted key keeps the tenant-wide lookup. The
    // caller's own systemId (optional) resolves its declared directory (#1247).
    res.json(await lookupCrawlerPresence(db, tenantId, ids, restrictedSystemIds(req.crawler), systemId));
  } catch (err) {
    console.error('principals-presence lookup failed:', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// POST /api/ingest/reconcile — the full-sync delete for a STREAMED sync.
//
// A crawler that cannot hold its source in memory (the SQL crawler's tens of
// millions of entitlement assignments) upserts independent delta chunks and then
// calls this once per (entity, scope): every row of that system + scope that no
// ingest has touched since `before` is reconciled away — soft-deleted on the
// soft-delete tables, removed elsewhere. `before` should be the `serverTime` the
// crawler read from GET /crawlers/whoami when its run started, so the comparison
// is against this container's clock, never the worker's. See ingest/reconcileStale.js.
router.post('/ingest/reconcile', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!crawlerHasPermission(req, 'ingest')) return res.status(403).json({ error: 'Insufficient permissions' });
  let parsed;
  try { parsed = parseReconcileRequest(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  if (!crawlerHasSystemAccess(req, parsed.systemId)) {
    return res.status(403).json({ error: `Crawler does not have access to system ${parsed.systemId}` });
  }
  const { entity, tableName, systemId, before } = parsed;
  const scope = buildScope(req.body.scope, ENTITY_SCOPE_MAP[entity] || []);
  const startTime = new Date();
  try {
    const deleted = await reconcileStale(tableName, {
      systemId, scope, before, scopeDeleteFilter: conflictFilterFor(entity), restrictSystemIds: restrictedSystemIds(req.crawler),
    });
    await writeSyncLog(null, `API-${entity}-reconcile`, tableName, startTime, 0, 0, 0, deleted, null);
    return res.json({ table: tableName, deleted, before });
  } catch (err) {
    if (err instanceof ReconcileRequestError) return res.status(400).json({ error: err.message });
    // `entity` reaches here only after parseReconcileRequest matched it against a
    // fixed table map, so it is one of a known set — but it still arrives in the
    // request body. Keep it out of the format string and strip line breaks, so no
    // caller can garble or forge a log line (CWE-134 / CWE-117).
    const safeEntity = String(entity).replace(/[\r\n]+/g, ' ');
    console.error('Reconcile error (%s): %s', safeEntity, err.message);
    return res.status(500).json({ error: 'Reconcile failed' });
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
  // The row is stamped with the authenticated crawler (and a system it may access),
  // so a key cannot write entries that pass for another crawler's (SEC-2026-09 M-05).
  const row = buildSyncLogRow(req.body, req.crawler);
  if (row.error) return res.status(row.status).json({ error: row.error });
  try {
    await db.query(
      `INSERT INTO "GraphSyncLog"
         ("SyncType", "TableName", "StartTime", "EndTime", "DurationSeconds", "RecordCount", "Status", "ErrorMessage",
          "crawlerId", "systemId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      row.values
    );
    return res.status(201).json({ ok: true, durationSeconds: row.duration });
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
//
// It ends by asking for a matview refresh, so it needs the refreshViews
// permission; the UPDATE is limited to the systems the caller may access. The
// refresh runs in the background through the shared coordinator (debounced,
// serialised with every other crawler-triggered refresh — SEC-2026-09 M-05), so
// this request returns as soon as the UPDATE has committed.
router.post('/ingest/classify-business-role-assignments', async (req, res) => {
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  if (!crawlerHasPermission(req, 'refreshViews')) {
    return res.status(403).json({ error: 'Insufficient permissions (requires refreshViews)' });
  }
  const scope = classifyScope(req.body, req.crawler);
  if (scope.error) return res.status(scope.status).json({ error: scope.error });
  try {
    const r = await db.query(`
      UPDATE "ResourceAssignments" ra
         SET "governed" = true
        FROM "Resources" r
       WHERE r.id = ra."resourceId"
         AND r."governanceResource"
         AND ra."governed" = false${scope.clause}
    `, scope.params);
    // The matrix materialized views are now stale. Schedule the refresh; its
    // outcome is readable at GET /ingest/refresh-views.
    const refresh = viewRefresh.schedule('classify-business-role-assignments');
    return res.json({
      ok: true,
      governedMarked: r.rowCount || 0,
      viewRefresh: 'scheduled',
      refresh,
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

export default router;

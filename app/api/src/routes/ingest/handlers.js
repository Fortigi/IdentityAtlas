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
import { normalizeRecords } from '../../ingest/normalization.js';
import { validateEnvelope, validateRecords, ENTITY_TABLE_MAP, ENTITY_KEY_MAP, ENTITY_SCOPE_MAP } from '../../ingest/validation.js';
import { crawlerHasSystemAccess, crawlerHasPermission } from '../../middleware/crawlerAuth.js';
import { normalizePresenceQuery, lookupCrawlerPresence } from '../../ingest/crawlerPresence.js';
import {
  applyIngestDefaults, recoverSystemPrefix, buildScope, conflictFilterFor, discoverCoreColumns,
  handleSessionPath, applyDeleteByIds, lookupSystemIds, writeAuditLog,
} from './helpers.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

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

      // Context-tree acyclicity is enforced at the database (migration 059's
      // deferred trigger) — a cyclic batch aborts the ingest() commit above and is
      // handled in catch. The old post-ingest breakCycles repair is gone: it
      // silently NULLed an edge instead of surfacing the malformed input.

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
      // A parentContextId cycle is rejected at COMMIT by the Contexts acyclicity
      // trigger (migration 059). Surface it as a clear 422 (the batch's source
      // tree is malformed — the caller's to fix) rather than an opaque 500.
      if (err.code === '23514' && /parentContextId cycle/i.test(err.message || '')) {
        return res.status(422).json({ error: 'Context hierarchy would create a cycle', message: err.message });
      }
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

export default router;

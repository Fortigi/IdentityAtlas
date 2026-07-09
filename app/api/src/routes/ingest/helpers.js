// Ingest engine helpers — pure/DB helpers the ingest route handler composes
// (defaults, scope, conflict filter, column discovery, session paths,
// delete-by-id, system-id lookup, audit log, cycle repair).
//
// Extracted from routes/ingest.js (audit finding C1). The pure helpers are unit-
// tested (ingest.helpers.test.js) and re-exported by routes/ingest.js. No
// behaviour change — pure code move.

import * as db from '../../db/connection.js';
import { ingest, SOFT_DELETE_TABLES } from '../../ingest/engine.js';
import { startSession, continueSession, endSession, hasSession } from '../../ingest/sessions.js';
import { breakCycles } from '../../contexts/cycleGuard.js';

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
export async function repairContextCyclesAfterIngest(entityType, result) {
  if (entityType !== 'contexts' || (result.inserted + result.updated) <= 0) return;
  try {
    const broken = await breakCycles(db);
    if (broken) console.warn(`Ingest contexts: broke ${broken} cyclic parentContextId link(s)`);
  } catch (cycErr) {
    console.warn('Ingest contexts cycle repair failed (non-fatal):', cycErr.message);
  }
}

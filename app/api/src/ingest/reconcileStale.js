// Timestamp reconcile — the full-sync delete for a STREAMED sync.
//
// A sync session (start → continue → end) reconciles by set difference: every
// key the run sent goes into a temp table and whatever is not in it is deleted
// at `end`. That needs the whole run inside one 30-minute session, one pinned
// connection, one giant upsert at the end and a duplicate-free payload — none of
// which holds for a source of tens of millions of rows (the SQL crawler's
// entitlement assignments are the motivating case).
//
// A streamed run instead upserts independent delta chunks — each of which
// stamps `updatedAt = now()` on every row it touches (see updatedAtStamp in
// engine.js) — and then asks for the rows it did NOT touch to be reconciled: the
// rows of that system + scope whose `updatedAt` is older than the moment the run
// started. That is the same set a session's set difference would have found,
// computed from a timestamp the engine already maintains.
//
// Migration 072 is what makes that true: it put `updatedAt` on the entity tables
// (they had none, so updatedAtStamp was a no-op on them and this endpoint
// refused every one) and, in the same breath, taught the history trigger to
// ignore that column — otherwise stamping it would record an audit "change" for
// every re-ingested row, every sync.
//
// `before` is the API's own clock reading, handed to the crawler by
// GET /crawlers/whoami (`serverTime`) at job start, so a clock difference between
// the worker and this container can never make a run reconcile away its own rows.

import * as db from '../db/connection.js';
import { SOFT_DELETE_TABLES, reconcileBounds, reconcileAllowed, discoverColumns } from './engine.js';
import { NO_SYSTEM_COLUMN_TABLES } from './systemBoundary.js';
import { ENTITY_TABLE_MAP } from './validation.js';

export class ReconcileRequestError extends Error {}

// Parse + validate the request body: which table, which system, since when.
// Pure. Throws ReconcileRequestError with an operator-readable message.
export function parseReconcileRequest(body, now = new Date()) {
  const { entity, systemId, before } = body || {};
  const tableName = ENTITY_TABLE_MAP[entity];
  if (!tableName) throw new ReconcileRequestError(`Unknown entity '${String(entity).slice(0, 50)}'`);
  // A table without a systemId column (Identities, IdentityMembers, Contexts …)
  // is shared between every source; a timestamp reconcile of it would delete
  // whatever the OTHER crawlers had not re-touched. Sessions refuse the same.
  if (NO_SYSTEM_COLUMN_TABLES.has(tableName)) {
    throw new ReconcileRequestError(`Entity '${entity}' has no system scope and cannot be reconciled by timestamp`);
  }
  if (!Number.isInteger(systemId) || systemId <= 0) throw new ReconcileRequestError('systemId must be a positive integer');
  const beforeDate = new Date(before);
  if (typeof before !== 'string' || Number.isNaN(beforeDate.getTime())) {
    throw new ReconcileRequestError('before must be an ISO-8601 timestamp');
  }
  // A `before` in the future would delete the rows this very run just wrote.
  if (beforeDate.getTime() > now.getTime()) throw new ReconcileRequestError('before must not be in the future');
  return { entity, tableName, systemId, before: beforeDate.toISOString() };
}

// The reconcile statement. Soft-delete tables stamp deletedAt (and leave an
// already-deleted row's stamp alone); every other table hard-deletes. `clauses`
// and `params` come from reconcileBounds; `before` is appended as the last
// parameter. Pure. Exported for unit tests.
export function buildReconcileStaleSql(tableName, clauses, params, before, scopeDeleteFilter = null) {
  const allParams = [...params, before];
  let where = ['1=1', ...clauses, `t."updatedAt" < $${allParams.length}`].join(' AND ');
  if (scopeDeleteFilter) where += ` AND (${scopeDeleteFilter})`;
  const sql = SOFT_DELETE_TABLES.has(tableName)
    ? `UPDATE "${tableName}" t SET "deletedAt" = now() WHERE ${where} AND t."deletedAt" IS NULL`
    : `DELETE FROM "${tableName}" t WHERE ${where}`;
  return { sql, params: allParams };
}

/**
 * Soft- or hard-delete every row of `tableName` owned by `systemId` (narrowed by
 * `scope`, and by the caller's system restriction) that no ingest has touched
 * since `before`. Returns the number of rows reconciled.
 */
export async function reconcileStale(tableName, { systemId, scope = {}, before, scopeDeleteFilter = null, restrictSystemIds = null }) {
  const columns = await discoverColumns(null, tableName);
  const columnNames = new Set(columns.map(c => c.name));
  if (!columnNames.has('updatedAt') || !columnNames.has('systemId')) {
    throw new ReconcileRequestError(`Table '${tableName}' cannot be reconciled by timestamp`);
  }
  const { params, clauses } = reconcileBounds(tableName, systemId, scope, 'systemId', columnNames, restrictSystemIds);
  // reconcileBounds only emits the systemId clause when the table has the column,
  // which was checked above — so this is never unbounded. Kept as the same
  // belt-and-braces guard scopedDelete runs.
  if (!reconcileAllowed(tableName, clauses, restrictSystemIds)) return 0;
  const { sql, params: allParams } = buildReconcileStaleSql(tableName, clauses, params, before, scopeDeleteFilter);
  const res = await db.query(sql, allParams);
  return res.rowCount || 0;
}

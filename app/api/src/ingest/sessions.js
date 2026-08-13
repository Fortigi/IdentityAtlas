// Multi-batch sync sessions for the ingest API.
//
// When a crawler sends data in chunks (start → continue → end), the session
// keeps a temp table alive across calls so the final scoped delete operates
// on the union of all batches. Without sessions, every batch would think it's
// the full payload and delete everything not in the current chunk.
//
// In v5 (postgres) the session also keeps a *connection* checked out from the
// pool for its entire lifetime — that's the only way the temp table survives
// across requests, since postgres temp tables are session-local. The 30-min
// timeout is a hard upper bound; idle sessions are reaped to free connections.

import crypto from 'crypto';
import { resolveActiveColumns, discoverColumns, writeSyncLog, scopedDelete } from './engine.js';
import * as db from '../db/connection.js';
import { createTempTable, bulkInsertIntoTemp } from './tempTableHelpers.js';

const sessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.startedAt > SESSION_TIMEOUT_MS) {
      // Mark as released first so concurrent endSession doesn't double-release
      if (session.released) continue;
      session.released = true;
      try { await session.client.query('ROLLBACK'); } catch { /* ignore */ }
      try { session.client.release(); } catch { /* ignore */ }
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);


// Batched INSERT instead of COPY FROM STDIN (see engine.js for the reasoning).
// Sessions use a smaller chunk size (200) because session batches are typically
// much smaller than bulk ingest batches and are sent incrementally.
const copyRows = (client, tempTable, activeColumns, records) =>
  bulkInsertIntoTemp(client, tempTable, activeColumns, records, 200);

export async function startSession(_pool, tableName, keyColumns, records, options = {}) {
  const syncId = crypto.randomUUID();
  const activeColumns = await resolveActiveColumns(tableName, records, keyColumns);
  // endSession's full-sync scopedDelete needs the table's full column set (see
  // engine.js) — keep it on the session. Cached, so no extra round-trip.
  const columns = await discoverColumns(null, tableName);

  const pool = await db.getPool();
  const client = await pool.connect();
  await client.query('BEGIN');

  const tempTable = `_tmp_session_${syncId.replace(/-/g, '').slice(0, 16)}`;
  await createTempTable(client, tempTable, activeColumns);

  await copyRows(client, tempTable, activeColumns, records);

  sessions.set(syncId, {
    client,
    tempTable,
    tableName,
    keyColumns,
    activeColumns,
    columns,
    systemId: options.systemId,
    scope: options.scope || {},
    systemIdColumn: options.systemIdColumn || 'systemId',
    scopeDeleteFilter: options.scopeDeleteFilter || null,
    conflictFilter: options.conflictFilter || null,
    startedAt: Date.now(),
    recordCount: records.length,
  });

  return { syncId, inserted: 0, updated: 0, deleted: 0 };
}

export async function continueSession(syncId, _pool, records, _keyColumns) {
  const session = sessions.get(syncId);
  if (!session) throw new Error(`Sync session '${syncId}' not found or expired`);
  await copyRows(session.client, session.tempTable, session.activeColumns, records);
  session.recordCount += records.length;
  return { syncId, inserted: 0, updated: 0, deleted: 0 };
}

export async function endSession(syncId, _pool, records, _keyColumns, options = {}) {
  const session = sessions.get(syncId);
  if (!session) throw new Error(`Sync session '${syncId}' not found or expired`);

  try {
    if (records && records.length > 0) {
      await copyRows(session.client, session.tempTable, session.activeColumns, records);
      session.recordCount += records.length;
    }

    const nonKeyCols = session.activeColumns.filter(c => !session.keyColumns.includes(c.name));
    const insertCols = session.activeColumns.map(c => `"${c.name}"`).join(', ');
    const onConflictCols = session.keyColumns.map(c => `"${c}"`).join(', ');
    const conflictWhere = session.conflictFilter ? ` WHERE ${session.conflictFilter}` : '';

    let upsertSql;
    if (nonKeyCols.length > 0) {
      const updateSet = nonKeyCols.map(c => `"${c.name}" = EXCLUDED."${c.name}"`).join(', ');
      upsertSql = `
        INSERT INTO "${session.tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${session.tempTable}"
        ON CONFLICT (${onConflictCols})${conflictWhere} DO UPDATE SET ${updateSet}
        RETURNING (xmax = 0) AS "wasInsert"
      `;
    } else {
      upsertSql = `
        INSERT INTO "${session.tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${session.tempTable}"
        ON CONFLICT (${onConflictCols})${conflictWhere} DO NOTHING
        RETURNING (xmax = 0) AS "wasInsert"
      `;
    }

    const upsertRes = await session.client.query(upsertSql);
    let inserted = 0, updated = 0;
    for (const row of upsertRes.rows) {
      if (row.wasInsert) inserted++; else updated++;
    }

    let deleted = 0;
    const syncMode = options.syncMode || 'full';
    if (syncMode === 'full') {
      const tableColumnNames = new Set(session.columns.map(c => c.name));
      deleted = await scopedDelete(
        session.client, session.tableName, session.keyColumns, session.tempTable,
        session.systemId, session.scope, session.systemIdColumn, tableColumnNames,
        session.scopeDeleteFilter
      );
    }

    await session.client.query('COMMIT');

    const startTime = new Date(session.startedAt);
    await writeSyncLog(null, `API-${session.tableName}`, session.tableName, startTime,
                       session.recordCount, inserted, updated, deleted, null);

    return {
      syncId, inserted, updated, deleted,
      totalRecords: session.recordCount,
    };
  } catch (err) {
    try { await session.client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    if (!session.released) {
      session.released = true;
      try { session.client.release(); } catch { /* ignore */ }
    }
    sessions.delete(syncId);
  }
}

export function hasSession(syncId) {
  return sessions.has(syncId);
}

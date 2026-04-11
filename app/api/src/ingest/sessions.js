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
import { discoverColumns, writeSyncLog, scopedDelete } from './engine.js';
import { from as copyFrom } from 'pg-copy-streams';
import * as db from '../db/connection.js';

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

function escapeCopyText(s) {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}
function buildCopyRow(record, activeColumns) {
  const fields = activeColumns.map(col => {
    const v = record[col.name];
    if (v === null || v === undefined) return '\\N';
    if (col.sqlTypeName === 'jsonb' || col.sqlTypeName === 'json') {
      return escapeCopyText(typeof v === 'string' ? v : JSON.stringify(v));
    }
    if (col.sqlTypeName === 'boolean') {
      return v === true || v === 1 || v === '1' || v === 'true' || v === 't' ? 't' : 'f';
    }
    if (col.sqlTypeName.startsWith('timestamp')) {
      return v instanceof Date ? v.toISOString() : escapeCopyText(String(v));
    }
    if (typeof v === 'number') return String(v);
    return escapeCopyText(String(v));
  });
  return fields.join('\t') + '\n';
}

async function copyRows(client, tempTable, activeColumns, records) {
  // Batched INSERT instead of COPY FROM STDIN. The COPY approach had a crash
  // in pg-copy-streams at high row counts (see engine.js for details).
  const colList = activeColumns.map(c => `"${c.name}"`).join(', ');
  const CHUNK = 200;
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK);
    const placeholders = [];
    const params = [];
    let pi = 1;
    for (const rec of chunk) {
      const row = [];
      for (const col of activeColumns) {
        row.push(`$${pi++}`);
        params.push(rec[col.name] !== undefined ? rec[col.name] : null);
      }
      placeholders.push(`(${row.join(',')})`);
    }
    await client.query(
      `INSERT INTO "${tempTable}" (${colList}) VALUES ${placeholders.join(',')}`,
      params
    );
  }
}

export async function startSession(_pool, tableName, keyColumns, records, options = {}) {
  const syncId = crypto.randomUUID();
  const columns = await discoverColumns(null, tableName);
  const recordKeys = new Set();
  for (const rec of records) {
    for (const k of Object.keys(rec)) recordKeys.add(k);
  }
  const activeColumns = columns.filter(c =>
    (recordKeys.has(c.name) || keyColumns.includes(c.name)) && !c.isIdentity
  );

  const pool = await db.getPool();
  const client = await pool.connect();
  await client.query('BEGIN');

  const tempTable = `_tmp_session_${syncId.replace(/-/g, '').slice(0, 16)}`;
  const colDefs = activeColumns
    .map(c => `"${c.name}" ${c.sqlTypeName === 'USER-DEFINED' ? 'text' : c.sqlTypeName}`)
    .join(', ');
  await client.query(`CREATE TEMP TABLE "${tempTable}" (${colDefs}) ON COMMIT DROP`);

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

    let upsertSql;
    if (nonKeyCols.length > 0) {
      const updateSet = nonKeyCols.map(c => `"${c.name}" = EXCLUDED."${c.name}"`).join(', ');
      upsertSql = `
        INSERT INTO "${session.tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${session.tempTable}"
        ON CONFLICT (${onConflictCols}) DO UPDATE SET ${updateSet}
        RETURNING (xmax = 0) AS "wasInsert"
      `;
    } else {
      upsertSql = `
        INSERT INTO "${session.tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${session.tempTable}"
        ON CONFLICT (${onConflictCols}) DO NOTHING
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
        session.systemId, session.scope, session.systemIdColumn, tableColumnNames
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

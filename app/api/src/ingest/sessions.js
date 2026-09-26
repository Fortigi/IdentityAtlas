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
import { markInitialLoad } from './initialLoad.js';
import { resolveActiveColumns, discoverColumns, writeSyncLog, scopedDelete, buildUpdateSet } from './engine.js';
import * as db from '../db/connection.js';
import { createTempTable, bulkInsertIntoTemp } from './tempTableHelpers.js';

const sessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Every open session pins one pooled connection for its whole lifetime, so the
// number of open sessions is capped — per crawler and in total — or a crawler key
// could hold the pool until the timeout and starve every other request
// (SEC-2026-09 M-07). The global cap leaves headroom below the pool size (10).
// A worker-class key (the built-in worker) is exempt from the per-crawler cap:
// the SCIM and midPoint crawlers legitimately keep several buckets open at once.
const DEFAULT_MAX_PER_CRAWLER = 3;
const DEFAULT_MAX_GLOBAL = 7;

function envInt(env, name, fallback) {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// The configured caps (INGEST_MAX_SESSIONS_GLOBAL / _PER_CRAWLER). Exported for tests.
export function sessionLimits(env = process.env) {
  return {
    maxGlobal: envInt(env, 'INGEST_MAX_SESSIONS_GLOBAL', DEFAULT_MAX_GLOBAL),
    maxPerCrawler: envInt(env, 'INGEST_MAX_SESSIONS_PER_CRAWLER', DEFAULT_MAX_PER_CRAWLER),
  };
}

export class SessionLimitError extends Error {}

// Would opening one more session exceed a cap? Pure over the given session list.
// Returns an error message or null. Exported for unit tests.
export function sessionLimitDenial(openSessions, crawlerId, isWorker, limits = sessionLimits()) {
  const open = [...openSessions].filter(x => !x.released);
  if (open.length >= limits.maxGlobal) {
    return `Too many open ingest sessions (limit ${limits.maxGlobal}); retry after one completes`;
  }
  if (isWorker || crawlerId === null || crawlerId === undefined) return null;
  const mine = open.filter(x => x.crawlerId === crawlerId).length;
  return mine >= limits.maxPerCrawler ? `Too many open ingest sessions for this crawler (limit ${limits.maxPerCrawler})` : null;
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.startedAt > SESSION_TIMEOUT_MS) {
      // Mark as released first so concurrent endSession doesn't double-release
      if (session.released || session.pending) continue;
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
  const limitDenial = sessionLimitDenial(sessions.values(), options.crawlerId, options.isWorker);
  if (limitDenial) throw new SessionLimitError(limitDenial);

  // Reserve the slot synchronously, before the first await, so concurrent starts
  // cannot all pass the cap check. No client yet, so it is unusable until filled.
  const syncId = crypto.randomUUID();
  const crawlerId = options.crawlerId ?? null;
  sessions.set(syncId, { crawlerId, pending: true, startedAt: Date.now() });
  try {
    const session = await openSession(syncId, tableName, keyColumns, records, options);
    sessions.set(syncId, { ...session, crawlerId });
  } catch (err) {
    sessions.delete(syncId);
    throw err;
  }
  return { syncId, inserted: 0, updated: 0, deleted: 0 };
}

async function openSession(syncId, tableName, keyColumns, records, options) {
  const activeColumns = await resolveActiveColumns(tableName, records, keyColumns);
  // endSession's full-sync scopedDelete needs the table's full column set (see
  // engine.js) — keep it on the session. Cached, so no extra round-trip.
  const columns = await discoverColumns(null, tableName);

  const pool = await db.getPool();
  const client = await pool.connect();
  const tempTable = `_tmp_session_${syncId.replace(/-/g, '').slice(0, 16)}`;
  try {
    await client.query('BEGIN');
    // The request pool closes a connection left idle inside a transaction (see
    // db/connection.js). A session is idle in its transaction between batches by
    // design, so its own transaction keeps the session's 30-minute bound.
    await client.query(`SET LOCAL idle_in_transaction_session_timeout = ${SESSION_TIMEOUT_MS}`);
    await createTempTable(client, tempTable, activeColumns);
    await copyRows(client, tempTable, activeColumns, records);
  } catch (err) {
    // Never leak the pinned connection when the session fails to open.
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    client.release();
    throw err;
  }

  return {
    restrictSystemIds: options.restrictSystemIds ?? null,
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
    // Columns this system may not take over (#1247). Resolved once at start and
    // kept on the session, so every batch of a multi-batch sync upserts under the
    // same ownership rule a single-batch one does.
    preserveColumns: options.preserveColumns || null,
    startedAt: Date.now(),
    recordCount: records.length,
  };
}

export async function continueSession(syncId, _pool, records, _keyColumns) {
  const session = sessions.get(syncId);
  if (!session) throw new Error(`Sync session '${syncId}' not found or expired`);
  await copyRows(session.client, session.tempTable, session.activeColumns, records);
  session.recordCount += records.length;
  return { syncId, inserted: 0, updated: 0, deleted: 0 };
}

// Builds the ON CONFLICT upsert SQL from a session's columns. When the table has
// non-key columns it updates them on conflict; a key-only table does nothing.
export function buildUpsertSql(session) {
  const nonKeyCols = session.activeColumns.filter(c => !session.keyColumns.includes(c.name));
  const insertCols = session.activeColumns.map(c => `"${c.name}"`).join(', ');
  const onConflictCols = session.keyColumns.map(c => `"${c}"`).join(', ');
  const conflictWhere = session.conflictFilter ? ` WHERE ${session.conflictFilter}` : '';

  if (nonKeyCols.length > 0) {
    // A session applies its whole payload in one upsert at end-of-sync, so the
    // incoming values are authoritative the way a full sync's are — hence
    // syncMode 'full', which is exactly what this line did before it shared a
    // builder with engine.js.
    const updateSet = buildUpdateSet(nonKeyCols, session.tableName, {
      syncMode: 'full', preserveColumns: session.preserveColumns,
    });
    return `
        INSERT INTO "${session.tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${session.tempTable}"
        ON CONFLICT (${onConflictCols})${conflictWhere} DO UPDATE SET ${updateSet}
        RETURNING (xmax = 0) AS "wasInsert"
      `;
  }
  return `
        INSERT INTO "${session.tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${session.tempTable}"
        ON CONFLICT (${onConflictCols})${conflictWhere} DO NOTHING
        RETURNING (xmax = 0) AS "wasInsert"
      `;
}

// Tallies inserts vs. updates from the upsert's RETURNING rows (xmax = 0 ⇒ insert).
export function countUpsertResult(rows) {
  let inserted = 0, updated = 0;
  for (const row of rows) {
    if (row.wasInsert) inserted++; else updated++;
  }
  return { inserted, updated };
}

export async function endSession(syncId, _pool, records, _keyColumns, options = {}) {
  const session = sessions.get(syncId);
  if (!session) throw new Error(`Sync session '${syncId}' not found or expired`);

  try {
    if (records && records.length > 0) {
      await copyRows(session.client, session.tempTable, session.activeColumns, records);
      session.recordCount += records.length;
    }

    // A system's initial load writes no per-row "created" history (migration 073).
    await markInitialLoad(session.client, session.systemId);
    const upsertRes = await session.client.query(buildUpsertSql(session));
    const { inserted, updated } = countUpsertResult(upsertRes.rows);

    let deleted = 0;
    const syncMode = options.syncMode || 'full';
    if (syncMode === 'full') {
      const tableColumnNames = new Set(session.columns.map(c => c.name));
      deleted = await scopedDelete(
        session.client, session.tableName, session.keyColumns, session.tempTable,
        session.systemId, session.scope, session.systemIdColumn, tableColumnNames,
        session.scopeDeleteFilter, session.restrictSystemIds
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

// A session is only visible to the crawler that opened it: another key presenting
// the syncId gets the same answer as for an unknown one. Callers that pass no
// crawlerId (internal use) see every session.
export function hasSession(syncId, crawlerId = undefined) {
  const session = sessions.get(syncId);
  if (!session || session.pending) return false;
  return crawlerId === undefined || session.crawlerId === crawlerId;
}

// Identity Atlas v5 ingest engine — Postgres edition.
//
// Replaces the v4 mssql-based engine. Same external API: callers pass a target
// table, key columns, an array of records, and options. The engine handles
// bulk insert into a temp table and then upserts into the target table.
//
// Implementation notes:
//   - Bulk loading uses batched multi-row `INSERT ... VALUES` into the temp
//     table (see the note in the loader below for why not `COPY FROM STDIN`).
//   - The upsert uses `INSERT ... ON CONFLICT (...) DO UPDATE ... RETURNING
//     (xmax = 0) AS wasInsert` — the xmax trick lets us count inserted vs
//     updated rows without a separate query.
//   - Scoped deletes use `DELETE ... WHERE ... AND NOT EXISTS (SELECT 1 FROM
//     temp_table WHERE key_match)` — postgres-friendly DELETE syntax.
//   - All identifiers are camelCase double-quoted to match the v4 column
//     names exactly. This minimises the route changes needed for v5.

import crypto from 'crypto';
import * as db from '../db/connection.js';
import { createTempTable, bulkInsertIntoTemp } from './tempTableHelpers.js';
import { NO_SYSTEM_COLUMN_TABLES, ownedRowPredicate } from './systemBoundary.js';

// Cache the schema per table for the lifetime of the process. v5 schema is
// only changed by migrations at startup, so the cache is safe.
const schemaCache = new Map();

// Discover a table's columns and keep those present in the records (or needed
// as keys), minus auto-generated identity columns.
export async function resolveActiveColumns(tableName, records, keyColumns) {
  const columns = await discoverColumns(null, tableName);
  const recordKeys = new Set();
  for (const rec of records) {
    for (const k of Object.keys(rec)) recordKeys.add(k);
  }
  return columns.filter(c =>
    (recordKeys.has(c.name) || keyColumns.includes(c.name)) && !c.isIdentity
  );
}

export async function discoverColumns(_pool, tableName) {
  if (schemaCache.has(tableName)) return schemaCache.get(tableName);

  const r = await db.query(
    `SELECT column_name, data_type, is_nullable, column_default,
            (column_default LIKE 'nextval(%' OR is_identity = 'YES') AS is_identity
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName]
  );

  if (r.rows.length === 0) {
    throw new Error(`Table '${tableName}' not found`);
  }

  const cols = r.rows.map(row => ({
    name: row.column_name,
    sqlTypeName: row.data_type,
    isNullable: row.is_nullable === 'YES',
    isIdentity: !!row.is_identity,
    hasUuidDefault: (row.column_default || '').startsWith('gen_random_uuid'),
  }));

  schemaCache.set(tableName, cols);
  return cols;
}


// Entity tables that soft-delete: a row that vanishes from its source system is
// stamped "deletedAt" (kept for audit + cross-system history) rather than removed,
// and re-ingesting it clears the stamp. Every other table still hard-deletes.
export const SOFT_DELETE_TABLES = new Set(['Principals', 'Resources', 'ResourceAssignments']);

/**
 * The `"updatedAt" = now()` fragment an upsert needs so the column means "when
 * this row was last ingested".
 *
 * The update set is built from the PAYLOAD's columns, and no crawler sends
 * `updatedAt` — so without this, a re-ingested row keeps the timestamp of its
 * first insert. That is invisible for most tables but wrong for
 * `PrincipalActivity`, where `updatedAt` IS the measurement moment every
 * activity-based report counts back from: a daily sync would leave "measured
 * on" pinned to the day the account was first seen. Same shape as the
 * `deletedAt` re-activation line below — a column the engine stamps itself
 * because the payload can't.
 *
 * Insert-path is covered by the column's `DEFAULT now()`.
 *
 * @param {{name: string}[]} allColumns    every column of the target table
 * @param {{name: string}[]} activeColumns the columns this payload carries
 * @returns {string} `, "updatedAt" = now()` or ''
 */
export function updatedAtStamp(allColumns, activeColumns) {
  const has = cols => cols.some(c => c.name === 'updatedAt');
  return has(allColumns) && !has(activeColumns) ? ', "updatedAt" = now()' : '';
}

// The `DO UPDATE SET` list for an upsert. One builder for both write paths —
// ingest() here and endSession() in sessions.js — so the three rules below can
// only ever disagree by being changed in one place.
//
//   * preserved (systemBoundary.preservedOwnerColumns, #1247) — the stored value
//     wins and the incoming one only fills a NULL. A dependent system referencing
//     the directory's principals must not stamp itself onto them.
//   * delta — COALESCE(EXCLUDED, stored): a delta payload is partial (Graph's
//     /users/delta returns only what changed), so a NULL means "not sent", not
//     "cleared". Plain `col = EXCLUDED.col` would blank every unchanged field.
//   * full — the payload is authoritative, so NULL genuinely means cleared.
//
// Pure. Exported for unit tests.
export function buildUpdateSet(nonKeyCols, tableName, options = {}) {
  const { syncMode = 'full', preserveColumns = null } = options;
  const preserved = new Set(preserveColumns || []);
  return nonKeyCols.map((c) => {
    const stored = `"${tableName}"."${c.name}"`;
    if (preserved.has(c.name)) return `"${c.name}" = COALESCE(${stored}, EXCLUDED."${c.name}")`;
    if (syncMode === 'delta') return `"${c.name}" = COALESCE(EXCLUDED."${c.name}", ${stored})`;
    return `"${c.name}" = EXCLUDED."${c.name}"`;
  }).join(', ');
}

/**
 * Core ingest operation. Bulk-COPY records into a temp table, then upsert
 * from the temp table into the target.
 */
export async function ingest(_pool, tableName, keyColumns, records, options = {}) {
  const {
    syncMode = 'delta',
    systemId = null,
    scope = {},
    systemIdColumn = 'systemId',
    tempTable: existingTempTable = null,
    scopeDeleteFilter = null,
    conflictFilter = null,
    restrictSystemIds = null,
    preserveColumns = null,
  } = options;

  if (!records || records.length === 0) {
    // An empty DELTA batch says nothing, so there is nothing to do.
    //
    // An empty FULL batch with a SCOPE says something specific: "the partition I
    // own is empty now". That is how a crawler reconciles a collection down to
    // zero — a SCIM endpoint that no longer serves any groups, say — and
    // tools/crawlers/shared/Invoke-CrawlerIngest.ps1 sends exactly that body.
    //
    // The scope is REQUIRED, and that is a safety rule rather than a detail. An
    // unscoped empty full batch would read as "this system has nothing at all",
    // and acting on it deletes every row the system owns in that table —
    // including, for ingest/systems, the system row itself, which then fails the
    // foreign key on everything ingested afterwards. Crawlers do post unscoped
    // empty batches (they were harmless while the API rejected them), so an
    // absent scope means "nothing to say", not "delete everything".
    const scoped = scope && Object.keys(scope).length > 0;
    if (syncMode !== 'full' || !scoped) return { inserted: 0, updated: 0, deleted: 0 };
    const deleted = await db.tx(client =>
      deleteEntireScope(client, tableName, keyColumns, systemId, scope, systemIdColumn, scopeDeleteFilter, null, restrictSystemIds));
    return { inserted: 0, updated: 0, deleted };
  }

  const activeColumns = await resolveActiveColumns(tableName, records, keyColumns);

  if (activeColumns.length === 0) {
    throw new Error(`No matching columns for table '${tableName}' in records`);
  }

  const tempName = existingTempTable || `_tmp_ingest_${crypto.randomBytes(6).toString('hex')}`;

  return await db.tx(async (client) => {
    if (!existingTempTable) {
      await createTempTable(client, tempName, activeColumns);
    }

    // Bulk insert into the temp table. We use batched INSERT ... VALUES rather
    // than pg-copy-streams (COPY FROM STDIN) because the COPY approach has a
    // known crash in pg-copy-streams where an async flush races with connection
    // teardown, producing an unhandled "Cannot read properties of null (reading
    // 'stream')" that kills the Node process. The INSERT approach is ~30% slower
    // but doesn't have this failure mode.
    //
    // 1000 rows per INSERT. We measured this on a 255k-row ResourceAssignments
    // batch: bumping from 200 → 1000 cuts round-trip count 5× and wall-clock
    // time by roughly the same factor, with no measurable increase in lock
    // hold time on Postgres (the whole batch is already one transaction, so
    // chunk size only affects statement count, not locking behaviour).
    await bulkInsertIntoTemp(client, tempName, activeColumns, records, 1000, true);

    // Upsert from temp into target. xmax = 0 detects fresh inserts.
    const nonKeyCols = activeColumns.filter(c => !keyColumns.includes(c.name));
    const insertCols = activeColumns.map(c => `"${c.name}"`).join(', ');
    const onConflictCols = keyColumns.map(c => `"${c}"`).join(', ');
    // conflictFilter supports partial unique indexes (e.g. ResourceAssignments
    // uses two partial indexes after migration 036 replaced the composite PK).
    // PostgreSQL requires the WHERE clause of the conflict inference to match
    // the partial index predicate exactly.
    const conflictWhere = conflictFilter ? ` WHERE ${conflictFilter}` : '';

    // Re-activation: re-ingesting a previously soft-deleted row clears its tombstone
    // (it's back in the source, so it's live again). deletedAt isn't in the payload,
    // so we set it explicitly on every upsert of a soft-delete table.
    const reactivate = SOFT_DELETE_TABLES.has(tableName) ? ', "deletedAt" = NULL' : '';
    // "This row was ingested again just now" — see updatedAtStamp().
    const touch = updatedAtStamp(await discoverColumns(null, tableName), activeColumns);
    const engineSet = `${reactivate}${touch}`;

    let upsertSql;
    if (nonKeyCols.length > 0) {
      const updateSet = buildUpdateSet(nonKeyCols, tableName, { syncMode, preserveColumns });
      upsertSql = `
        INSERT INTO "${tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${tempName}"
        ON CONFLICT (${onConflictCols})${conflictWhere} DO UPDATE SET ${updateSet}${engineSet}
        RETURNING (xmax = 0) AS "wasInsert"
      `;
    } else if (engineSet) {
      // Key-only table: nothing to update except what the engine stamps itself
      // (re-activation and/or the ingest timestamp). Drop the leading comma.
      upsertSql = `
        INSERT INTO "${tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${tempName}"
        ON CONFLICT (${onConflictCols})${conflictWhere} DO UPDATE SET ${engineSet.slice(2)}
        RETURNING (xmax = 0) AS "wasInsert"
      `;
    } else {
      upsertSql = `
        INSERT INTO "${tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${tempName}"
        ON CONFLICT (${onConflictCols})${conflictWhere} DO NOTHING
        RETURNING (xmax = 0) AS "wasInsert"
      `;
    }

    const upsertRes = await client.query(upsertSql);
    let inserted = 0;
    let updated = 0;
    for (const row of upsertRes.rows) {
      if (row.wasInsert) inserted++;
      else updated++;
    }

    let deleted = 0;
    if (syncMode === 'full') {
      // scopedDelete's guards (systemId / linkConfidence / analystOverride) test
      // the table's *full* column set, not just the payload columns — so re-read
      // the cached schema rather than reusing activeColumns.
      const allColumns = await discoverColumns(null, tableName);
      const tableColumnNames = new Set(allColumns.map(c => c.name));
      deleted = await scopedDelete(client, tableName, keyColumns, tempName, systemId, scope, systemIdColumn, tableColumnNames, scopeDeleteFilter, restrictSystemIds);
    }

    return { inserted, updated, deleted };
  });
}

// Tombstone everything in one scope, for a full sync that carried no records.
//
// scopedDelete keeps whatever survives in a temp table of the incoming keys, so
// "keep nothing" is simply that table with no rows in it. Built with SELECT ...
// WHERE false so the key columns get their real types from the target table
// rather than being guessed from records that do not exist.
// Takes a client rather than opening its own transaction: the wipe belongs in
// the SAME transaction as the rest of the ingest that asked for it, and it makes
// the function testable against a contract-test pool the way scopedDelete is.
export async function deleteEntireScope(
  client, tableName, keyColumns, systemId, scope, systemIdColumn, scopeDeleteFilter, tableColumnNames = null,
  restrictSystemIds = null,
) {
  const tempName = `_tmp_wipe_${crypto.randomBytes(6).toString('hex')}`;
  const keyCols = keyColumns.map(k => `"${k}"`).join(', ');
  await client.query(
    `CREATE TEMP TABLE "${tempName}" ON COMMIT DROP AS SELECT ${keyCols} FROM "${tableName}" WHERE false`);

  // Discovered through the module-level db unless the caller supplies them —
  // scopedDelete takes them as a parameter for the same reason, so a test can
  // drive this against its own pool.
  let columnNames = tableColumnNames;
  if (!columnNames) {
    const allColumns = await discoverColumns(null, tableName);
    columnNames = new Set(allColumns.map(c => c.name));
  }
  return await scopedDelete(
    client, tableName, keyColumns, tempName, systemId, scope, systemIdColumn, columnNames, scopeDeleteFilter, restrictSystemIds);
}

// The predicates that bound a reconcile delete to one partition: the system, the
// caller-declared scope, and — for a key restricted to specific systems — the
// ownership predicate from systemBoundary.js. Pure. Exported for unit tests.
export function reconcileBounds(tableName, systemId, scope, systemIdColumn, tableColumnNames, restrictSystemIds = null) {
  const params = [];
  const clauses = [];
  if (systemId !== null && systemId !== undefined && tableColumnNames.has(systemIdColumn)) {
    params.push(systemId);
    clauses.push(`t."${systemIdColumn}" = $${params.length}`);
  }
  for (const [key, value] of Object.entries(scope || {})) {
    if (value === undefined || value === null) continue;
    if (!tableColumnNames.has(key)) continue;
    params.push(value);
    clauses.push(`t."${key}" = $${params.length}`);
  }
  if (Array.isArray(restrictSystemIds)) {
    params.push(restrictSystemIds);
    clauses.push(`COALESCE((${ownedRowPredicate(tableName, 't', `$${params.length}`) || 'false'}), false)`);
  }
  return { params, clauses };
}

// May this reconcile run with the bounds it has? A delete with no system, scope or
// ownership predicate would reconcile the ENTIRE table against one batch — for
// "Systems" that removes every other system and cascades through the whole
// dataset (SEC-2026-09 C-01). The single exception is a table that has no systemId
// column at all (Identities, IdentityMembers, Contexts, ContextMembers,
// PrincipalActivity) reconciled by an unrestricted key: the built-in worker's
// crawlers reconcile those tables whole, and that behaviour is kept. Pure.
export function reconcileAllowed(tableName, clauses, restrictSystemIds) {
  if (clauses.length > 0) return true;
  return restrictSystemIds === null && NO_SYSTEM_COLUMN_TABLES.has(tableName);
}

export async function scopedDelete(client, tableName, keyColumns, tempName, systemId, scope, systemIdColumn, tableColumnNames, scopeDeleteFilter = null, restrictSystemIds = null) {
  const { params, clauses } = reconcileBounds(tableName, systemId, scope, systemIdColumn, tableColumnNames, restrictSystemIds);
  if (!reconcileAllowed(tableName, clauses, restrictSystemIds)) {
    console.warn(`scopedDelete: refusing an unbounded reconcile of ${tableName} (no system, scope or ownership predicate)`);
    return 0;
  }

  // Before the DELETE: create a unique index on the temp table over the
  // same key columns the NOT EXISTS uses, then ANALYZE so the planner has
  // accurate row counts. Without these the planner does a sequential scan
  // of the temp table for every target row — on a 250k × 250k workload
  // that takes 20+ minutes. With them, the same query runs in seconds.
  try {
    const tempIndexName = `${tempName}_keyidx`;
    const tempIndexCols = keyColumns.map(k => `"${k}"`).join(', ');
    await client.query(`CREATE INDEX IF NOT EXISTS "${tempIndexName}" ON "${tempName}" (${tempIndexCols})`);
    await client.query(`ANALYZE "${tempName}"`);
  } catch (err) {
    console.warn(`scopedDelete: temp index/analyze failed (continuing): ${err.message}`);
  }

  let where = ['1=1', ...clauses].join(' AND ');

  // A crawler full-sync only owns the links IT created. Account linking and
  // analyst decisions own a separate set of IdentityMembers, distinguished by a
  // confidence score (linkConfidence) or an analyst decision (analystOverride).
  // Exclude those from the reconcile delete so a crawl never wipes account
  // linking's links or an analyst's confirm/remove. (Columns only exist on
  // IdentityMembers, so this is a no-op for every other table.)
  if (tableColumnNames.has('linkConfidence'))  where += ` AND t."linkConfidence" IS NULL`;
  if (tableColumnNames.has('analystOverride')) where += ` AND t."analystOverride" IS NULL`;

  if (scopeDeleteFilter) where += ` AND (${scopeDeleteFilter})`;

  const notExistsJoin = keyColumns.map(k => `t."${k}" = src."${k}"`).join(' AND ');
  // Soft-delete tables stamp deletedAt instead of removing the row; the
  // `deletedAt IS NULL` guard keeps the deletion timestamp stable across re-syncs
  // (a row that's still gone isn't re-stamped). Other tables hard-delete.
  const sql = SOFT_DELETE_TABLES.has(tableName)
    ? `
    UPDATE "${tableName}" t SET "deletedAt" = now()
     WHERE ${where}
       AND t."deletedAt" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "${tempName}" src WHERE ${notExistsJoin})
  `
    : `
    DELETE FROM "${tableName}" t
     WHERE ${where}
       AND NOT EXISTS (SELECT 1 FROM "${tempName}" src WHERE ${notExistsJoin})
  `;
  const res = await client.query(sql, params);
  return res.rowCount || 0;
}

/**
 * Append a row to GraphSyncLog. Best-effort — must not fail the ingest.
 */
export async function writeSyncLog(_pool, syncType, tableName, startTime, recordCount, _inserted, _updated, _deleted, error) {
  try {
    const endTime = new Date();
    const duration = Math.round((endTime - startTime) / 1000);
    const status = error ? 'Failed' : 'Success';
    await db.query(
      `INSERT INTO "GraphSyncLog"
         ("SyncType", "TableName", "StartTime", "EndTime", "DurationSeconds", "RecordCount", "Status", "ErrorMessage")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [syncType, tableName, startTime, endTime, duration, recordCount, status, error || null]
    );
  } catch {
    // Sync log write must not fail the ingest
  }
}

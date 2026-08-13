// Identity Atlas v5 ingest engine — Postgres edition.
//
// Replaces the v4 mssql-based engine. Same external API: callers pass a target
// table, key columns, an array of records, and options. The engine handles
// bulk insert into a temp table and then upserts into the target table.
//
// Implementation notes:
//   - Bulk loading uses `pg-copy-streams` (`COPY ... FROM STDIN`) which is the
//     fastest path for inserting many rows in postgres. Comparable to SQL
//     Server's SqlBulkCopy.
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
  } = options;

  if (!records || records.length === 0) {
    return { inserted: 0, updated: 0, deleted: 0 };
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

    let upsertSql;
    if (nonKeyCols.length > 0) {
      // Delta syncs send partial records (Graph's /users/delta returns only
      // fields that changed). Using plain `col = EXCLUDED.col` would
      // overwrite every unchanged field with NULL, silently corrupting the
      // stored row. COALESCE preserves the existing value when the incoming
      // value is NULL. In full-sync the payload is authoritative — NULL
      // explicitly means "cleared" — so we keep the direct assignment.
      const updateSet = syncMode === 'delta'
        ? nonKeyCols.map(c => `"${c.name}" = COALESCE(EXCLUDED."${c.name}", "${tableName}"."${c.name}")`).join(', ')
        : nonKeyCols.map(c => `"${c.name}" = EXCLUDED."${c.name}"`).join(', ');
      upsertSql = `
        INSERT INTO "${tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${tempName}"
        ON CONFLICT (${onConflictCols})${conflictWhere} DO UPDATE SET ${updateSet}${reactivate}
        RETURNING (xmax = 0) AS "wasInsert"
      `;
    } else if (reactivate) {
      // Key-only soft-delete table: nothing to update except re-activation.
      upsertSql = `
        INSERT INTO "${tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${tempName}"
        ON CONFLICT (${onConflictCols})${conflictWhere} DO UPDATE SET "deletedAt" = NULL
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
      deleted = await scopedDelete(client, tableName, keyColumns, tempName, systemId, scope, systemIdColumn, tableColumnNames, scopeDeleteFilter);
    }

    return { inserted, updated, deleted };
  });
}

export async function scopedDelete(client, tableName, keyColumns, tempName, systemId, scope, systemIdColumn, tableColumnNames, scopeDeleteFilter = null) {
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

  const params = [];
  let where = '1=1';

  if (systemId !== null && systemId !== undefined && tableColumnNames.has(systemIdColumn)) {
    params.push(systemId);
    where += ` AND t."${systemIdColumn}" = $${params.length}`;
  }

  for (const [key, value] of Object.entries(scope || {})) {
    if (value === undefined || value === null) continue;
    if (!tableColumnNames.has(key)) continue;
    params.push(value);
    where += ` AND t."${key}" = $${params.length}`;
  }

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

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

import { from as copyFrom } from 'pg-copy-streams';
import crypto from 'crypto';
import * as db from '../db/connection.js';

// Cache the schema per table for the lifetime of the process. v5 schema is
// only changed by migrations at startup, so the cache is safe.
const schemaCache = new Map();

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

// Encode a JS value into a postgres TEXT-format COPY field.
// Special chars per the COPY spec: \\ → \\\\, \n → \\n, \r → \\r, \t → \\t,
// NULL → \N. JSON columns get JSON.stringify-ed and then escaped.
function encodeCopyValue(val, dataType) {
  if (val === null || val === undefined) return '\\N';
  if (dataType === 'jsonb' || dataType === 'json') {
    if (typeof val === 'string') return escapeCopyText(val);
    return escapeCopyText(JSON.stringify(val));
  }
  if (dataType === 'boolean') {
    if (val === true || val === 1 || val === '1' || val === 'true' || val === 't') return 't';
    if (val === false || val === 0 || val === '0' || val === 'false' || val === 'f') return 'f';
    return '\\N';
  }
  if (typeof dataType === 'string' && dataType.startsWith('timestamp')) {
    if (val instanceof Date) return val.toISOString();
    return escapeCopyText(String(val));
  }
  if (dataType === 'integer' || dataType === 'bigint' || dataType === 'numeric' || dataType === 'real' || dataType === 'double precision') {
    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? '1' : '0';
    return escapeCopyText(String(val));
  }
  return escapeCopyText(String(val));
}

function escapeCopyText(s) {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

function buildCopyRow(record, activeColumns) {
  const fields = activeColumns.map(col => {
    let val = record[col.name];
    // Auto-generate a UUID for columns with gen_random_uuid() default when
    // the caller doesn't supply one. Without this, the COPY writes NULL which
    // overrides the column DEFAULT — postgres only applies defaults for
    // missing columns, not for explicit NULLs.
    if ((val === null || val === undefined) && col.hasUuidDefault) {
      val = crypto.randomUUID();
    }
    return encodeCopyValue(val, col.sqlTypeName);
  });
  return fields.join('\t') + '\n';
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
  } = options;

  if (!records || records.length === 0) {
    return { inserted: 0, updated: 0, deleted: 0 };
  }

  const columns = await discoverColumns(null, tableName);

  // Filter columns to those present in the records (or required as keys),
  // excluding identity columns which postgres auto-generates.
  const recordKeys = new Set();
  for (const rec of records) {
    for (const k of Object.keys(rec)) recordKeys.add(k);
  }
  const activeColumns = columns.filter(c =>
    (recordKeys.has(c.name) || keyColumns.includes(c.name)) && !c.isIdentity
  );

  if (activeColumns.length === 0) {
    throw new Error(`No matching columns for table '${tableName}' in records`);
  }

  const tempName = existingTempTable || `_tmp_ingest_${crypto.randomBytes(6).toString('hex')}`;

  return await db.tx(async (client) => {
    if (!existingTempTable) {
      const colDefs = activeColumns
        .map(c => `"${c.name}" ${c.sqlTypeName === 'USER-DEFINED' ? 'text' : c.sqlTypeName}`)
        .join(', ');
      await client.query(`CREATE TEMP TABLE "${tempName}" (${colDefs}) ON COMMIT DROP`);
    }

    // Bulk insert into the temp table. We use batched INSERT ... VALUES rather
    // than pg-copy-streams (COPY FROM STDIN) because the COPY approach has a
    // known crash in pg-copy-streams where an async flush races with connection
    // teardown, producing an unhandled "Cannot read properties of null (reading
    // 'stream')" that kills the Node process. The INSERT approach is ~30% slower
    // but doesn't have this failure mode.
    const colList = activeColumns.map(c => `"${c.name}"`).join(', ');
    // 1000 rows per INSERT. We measured this on a 255k-row ResourceAssignments
    // batch: bumping from 200 → 1000 cuts round-trip count 5× and wall-clock
    // time by roughly the same factor, with no measurable increase in lock
    // hold time on Postgres (the whole batch is already one transaction, so
    // chunk size only affects statement count, not locking behaviour).
    const INSERT_CHUNK = 1000; // rows per INSERT statement
    for (let i = 0; i < records.length; i += INSERT_CHUNK) {
      const chunk = records.slice(i, i + INSERT_CHUNK);
      const placeholders = [];
      const params = [];
      let pi = 1;
      for (const rec of chunk) {
        const row = [];
        for (const col of activeColumns) {
          row.push(`$${pi++}`);
          let val = rec[col.name] !== undefined ? rec[col.name] : null;
          if (val === null && col.hasUuidDefault) val = crypto.randomUUID();
          params.push(val);
        }
        placeholders.push(`(${row.join(',')})`);
      }
      await client.query(
        `INSERT INTO "${tempName}" (${colList}) VALUES ${placeholders.join(',')}`,
        params
      );
    }

    // Upsert from temp into target. xmax = 0 detects fresh inserts.
    const nonKeyCols = activeColumns.filter(c => !keyColumns.includes(c.name));
    const insertCols = activeColumns.map(c => `"${c.name}"`).join(', ');
    const onConflictCols = keyColumns.map(c => `"${c}"`).join(', ');

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
        ON CONFLICT (${onConflictCols}) DO UPDATE SET ${updateSet}
        RETURNING (xmax = 0) AS "wasInsert"
      `;
    } else {
      upsertSql = `
        INSERT INTO "${tableName}" (${insertCols})
        SELECT ${insertCols} FROM "${tempName}"
        ON CONFLICT (${onConflictCols}) DO NOTHING
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
      const tableColumnNames = new Set(columns.map(c => c.name));
      deleted = await scopedDelete(client, tableName, keyColumns, tempName, systemId, scope, systemIdColumn, tableColumnNames);
    }

    return { inserted, updated, deleted };
  });
}

export async function scopedDelete(client, tableName, keyColumns, tempName, systemId, scope, systemIdColumn, tableColumnNames) {
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

  const notExistsJoin = keyColumns.map(k => `t."${k}" = src."${k}"`).join(' AND ');
  const sql = `
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

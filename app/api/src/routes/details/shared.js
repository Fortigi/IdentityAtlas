// Shared helpers + constants for the entity-detail endpoints.
//
// Extracted verbatim from routes/details.js as part of splitting that fat
// controller (audit finding C1) into per-entity routers. Imported by
// routes/details/{user,group,accessPackage}.js so they share one definition.
// No behaviour change — pure code move.

import * as db from '../../db/connection.js';

export const useSql = process.env.USE_SQL === 'true';
export const SYSTEM_COLS = new Set(['SysStartTime', 'SysEndTime']);
export const UUID_RE = /^[0-9a-f-]{36}$/i;

export function cleanRow(row) {
  const clean = {};
  for (const [key, value] of Object.entries(row)) {
    if (!SYSTEM_COLS.has(key)) clean[key] = value;
  }
  return clean;
}

export async function getPermissionTable(_pool) {
  // v5: only the unified view exists. No materialized fallback needed.
  return '"vw_ResourceUserPermissionAssignments"';
}

// Fetch the version history of a single row from the v5 `_history` audit table.
// Returns rows shaped like the v4 SQL Server temporal-table query: each row has
// every column of the source table at that point in time, plus ValidFrom and
// (synthesised) ValidTo. Newest first. The frontend's diff logic compares
// consecutive rows so the shape has to match what v4 returned.
export async function fetchHistory(tableName, rowId) {
  const r = await db.query(
    `SELECT operation, "changedAt", "rowData"
       FROM "_history"
      WHERE "tableName" = $1 AND "rowId" = $2
      ORDER BY "changedAt" DESC`,
    [tableName, rowId]
  );
  // Synthesise ValidFrom/ValidTo: ValidFrom is this row's changedAt, ValidTo
  // is the *next* (newer) row's changedAt — i.e. the moment this version
  // stopped being current. The newest row's ValidTo is left null (still current).
  return r.rows.map((row, idx) => {
    const data = row.rowData || {};
    const newer = idx > 0 ? r.rows[idx - 1] : null;
    return {
      ...data,
      ValidFrom: row.changedAt,
      ValidTo: newer ? newer.changedAt : null,
      _operation: row.operation,
    };
  });
}

export async function countHistory(tableName, rowId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM "_history" WHERE "tableName" = $1 AND "rowId" = $2`,
    [tableName, rowId]
  );
  return r.rows[0]?.cnt ?? 0;
}

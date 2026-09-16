// The per-system boundary on crawler ingest (SEC-2026-09 C-01 / H-04).
//
// A crawler key may be restricted to a set of systems (`Crawlers.systemIds`). The
// envelope `systemId` has always been checked against that set, but the rows an
// ingest call actually touches were not: a record could carry another system's
// id, an id-keyed upsert could overwrite a row another system owns, and
// `deletedIds` / the full-sync reconcile could reach rows outside the caller's
// systems. This module answers "does this batch stay inside the caller's
// systems?" for a RESTRICTED key.
//
// An UNRESTRICTED key (`systemIds = null` — the built-in worker) is deliberately
// not checked here: shipped crawlers legitimately write the same row under more
// than one system (Azure RM principal stubs are existing Entra rows; built-in
// Entra directory-role ids are identical in every tenant), and those runs must
// behave exactly as before. That is also why ownership is checked by access
// rather than by adding `systemId = EXCLUDED.systemId` to the upsert, which would
// silently stop those writes for every caller.
//
// Ownership of a row, per table:
//   - tables with a systemId column  → the row's systemId
//   - Systems                        → the row's own id
//   - Contexts                       → a synced context scoped to the system
//   - ContextMembers                 → its context is owned
//   - IdentityMembers / PrincipalActivity → the linked principal's systemId
//   - Identities                     → linked to at least one principal of the
//                                      caller's systems and to none outside them

import * as db from '../db/connection.js';

// Tables that carry no systemId column. A full-sync reconcile on one of them
// cannot be bounded by the envelope systemId.
export const NO_SYSTEM_COLUMN_TABLES = new Set([
  'Identities', 'IdentityMembers', 'Contexts', 'ContextMembers', 'PrincipalActivity',
]);

// Columns the server (or an analyst) owns. A crawler record never writes them:
// they are removed from the writable column set, so a field with one of these
// names is treated like any other non-column attribute. `systemId` is not here —
// it stays writable, stamped from the envelope and checked for access.
export const SERVER_MANAGED_COLUMNS = new Set([
  'deletedAt', 'riskScore', 'riskTier', 'linkConfidence', 'linkedAt',
  'analystOverride', 'analystVerified', 'analystNotes',
  'createdAt', 'updatedAt', 'lastCalculatedAt', 'lastSyncDateTime',
  'userRenamed', 'userReparented',
]);

export function writableCoreColumns(columns) {
  return columns.filter(c => !SERVER_MANAGED_COLUMNS.has(c));
}

// The caller's system allow-list, or null for an unrestricted key.
export function restrictedSystemIds(crawler) {
  if (!crawler || !Array.isArray(crawler.systemIds)) return null;
  return crawler.systemIds.map(Number).filter(Number.isInteger);
}

const OWNED_CONTEXT = (alias, ref) =>
  `(${alias}."variant" = 'synced' AND ${alias}."scopeSystemId" = ANY(${ref}::int[]))`;

// SQL predicate: "the row aliased `alias` is owned by the systems bound at `ref`"
// (a `$N` placeholder bound to an integer array). Returns null for a table whose
// ownership this module does not know — callers treat that as "not owned".
export function ownedRowPredicate(tableName, alias, ref) {
  switch (tableName) {
    case 'Systems':
      return `${alias}."id" = ANY(${ref}::int[])`;
    case 'Contexts':
      return OWNED_CONTEXT(alias, ref);
    case 'ContextMembers':
      return `EXISTS (SELECT 1 FROM "Contexts" oc WHERE oc."id" = ${alias}."contextId" AND ${OWNED_CONTEXT('oc', ref)})`;
    case 'IdentityMembers':
    case 'PrincipalActivity':
      return `EXISTS (SELECT 1 FROM "Principals" op WHERE op."id" = ${alias}."principalId" AND op."systemId" = ANY(${ref}::int[]))`;
    case 'Identities':
      return `(EXISTS (SELECT 1 FROM "IdentityMembers" oim JOIN "Principals" op ON op."id" = oim."principalId"
                        WHERE oim."identityId" = ${alias}."id" AND op."systemId" = ANY(${ref}::int[]))
               AND NOT EXISTS (SELECT 1 FROM "IdentityMembers" oim LEFT JOIN "Principals" op ON op."id" = oim."principalId"
                        WHERE oim."identityId" = ${alias}."id"
                          AND (op."systemId" IS NULL OR NOT (op."systemId" = ANY(${ref}::int[])))))`;
    default:
      return NO_SYSTEM_COLUMN_TABLES.has(tableName) ? null : `${alias}."systemId" = ANY(${ref}::int[])`;
  }
}

// Tables whose rows take their owner from a parent row named in their key, so the
// incoming records are checked directly: a new link to another system's principal
// (or context) is refused as well as an update of one.
const PARENT_KEY = { IdentityMembers: 'principalId', PrincipalActivity: 'principalId', ContextMembers: 'contextId' };

function isAllowed(value, allowed) {
  return allowed.includes(Number(value));
}

// A record naming a system the caller cannot access — through `systemId` on the
// record itself, or a context's `scopeSystemId`. Pure. Returns an error string or null.
export function recordSystemDenial(records, allowed) {
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    for (const field of ['systemId', 'scopeSystemId']) {
      if (rec[field] !== undefined && rec[field] !== null && !isAllowed(rec[field], allowed)) {
        return `Record ${i}: ${field} ${String(rec[field]).slice(0, 20)} is outside this crawler's systems`;
      }
    }
  }
  return null;
}

// A full sync on a table without a systemId column is only bounded by its scope
// and the ownership predicate; without a scope it would reconcile the whole
// table. Refused for a restricted key. Pure.
export function unscopedFullSyncDenial(tableName, syncMode, scope) {
  if (syncMode !== 'full' || !NO_SYSTEM_COLUMN_TABLES.has(tableName)) return null;
  if (scope && Object.keys(scope).length > 0) return null;
  return `A full sync of ${tableName} needs a scope when the crawler is restricted to specific systems`;
}

// The incoming rows as a typed relation: jsonb_populate_recordset against the
// target table's own row type, so key columns compare with their real types (and
// indexes) rather than as text. Only key columns are sent.
function incomingKeysJson(records, keyColumns) {
  return JSON.stringify(records.map(r => Object.fromEntries(keyColumns.map(k => [k, r[k] ?? null]))));
}

// SQL: an EXISTING row that one of the incoming records would update, and that the
// caller does not own. Exported for tests.
export function foreignExistingRowSql(tableName, keyColumns, conflictFilter) {
  const renamed = keyColumns.map((k, i) => `r."${k}" AS k${i}`).join(', ');
  const join = keyColumns.map((k, i) => `t."${k}" = k.k${i}`).join(' AND ');
  const owned = ownedRowPredicate(tableName, 't', '$2') || 'false';
  const filter = conflictFilter ? ` AND (${conflictFilter})` : '';
  return `SELECT 1 FROM "${tableName}" t
            JOIN (SELECT ${renamed} FROM jsonb_populate_recordset(NULL::"${tableName}", $1::jsonb) r) k ON ${join}
           WHERE NOT COALESCE((${owned}), false)${filter}
           LIMIT 1`;
}

// SQL: an INCOMING row whose parent (principal / context) the caller does not own.
export function foreignParentSql(tableName) {
  const owned = ownedRowPredicate(tableName, 'r', '$2');
  return `SELECT 1 FROM jsonb_populate_recordset(NULL::"${tableName}", $1::jsonb) r
           WHERE NOT COALESCE((${owned}), false)
           LIMIT 1`;
}

// Would this batch touch a row outside the caller's systems? Returns an error
// string or null. One indexed lookup; only ever run for a restricted key.
export async function foreignRowDenial(tableName, keyColumns, records, allowed, conflictFilter) {
  if (records.length === 0) return null;
  const parentKey = PARENT_KEY[tableName];
  if (parentKey) {
    const parent = await db.query(foreignParentSql(tableName), [incomingKeysJson(records, [parentKey]), allowed]);
    return parent.rows.length > 0 ? `The batch links a ${tableName} row to a system outside this crawler's systems` : null;
  }
  const sql = foreignExistingRowSql(tableName, keyColumns, conflictFilter);
  const existing = await db.query(sql, [incomingKeysJson(records, keyColumns), allowed]);
  return existing.rows.length > 0 ? `The batch would modify a ${tableName} row owned by a system outside this crawler's systems` : null;
}

// Every boundary check for one ingest batch from a restricted key. Returns an
// error string (→ 403) or null.
export async function systemBoundaryDenial({ tableName, keyColumns, records, scope, syncMode, conflictFilter, allowed }) {
  return recordSystemDenial(records, allowed)
    || unscopedFullSyncDenial(tableName, syncMode, scope)
    || foreignRowDenial(tableName, keyColumns, records, allowed, conflictFilter);
}

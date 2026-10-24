// Pure helpers for the crawler data-plane endpoints in handlers.js
// (sync-log, classify-business-role-assignments) — kept here so each decision is
// unit-testable without a request (SEC-2026-09 M-05).

import { restrictedSystemIds } from '../../ingest/systemBoundary.js';

const cap = (value, max) => (value === undefined || value === null ? null : String(value).slice(0, max));

// Parse a caller-supplied systemId. undefined → absent; anything that is not a
// positive integer → NaN (rejected by the caller).
function parseSystemId(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : Number.NaN;
}

function hasAccess(crawler, systemId) {
  const allowed = restrictedSystemIds(crawler);
  return allowed === null || allowed.includes(systemId);
}

function validDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// The GraphSyncLog row a crawler asked to write, stamped with the authenticated
// crawler (and the system, when it names one it may access). Text fields are
// length-capped. Returns { error, status } or { duration, values } (insert order).
export function buildSyncLogRow(body, crawler) {
  const { syncType, tableName, startTime, endTime, recordCount, status, errorMessage } = body || {};
  if (!syncType || !startTime) return { status: 400, error: 'syncType and startTime are required' };
  const systemId = parseSystemId(body.systemId);
  if (Number.isNaN(systemId)) return { status: 400, error: 'systemId must be a positive integer' };
  if (systemId !== undefined && !hasAccess(crawler, systemId)) {
    return { status: 403, error: `Crawler does not have access to system ${systemId}` };
  }
  const start = validDate(startTime);
  const end = endTime ? validDate(endTime) : new Date();
  if (!start || !end) return { status: 400, error: 'startTime and endTime must be valid dates' };
  const duration = Math.max(0, Math.round((end - start) / 1000));
  const count = Number.isInteger(recordCount) && recordCount >= 0 ? recordCount : 0;
  return {
    duration,
    values: [
      cap(syncType, 100), cap(tableName, 100), start, end, duration, count,
      cap(status, 50) || 'Success', cap(errorMessage, 4000), crawler?.id ?? null, systemId ?? null,
    ],
  };
}

// Which assignments classify-business-role-assignments may flag for this caller.
// An explicit body.systemId must be accessible; without one, a restricted key is
// limited to its own systems and an unrestricted key keeps the tenant-wide pass.
// Returns { error, status } or { clause, params } (clause appended to the WHERE).
export function classifyScope(body, crawler) {
  const systemId = parseSystemId(body?.systemId);
  if (Number.isNaN(systemId)) return { status: 400, error: 'systemId must be a positive integer' };
  if (systemId !== undefined) {
    if (!hasAccess(crawler, systemId)) return { status: 403, error: `Crawler does not have access to system ${systemId}` };
    return { clause: ' AND ra."systemId" = $1', params: [systemId] };
  }
  const allowed = restrictedSystemIds(crawler);
  if (allowed === null) return { clause: '', params: [] };
  return { clause: ' AND ra."systemId" = ANY($1::int[])', params: [allowed] };
}

// The two statements classify-business-role-assignments runs, in order, in one
// transaction. `scopeClause` is classifyScope's clause (aliases ra).
//
// A membership of a governance resource IS the governed fact, so its ungoverned
// row is only ever an unclassified copy. Before ingest marked these rows itself,
// every re-import added such a copy beside the row classify had already flipped
// (governed is part of the unique key), and flipping the copy then collided with
// that row: a unique violation, HTTP 500, on every later run. So the copy is
// removed where the governed row exists, and only the rest is flipped. This does
// not touch the actual/intent pair migration 047 allows on ordinary resources:
// both statements are limited to governance resources.
export function classifyStatements(scopeClause) {
  const governanceMembership = `r.id = ra."resourceId" AND r."governanceResource" AND ra."governed" = false${scopeClause}`;
  return {
    removeCopies: `
      DELETE FROM "ResourceAssignments" ra
       USING "Resources" r
       WHERE ${governanceMembership}
         AND EXISTS (SELECT 1 FROM "ResourceAssignments" g
                      WHERE g."governed"
                        AND g."resourceId" = ra."resourceId"
                        AND g."principalId" IS NOT DISTINCT FROM ra."principalId"
                        AND g."identityId" IS NOT DISTINCT FROM ra."identityId"
                        AND g."assignmentType" = ra."assignmentType")`,
    markGoverned: `
      UPDATE "ResourceAssignments" ra
         SET "governed" = true
        FROM "Resources" r
       WHERE ${governanceMembership}`,
  };
}

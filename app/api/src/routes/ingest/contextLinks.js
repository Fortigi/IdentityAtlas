// Context roles and context-to-context links sent by a crawler —
// POST /api/ingest/context-roles and POST /api/ingest/context-relationships.
//
// The analyst routes (routes/contexts/roles.js, relationships.js) write the
// same tables, but a crawler key (fgc_) is only valid on /api/ingest and
// /api/crawlers, so a source that knows who answers for an application — an
// IGA application catalogue, the demo dataset — needs this door. Rows written
// here are addedBy = 'sync' (migration 095 reserved the value for them).
//
// Envelope: { systemId, records: [...] }. A crawler may only set roles and
// links on the contexts its system owns (Contexts.scopeSystemId = systemId),
// the same boundary a contexts full sync is held to.
//
// ADDITIVE by default. Each record is inserted when it is new and skipped
// otherwise — an existing Accountable, a duplicate, a context the system does
// not own, a holder or related context that does not exist. Nothing is updated
// or removed, so an analyst's own roles and links survive every crawl.
//
// Context roles also take a RECONCILING mode: { syncMode: 'full', scope:
// { contextType } }. The source then states every role it knows for its synced
// contexts of that type (the Entra crawler: its catalogs' owners), so a role it
// wrote before ('sync') and no longer states is removed first, in the same
// transaction. Only the system's own synced contexts of that one type are
// touched, and only 'sync' rows: an analyst's role, or the Accountable the owner
// reconcile wrote ('sourceOwner'), always stays.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { crawlerHasPermission, crawlerHasSystemAccess } from '../../middleware/crawlerAuth.js';
import { parseRoleBody, ROLE_BEARING_CATEGORIES, HOLDER_TABLE } from '../contexts/roles.js';
import { OWNER_ADDED_BY } from '../../ingest/contextOwners.js';
import { parseRelationshipBody } from '../contexts/relationships.js';
import { UUID_RE } from '../contexts/shared.js';

const router = Router();
const useSql = process.env.USE_SQL === 'true';

// One batch is a catalogue's worth of roles, not a bulk load.
export const MAX_LINK_RECORDS = 5000;

const fail = (status, message) => ({ status, message });

// The envelope both endpoints share. Returns { status, message } on the first
// failure, else { systemId, records }.
export function parseLinkEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Request body must be a JSON object');
  const systemId = Number(body.systemId);
  if (!Number.isInteger(systemId) || systemId <= 0) return fail(400, 'systemId (a positive integer) is required');
  if (!Array.isArray(body.records)) return fail(400, 'records must be an array');
  if (body.records.length > MAX_LINK_RECORDS) return fail(400, `At most ${MAX_LINK_RECORDS} records per batch`);
  return { systemId, records: body.records };
}

// Validate every record with `parseOne(record, contextId)` before anything is
// written: one bad record fails the batch, naming its index.
function parseRecords(records, parseOne) {
  const rows = [];
  for (const [i, rec] of records.entries()) {
    const r = rec && typeof rec === 'object' ? rec : {};
    if (!UUID_RE.test(String(r.contextId ?? ''))) return fail(400, `records[${i}]: contextId (uuid) is required`);
    const contextId = String(r.contextId).toLowerCase();
    const parsed = parseOne(r, contextId);
    if (parsed.status) return fail(400, `records[${i}]: ${parsed.message}`);
    rows.push({ contextId, ...parsed });
  }
  return { rows };
}

export const parseRoleRecords = (records) => parseRecords(records, (r) => parseRoleBody(r));
export const parseRelationshipRecords = (records) => parseRecords(records, (r, contextId) => parseRelationshipBody(r, contextId));

// Insert the role when the context is the system's own and carries roles, and
// the holder exists. ON CONFLICT DO NOTHING covers both a duplicate and a
// context that already has its one Accountable (ux_ContextRoles_accountable).
// holderCol comes from parseRoleBody, which only ever returns the two keys of
// HOLDER_TABLE, so the identifiers below are never caller text. `addedBy` is
// 'sync' for a role a crawler states, or the owner reconcile's own marker for
// an owner the context upload matched itself (a near miss the ingest does not
// take) — never caller text either.
const ROLE_ADDED_BY = new Set(['sync', OWNER_ADDED_BY]);
export function roleInsertSql(holderCol, addedBy = 'sync') {
  if (!ROLE_ADDED_BY.has(addedBy)) throw new Error(`roleInsertSql: unsupported addedBy ${addedBy}`);
  return `
    INSERT INTO "ContextRoles" ("contextId", "${holderCol}", role, "addedBy")
    SELECT c.id, h.id, $3, '${addedBy}'
      FROM "Contexts" c
      JOIN "${HOLDER_TABLE[holderCol]}" h ON h.id = $2
     WHERE c.id = $1 AND c."scopeSystemId" = $4 AND c."contextCategory" = ANY($5::text[])
    ON CONFLICT DO NOTHING`;
}

// Insert the link when the first context is the system's own and the two hold
// different kinds of member (variants of one unit, as the analyst route
// requires). The pair index (ux_ContextRelationships_pair) is on the unordered
// pair, so a link already stored the other way round is a conflict too.
export const RELATIONSHIP_INSERT_SQL = `
    INSERT INTO "ContextRelationships" ("contextId", "relatedContextId", "relationshipType", "addedBy")
    SELECT a.id, b.id, $3, 'sync'
      FROM "Contexts" a
      JOIN "Contexts" b ON b.id = $2 AND b."targetType" <> a."targetType"
     WHERE a.id = $1 AND a."scopeSystemId" = $4
    ON CONFLICT DO NOTHING`;

// Gate + envelope + records, shared by both endpoints. Returns { status,
// message } to send, or { systemId, rows }.
function admit(req, parseRows) {
  if (!useSql) return fail(503, 'SQL not configured');
  if (!crawlerHasPermission(req, 'ingest')) return fail(403, 'Insufficient permissions');
  const env = parseLinkEnvelope(req.body);
  if (env.status) return env;
  if (!crawlerHasSystemAccess(req, env.systemId)) return fail(403, `Crawler does not have access to system ${env.systemId}`);
  const parsed = parseRows(env.records);
  if (parsed.status) return parsed;
  return { systemId: env.systemId, rows: parsed.rows };
}

// Run `paramsFor(row)` through `sqlFor(row)` per row; count what landed.
// `runner` is the db module or an in-transaction client.
async function insertEach(rows, sqlFor, paramsFor, runner = db) {
  let inserted = 0;
  for (const row of rows) {
    const r = await runner.query(sqlFor(row), paramsFor(row));
    inserted += r.rowCount || 0;
  }
  return { inserted, skipped: rows.length - inserted };
}

function linkEndpoint(label, parseRows, sqlFor, paramsFor) {
  return async (req, res) => {
    const admitted = admit(req, parseRows);
    if (admitted.status) return res.status(admitted.status).json({ error: admitted.message });
    try {
      res.json(await insertEach(admitted.rows, sqlFor, (row) => paramsFor(row, admitted.systemId)));
    } catch (err) {
      console.error(`POST ingest/${label} failed:`, err.message);
      res.status(500).json({ error: `Failed to ingest ${label}` });
    }
  };
}

// The 'sync' roles on the system's synced contexts of one type ($1 system, $2
// contextType) that the batch ($3..$6: contextId, role, holder column, holder
// id, one entry per row) no longer states.
export const ROLE_RECONCILE_SQL = `
    DELETE FROM "ContextRoles" r
     USING "Contexts" c
     WHERE r."contextId" = c.id
       AND c.variant = 'synced' AND c."scopeSystemId" = $1 AND c."contextType" = $2
       AND r."addedBy" = 'sync'
       AND NOT EXISTS (
         SELECT 1 FROM unnest($3::uuid[], $4::text[], $5::text[], $6::uuid[]) AS k("contextId", role, col, holder)
          WHERE k."contextId" = r."contextId" AND k.role = r.role
            AND k.holder = CASE k.col WHEN 'principalId' THEN r."principalId" ELSE r."identityId" END)`;

export function roleReconcileParams(systemId, contextType, rows) {
  return [
    systemId, contextType,
    rows.map(r => r.contextId), rows.map(r => r.role), rows.map(r => r.holderCol), rows.map(r => r.holderId),
  ];
}

// The role sync mode: additive unless the body asks for 'full', which needs the
// contextType it reconciles. Returns { full, contextType } or { status, message }.
export function parseRoleSyncMode(body) {
  if (body?.syncMode !== 'full') return { full: false };
  const contextType = body.scope?.contextType;
  if (typeof contextType !== 'string' || !contextType.trim()) return fail(400, 'a full role sync needs scope.contextType');
  return { full: true, contextType: contextType.trim() };
}

const ROLE_CATEGORIES = [...ROLE_BEARING_CATEGORIES];
const roleSql = (row) => roleInsertSql(row.holderCol);
const roleParams = (row, systemId) => [row.contextId, row.holderId, row.role, systemId, ROLE_CATEGORIES];
const relationshipSql = () => RELATIONSHIP_INSERT_SQL;
const relationshipParams = (row, systemId) => [row.contextId, row.relatedContextId, row.relationshipType, systemId];

// The two writers, for in-process sources that hold their own permission (the
// context upload): already-parsed rows — { contextId, role, holderCol, holderId }
// and { contextId, relatedContextId, relationshipType } — added for `systemId`
// under exactly the rules the endpoints apply. Returns { inserted, skipped }.
export const insertRoleRows = (rows, systemId) => insertEach(rows, roleSql, (row) => roleParams(row, systemId));
// Accountable rows that state the source's owner field (the upload's owner
// column): written as the owner reconcile's own rows, so the next import keeps
// them in step with that column — replaced when the owner changes, removed when
// it goes — exactly as for an owner the ingest resolved itself.
export const insertOwnerRows = (rows, systemId) =>
  insertEach(rows, (row) => roleInsertSql(row.holderCol, OWNER_ADDED_BY), (row) => roleParams(row, systemId));
export const insertRelationshipRows = (rows, systemId) => insertEach(rows, relationshipSql, (row) => relationshipParams(row, systemId));

// Reconcile, then add — one transaction, so a reader never sees a catalog that
// lost its owners between the two statements.
async function syncRolesFull(systemId, contextType, rows) {
  return db.tx(async (client) => {
    const removed = await client.query(ROLE_RECONCILE_SQL, roleReconcileParams(systemId, contextType, rows));
    const counts = await insertEach(rows, roleSql, (row) => roleParams(row, systemId), client);
    return { ...counts, removed: removed.rowCount || 0 };
  });
}

router.post('/ingest/context-roles', async (req, res) => {
  const admitted = admit(req, parseRoleRecords);
  if (admitted.status) return res.status(admitted.status).json({ error: admitted.message });
  const mode = parseRoleSyncMode(req.body);
  if (mode.status) return res.status(mode.status).json({ error: mode.message });
  try {
    if (mode.full) return res.json(await syncRolesFull(admitted.systemId, mode.contextType, admitted.rows));
    res.json(await insertEach(admitted.rows, roleSql, (row) => roleParams(row, admitted.systemId)));
  } catch (err) {
    console.error('POST ingest/context-roles failed:', err.message);
    res.status(500).json({ error: 'Failed to ingest context-roles' });
  }
});

router.post('/ingest/context-relationships', linkEndpoint('context-relationships', parseRelationshipRecords, relationshipSql, relationshipParams));

export default router;

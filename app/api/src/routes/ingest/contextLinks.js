// Context roles and context-to-context links sent by a crawler —
// POST /api/ingest/context-roles and POST /api/ingest/context-relationships.
//
// The analyst routes (routes/contexts/roles.js, relationships.js) write the
// same tables, but a crawler key (fgc_) is only valid on /api/ingest and
// /api/crawlers, so a source that knows who answers for an application — an
// IGA application catalogue, the demo dataset — needs this door. Rows written
// here are addedBy = 'sync' (migration 092 reserved the value for them).
//
// Envelope: { systemId, records: [...] }. A crawler may only set roles and
// links on the contexts its system owns (Contexts.scopeSystemId = systemId),
// the same boundary a contexts full sync is held to.
//
// ADDITIVE. Each record is inserted when it is new and skipped otherwise — an
// existing Accountable, a duplicate, a context the system does not own, a
// holder or related context that does not exist. Nothing is updated or removed,
// so an analyst's own roles and links survive every crawl. A reconciling
// (full-sync) mode is the follow-on once a real source sends roles.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { crawlerHasPermission, crawlerHasSystemAccess } from '../../middleware/crawlerAuth.js';
import { parseRoleBody, ROLE_BEARING_CATEGORIES, HOLDER_TABLE } from '../contexts/roles.js';
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
// HOLDER_TABLE, so the identifiers below are never caller text.
export function roleInsertSql(holderCol) {
  return `
    INSERT INTO "ContextRoles" ("contextId", "${holderCol}", role, "addedBy")
    SELECT c.id, h.id, $3, 'sync'
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
async function insertEach(rows, sqlFor, paramsFor) {
  let inserted = 0;
  for (const row of rows) {
    const r = await db.query(sqlFor(row), paramsFor(row));
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

const ROLE_CATEGORIES = [...ROLE_BEARING_CATEGORIES];

router.post('/ingest/context-roles', linkEndpoint(
  'context-roles', parseRoleRecords,
  (row) => roleInsertSql(row.holderCol),
  (row, systemId) => [row.contextId, row.holderId, row.role, systemId, ROLE_CATEGORIES],
));

router.post('/ingest/context-relationships', linkEndpoint(
  'context-relationships', parseRelationshipRecords,
  () => RELATIONSHIP_INSERT_SQL,
  (row, systemId) => [row.contextId, row.relatedContextId, row.relationshipType, systemId],
));

export default router;

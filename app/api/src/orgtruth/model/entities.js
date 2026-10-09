// Organisation truth — entity list and detail (GET /org-truth/entities[/:id]).
// The graph fan-out lives in graph.js; the system-object labels both use are
// resolved here (resolveLabels).
//
// GET /org-truth/entities?type=&q=&status=&sourceId=&includeClosed=&page=1&pageSize=50
//   { data: [ { id, entityType, displayName, status, confidence, observedAt, validTo,
//               sourceName, linkCount, relationCount } ],
//     total, page, pageSize }
//   - open entities only unless includeClosed=1 (T4 decision, same as /model)
//   - every status unless status= (proposed | accepted | rejected)
//   - q: case-insensitive contains on displayName (LIKE metacharacters escaped)
//   - linkCount / relationCount leave rejected rows out; relationCount counts
//     both directions; sorted by entityType, then name
//
// GET /org-truth/entities/:id   (null → 404)
//   { id, entityType, displayName, canonicalKey, status, confidence, origin,
//     observedAt, recordedAt, validFrom, validTo, sourceLocator, createdBy,
//     attributes: {},
//     source: { id, displayName, kind, observedAt, fileName },
//     run: { id, mode, finishedAt } | null,
//     relations: { out: [ { id, predicate, status, validTo, confidence, to:   { id, entityType, displayName } } ],
//                  in:  [ { id, predicate, status, validTo, confidence, from: { id, entityType, displayName } } ] },
//     links: [ { id, targetType, targetId, label, resourceType?, confidence, status, analystOverride,
//                signals, matchedField, matchedValue } ] }
//   Relations and links of every status and validity (the detail page shows the history).
import * as db from '../../db/connection.js';
import { createParams, likeContains } from '../../db/sqlParams.js';
import { parseJsonbColumn } from '../../lib/jsonb.js';
import { UUID_RE } from '../../ingest/validation.helpers.js';
import { CLAIM_STATUSES } from '../contracts.js';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_Q_LENGTH = 200;

// Fixed SQL per target type: the table name is never taken from a request.
const LABEL_SQL = {
  Principal: `SELECT id, "displayName" AS label FROM "Principals" WHERE id = ANY($1::uuid[])`,
  Resource:  `SELECT id, "displayName" AS label, "resourceType" FROM "Resources" WHERE id = ANY($1::uuid[])`,
  Identity:  `SELECT id, "displayName" AS label FROM "Identities" WHERE id = ANY($1::uuid[])`,
  Context:   `SELECT id, "displayName" AS label FROM "Contexts" WHERE id = ANY($1::uuid[])`,
};

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
export const isFlag = (v) => v === '1' || v === 'true';

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

const oneString = (v) => (typeof v === 'string' ? v.trim() : undefined);

/** Validate the list query string. Returns { ok: true, value } or { ok: false, error }. */
export function parseListQuery(query = {}) {
  const status = oneString(query.status);
  if (status && !CLAIM_STATUSES.includes(status)) return { ok: false, error: `status must be one of ${CLAIM_STATUSES.join(', ')}` };
  const sourceId = oneString(query.sourceId);
  if (sourceId && !isUuid(sourceId)) return { ok: false, error: 'sourceId must be a UUID' };
  const q = oneString(query.q);
  if (q && q.length > MAX_Q_LENGTH) return { ok: false, error: `q must be at most ${MAX_Q_LENGTH} characters` };
  const page = positiveInt(query.page, 1);
  const pageSize = positiveInt(query.pageSize, DEFAULT_PAGE_SIZE);
  if (page === null || pageSize === null) return { ok: false, error: 'page and pageSize must be positive integers' };
  return {
    ok: true,
    value: {
      type: oneString(query.type) || null,
      q: q || null,
      status: status || null,
      sourceId: sourceId || null,
      includeClosed: isFlag(query.includeClosed),
      page,
      pageSize: Math.min(pageSize, MAX_PAGE_SIZE),
    },
  };
}

function listWhere({ type, q, status, sourceId, includeClosed }) {
  const { params, bind } = createParams();
  const parts = [];
  if (!includeClosed) parts.push('e."validTo" IS NULL');
  if (type) parts.push(`e."entityType" = ${bind(type)}`);
  if (status) parts.push(`e.status = ${bind(status)}`);
  if (sourceId) parts.push(`e."sourceId" = ${bind(sourceId)}::uuid`);
  if (q) parts.push(`lower(e."displayName") LIKE lower(${bind(likeContains(q))}) ESCAPE '\\'`);
  return { where: parts.length ? parts.join(' AND ') : 'TRUE', params };
}

export async function listEntities(opts) {
  const { where, params } = listWhere(opts);
  const n = params.length;
  const [count, page] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS total FROM "OrgEntities" e WHERE ${where}`, params),
    db.query(`
      SELECT e.id, e."entityType", e."displayName", e.status, e.confidence, e."observedAt", e."validTo",
             s."displayName" AS "sourceName",
             (SELECT COUNT(*) FROM "OrgLinks" l
               WHERE l."orgEntityId" = e.id AND l.status <> 'rejected')::int AS "linkCount",
             (SELECT COUNT(*) FROM "OrgRelations" r
               WHERE (r."fromEntityId" = e.id OR r."toEntityId" = e.id) AND r.status <> 'rejected')::int AS "relationCount"
        FROM "OrgEntities" e
        LEFT JOIN "OrgSources" s ON s.id = e."sourceId"
       WHERE ${where}
       ORDER BY e."entityType", lower(e."displayName"), e.id
       LIMIT $${n + 1} OFFSET $${n + 2}
    `, [...params, opts.pageSize, (opts.page - 1) * opts.pageSize]),
  ]);
  return { data: page.rows, total: count.rows[0]?.total ?? 0, page: opts.page, pageSize: opts.pageSize };
}

/**
 * Labels for system objects, one query per target type present.
 * @param {{targetType: string, targetId: string}[]} rows
 * @returns {Promise<Map<string, {label: string, resourceType?: string}>>} keyed `${targetType}:${targetId}`
 */
export async function resolveLabels(rows) {
  const out = new Map();
  for (const targetType of Object.keys(LABEL_SQL)) {
    const ids = [...new Set(rows.filter(r => r.targetType === targetType).map(r => r.targetId))];
    if (ids.length === 0) continue;
    const res = await db.query(LABEL_SQL[targetType], [ids]);
    for (const r of res.rows) {
      const entry = { label: r.label || r.id };
      if (r.resourceType) entry.resourceType = r.resourceType;
      out.set(`${targetType}:${r.id}`, entry);
    }
  }
  return out;
}

async function loadEntityRow(id) {
  const r = await db.query(`
    SELECT e.id, e."entityType", e."displayName", e."canonicalKey", e.status, e.confidence, e.origin,
           e."observedAt", e."recordedAt", e."validFrom", e."validTo", e."sourceLocator", e."createdBy",
           e.attributes,
           s.id AS "sourceId", s."displayName" AS "sourceDisplayName", s.kind AS "sourceKind",
           s."observedAt" AS "sourceObservedAt", s."fileName" AS "sourceFileName",
           r.id AS "runId", r.mode AS "runMode", r."finishedAt" AS "runFinishedAt"
      FROM "OrgEntities" e
      LEFT JOIN "OrgSources" s ON s.id = e."sourceId"
      LEFT JOIN "OrgImportRuns" r ON r.id = e."runId"
     WHERE e.id = $1
  `, [id]);
  return r.rows[0] || null;
}

async function loadRelations(id) {
  const r = await db.query(`
    SELECT r.id, r.predicate, r.status, r."validTo", r.confidence,
           CASE WHEN r."fromEntityId" = $1 THEN 'out' ELSE 'in' END AS direction,
           o.id AS "otherId", o."entityType" AS "otherType", o."displayName" AS "otherName"
      FROM "OrgRelations" r
      JOIN "OrgEntities" o
        ON o.id = CASE WHEN r."fromEntityId" = $1 THEN r."toEntityId" ELSE r."fromEntityId" END
     WHERE r."fromEntityId" = $1 OR r."toEntityId" = $1
     ORDER BY r.predicate, lower(o."displayName"), r.id
  `, [id]);
  const out = [];
  const inbound = [];
  for (const row of r.rows) {
    const other = { id: row.otherId, entityType: row.otherType, displayName: row.otherName };
    const base = { id: row.id, predicate: row.predicate, status: row.status, validTo: row.validTo, confidence: row.confidence };
    if (row.direction === 'out') out.push({ ...base, to: other });
    else inbound.push({ ...base, from: other });
  }
  return { out, in: inbound };
}

async function loadLinks(id) {
  const r = await db.query(`
    SELECT l.id, l."targetType", l."targetId", l.confidence, l.status, l."analystOverride",
           l.signals, l."matchedField", l."matchedValue"
      FROM "OrgLinks" l
     WHERE l."orgEntityId" = $1
     ORDER BY l."targetType", l.confidence DESC, l.id
  `, [id]);
  const labels = await resolveLabels(r.rows);
  return r.rows.map(l => {
    const found = labels.get(`${l.targetType}:${l.targetId}`);
    const link = { ...l, label: found?.label || l.targetId };
    if (found?.resourceType) link.resourceType = found.resourceType;
    return link;
  });
}

function shapeEntity(row) {
  return {
    id: row.id,
    entityType: row.entityType,
    displayName: row.displayName,
    canonicalKey: row.canonicalKey,
    status: row.status,
    confidence: row.confidence,
    origin: row.origin,
    observedAt: row.observedAt,
    recordedAt: row.recordedAt,
    validFrom: row.validFrom,
    validTo: row.validTo,
    sourceLocator: row.sourceLocator,
    createdBy: row.createdBy,
    attributes: parseJsonbColumn(row.attributes) || {},
    source: {
      id: row.sourceId,
      displayName: row.sourceDisplayName,
      kind: row.sourceKind,
      observedAt: row.sourceObservedAt,
      fileName: row.sourceFileName,
    },
    run: row.runId ? { id: row.runId, mode: row.runMode, finishedAt: row.runFinishedAt } : null,
  };
}

/** One entity with its source, run, relations and links; null when unknown. */
export async function getEntity(id) {
  const row = await loadEntityRow(id);
  if (!row) return null;
  const relations = await loadRelations(id);
  const links = await loadLinks(id);
  return { ...shapeEntity(row), relations, links };
}

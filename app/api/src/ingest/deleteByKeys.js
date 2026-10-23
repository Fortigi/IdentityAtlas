// Delete-by-key — the delta tombstone for rows that have no `id` of their own.
//
// `deletedIds` removes Principals / Resources by id, which is what a Graph
// `@removed` user or group needs. A removed group MEMBERSHIP has no id: an
// assignment row is identified by its composite key (resourceId, principalId,
// assignmentType, governed). Without a way to name that key a delta crawler can
// add memberships but never take one away, so every membership had to be
// re-read in full on every run.
//
// `deletedKeys` is that way: an array of key objects, one per row to remove.
// Every delete is bounded to the batch's own systemId — a crawler can only take
// back rows its own system wrote — and, for a key restricted to specific
// systems, to those systems as well (same rule as deletedIds, SEC-2026-09 H-04).
// Soft-delete tables stamp deletedAt; re-ingesting the row clears the stamp.

import * as db from '../db/connection.js';
import { SOFT_DELETE_TABLES } from './engine.js';
import { ownedRowPredicate } from './systemBoundary.js';
import { UUID_RE, isBlank } from './validation.helpers.js';

export const MAX_DELETED_KEYS = 50000;

// The entities that accept deletedKeys: their key columns with the postgres type
// each is unnested as, plus the default a key column takes when omitted (the
// same default applyIngestDefaults gives a record). The row filter keeps the
// delete on the principal arm of the shared ResourceAssignments table.
export const DELETE_BY_KEY_ENTITIES = {
  'resource-assignments': {
    table: 'ResourceAssignments',
    columns: [
      { name: 'resourceId', type: 'uuid' },
      { name: 'principalId', type: 'uuid' },
      { name: 'assignmentType', type: 'text' },
      { name: 'governed', type: 'boolean', default: false },
    ],
    rowFilter: 't."principalId" IS NOT NULL',
  },
};

// Envelope check. Returns an array of error strings (empty when it passes), like
// the other envelope validators. Stops at the first bad entry: one malformed key
// rejects the batch, the same way one non-UUID rejects a deletedIds batch.
export function validateDeletedKeys(body, entityType) {
  const { deletedKeys } = body;
  if (deletedKeys === undefined || deletedKeys === null) return [];
  if (!Array.isArray(deletedKeys)) return ['deletedKeys must be an array when provided'];
  if (deletedKeys.length === 0) return [];
  const spec = DELETE_BY_KEY_ENTITIES[entityType];
  if (!spec) return [`deletedKeys is not supported for ${entityType}`];
  if (deletedKeys.length > MAX_DELETED_KEYS) return [`deletedKeys array cannot exceed ${MAX_DELETED_KEYS.toLocaleString('en-US')} items`];
  for (let i = 0; i < deletedKeys.length; i++) {
    const err = keyEntryError(deletedKeys[i], spec.columns);
    if (err) return [`deletedKeys[${i}]: ${err}`];
  }
  return [];
}

// Per column type: whether a supplied value is acceptable, and what to say if not.
const TYPE_CHECKS = {
  uuid: { ok: v => typeof v === 'string' && UUID_RE.test(v), expected: 'a UUID' },
  boolean: { ok: v => typeof v === 'boolean', expected: 'a boolean' },
  text: { ok: v => typeof v === 'string', expected: 'a string' },
};

function columnError(col, value) {
  if (isBlank(value)) return col.default === undefined ? `${col.name} is required` : null;
  const check = TYPE_CHECKS[col.type];
  return check.ok(value) ? null : `${col.name} must be ${check.expected}`;
}

function keyEntryError(entry, columns) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'must be an object';
  for (const col of columns) {
    const err = columnError(col, entry[col.name]);
    if (err) return err;
  }
  return null;
}

// The delete statement for a validated batch. One unnest() row per key, joined
// to the table on every key column, so the whole batch is one statement however
// many keys it carries. Pure. Exported for unit tests.
export function buildDeleteByKeysSql(spec, keys, systemId, restrictSystemIds = null) {
  const params = spec.columns.map(col => keys.map(k => (isBlank(k[col.name]) ? col.default : k[col.name])));
  const unnestArgs = spec.columns.map((col, i) => `$${i + 1}::${col.type}[]`).join(', ');
  const keyNames = spec.columns.map(col => `"${col.name}"`).join(', ');
  const match = spec.columns.map(col => `t."${col.name}" = k."${col.name}"`);

  params.push(systemId);
  const where = [...match, `t."systemId" = $${params.length}`];
  if (spec.rowFilter) where.push(spec.rowFilter);
  if (Array.isArray(restrictSystemIds)) {
    params.push(restrictSystemIds);
    const owned = ownedRowPredicate(spec.table, 't', `$${params.length}`) || 'false';
    where.push(`COALESCE((${owned}), false)`);
  }

  const source = `unnest(${unnestArgs}) AS k(${keyNames})`;
  const sql = SOFT_DELETE_TABLES.has(spec.table)
    ? `UPDATE "${spec.table}" t SET "deletedAt" = now() FROM ${source} WHERE ${where.join(' AND ')} AND t."deletedAt" IS NULL`
    : `DELETE FROM "${spec.table}" t USING ${source} WHERE ${where.join(' AND ')}`;
  return { sql, params };
}

// Apply a batch's deletedKeys and add the count to `result.deleted`. Returns a
// { status, body } error response, or null on success / no-op. The envelope has
// already been validated (validateDeletedKeys) by the time this runs.
export async function applyDeleteByKeys(body, entityType, result, restrictSystemIds = null) {
  if (!Array.isArray(body.deletedKeys) || body.deletedKeys.length === 0) return null;
  const spec = DELETE_BY_KEY_ENTITIES[entityType];
  if (!spec) return { status: 400, body: { error: `deletedKeys is not supported for ${entityType}` } };
  try {
    const { sql, params } = buildDeleteByKeysSql(spec, body.deletedKeys, body.systemId, restrictSystemIds);
    const res = await db.query(sql, params);
    result.deleted += res.rowCount || 0;
    return null;
  } catch (err) {
    console.error('Delete-by-key failed on %s: %s', spec.table, err.message);
    return { status: 500, body: { error: 'Delete-by-key failed', message: err.message } };
  }
}

// Staged full load: stream a scope's complete row set into an unindexed staging
// table over as many requests as it takes, then apply it in one step.
//
// WHY — measured on the scale rig (docs/architecture/scale-rehearsal.md), 4.1M
// assignment rows, all 13 ResourceAssignments indexes:
//   today's 10k-row upsert batches            113 s
//   bare insert into an empty table + build   20 s   (indexes built once, afterwards)
//   unchanged re-import, every row touched    171 s  (the timestamp reconcile needs
//                                                     every row's updatedAt rewritten,
//                                                     and updatedAt is indexed)
//   unchanged re-import, changed rows only    64 s
// A streamed full sync today must touch every row just to say "still here", so a
// re-import of unchanged data costs more than the first load. With the complete key
// set in a stage, "what is gone" is an anti-join and "what changed" a comparison:
// unchanged rows are not written at all.
//
// This is a size trade-off, not a verdict on the timestamp reconcile: for a small
// scope, touching every row is cheap and needs no stage, and it remains the right
// tool there. The stage exists for scopes where saying nothing is much cheaper than
// saying "still here".
//
// Finalize takes one of two paths, and reports which:
//   'empty-table' — the TARGET TABLE (every system) holds no rows. Its non-constraint
//     indexes are dropped, the stage is inserted bare, and the indexes are rebuilt.
//     Emptiness is checked under an ACCESS EXCLUSIVE lock taken inside the same
//     transaction, with a short lock_timeout; if the lock cannot be had, or the table
//     is not empty, it falls back to 'merge'. Finalizes are also serialised per table.
//   'merge' — insert new rows, update only rows whose values changed, and (when asked)
//     remove rows of this system+scope that are not in the stage — the same anti-join
//     the session protocol's full sync uses (engine.scopedDelete).
//
// A stage may carry only key columns (a key sweep): finalize then only removes what is
// missing. Stages live in memory; an API restart abandons them (their tables are
// dropped at startup) and the caller starts over.

import crypto from 'crypto';
import * as db from '../db/connection.js';
import { resolveActiveColumns, discoverColumns, scopedDelete, SOFT_DELETE_TABLES } from './engine.js';
import { bulkInsertIntoTemp } from './tempTableHelpers.js';
import { createSerializedRunner } from '../lib/serializedRunner.js';

export const STAGE_PREFIX = '_stage_';
const STAGE_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_TABLE_LOCK_TIMEOUT = '5s';
const stages = new Map();

export class StageError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function columnType(c) {
  return c.sqlTypeName === 'USER-DEFINED' ? 'text' : c.sqlTypeName;
}

// ── lifecycle ────────────────────────────────────────────────────────────────

export function openStage({ tableName, keyColumns, systemId, scope = {}, conflictFilter = null,
  scopeDeleteFilter = null, preserveColumns = null, restrictSystemIds = null, ownerId = null, now = Date.now() }) {
  sweepExpired(now);
  const id = crypto.randomUUID();
  const stage = {
    id, tableName, keyColumns, systemId, scope, conflictFilter, scopeDeleteFilter, preserveColumns,
    restrictSystemIds, ownerId, stageTable: `${STAGE_PREFIX}${id.replace(/-/g, '')}`,
    columns: null, rows: 0, createdAt: now,
  };
  stages.set(id, stage);
  return stage;
}

export function getStage(id, ownerId) {
  const stage = stages.get(id);
  if (!stage) throw new StageError(404, `Stage '${id}' not found or expired`);
  if (stage.ownerId !== ownerId) throw new StageError(403, 'Stage belongs to another crawler');
  return stage;
}

// Append a batch of already-validated, normalized records.
export async function appendToStage(stage, records) {
  if (!records || records.length === 0) return { rows: stage.rows };
  if (!stage.columns) {
    stage.columns = await resolveActiveColumns(stage.tableName, records, stage.keyColumns);
    const defs = stage.columns.map(c => `"${c.name}" ${columnType(c)}`).join(', ');
    await db.query(`CREATE UNLOGGED TABLE "${stage.stageTable}" (${defs})`);
  } else {
    const known = new Set(stage.columns.map(c => c.name));
    const extra = [...new Set(records.flatMap(r => Object.keys(r)))].filter(k => !known.has(k) && k !== 'systemId');
    const unknownToTable = new Set((await discoverColumns(null, stage.tableName)).map(c => c.name));
    const added = extra.filter(k => unknownToTable.has(k));
    if (added.length) throw new StageError(400, `Every batch of a stage must carry the same columns; this one adds: ${added.join(', ')}`);
  }
  await db.tx(client => bulkInsertIntoTemp(client, stage.stageTable, stage.columns, records, 1000, true));
  stage.rows += records.length;
  return { rows: stage.rows };
}

export async function abortStage(stage) {
  stages.delete(stage.id);
  await db.query(`DROP TABLE IF EXISTS "${stage.stageTable}"`);
}

function sweepExpired(now) {
  for (const s of stages.values()) {
    if (now - s.createdAt > STAGE_TTL_MS) {
      stages.delete(s.id);
      db.query(`DROP TABLE IF EXISTS "${s.stageTable}"`).catch(() => {});
    }
  }
}

// At startup no stage survives (the registry is in memory): drop their tables.
export async function dropAbandonedStages() {
  const { rows } = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE $1`, [`${STAGE_PREFIX}%`]);
  for (const r of rows) await db.query(`DROP TABLE IF EXISTS "${r.tablename}"`);
  return rows.length;
}

// ── finalize ─────────────────────────────────────────────────────────────────

// One finalize at a time per target table: the empty-table path drops and rebuilds
// that table's indexes, which nothing else may overlap.
const finalizeRunners = new Map();
function runnerFor(tableName) {
  if (!finalizeRunners.has(tableName)) {
    let job = null;
    const run = createSerializedRunner(() => job());
    finalizeRunners.set(tableName, (fn) => { job = fn; return run(); });
  }
  return finalizeRunners.get(tableName);
}

export async function finalizeStage(stage, { deleteMissing = false } = {}) {
  stages.delete(stage.id);
  try {
    if (!stage.columns) return { path: 'empty-stage', inserted: 0, updated: 0, deleted: 0, rows: 0 };
    return await runnerFor(stage.tableName)(() => db.tx(client => applyStage(client, stage, deleteMissing)));
  } finally {
    await db.query(`DROP TABLE IF EXISTS "${stage.stageTable}"`).catch(() => {});
  }
}

async function applyStage(client, stage, deleteMissing) {
  const nonKey = stage.columns.filter(c => !stage.keyColumns.includes(c.name));
  const keysOnly = nonKey.length === 0;
  await client.query(`ANALYZE "${stage.stageTable}"`);
  if (!keysOnly && await lockEmptyTable(client, stage.tableName)) {
    const inserted = await loadIntoEmptyTable(client, stage);
    return { path: 'empty-table', inserted, updated: 0, deleted: 0, rows: stage.rows };
  }
  const inserted = keysOnly ? 0 : await insertNew(client, stage);
  const updated = keysOnly ? 0 : await updateChanged(client, stage, nonKey);
  const deleted = deleteMissing ? await deleteMissingRows(client, stage) : 0;
  return { path: 'merge', inserted, updated, deleted, rows: stage.rows };
}

// Take the table exclusively and confirm it is empty — both inside this
// transaction, so the answer holds until commit. Fails closed: no lock, no fast path.
export async function lockEmptyTable(client, tableName) {
  await client.query('SAVEPOINT empty_table_probe');
  try {
    await client.query(`SET LOCAL lock_timeout = '${EMPTY_TABLE_LOCK_TIMEOUT}'`);
    await client.query(`LOCK TABLE "${tableName}" IN ACCESS EXCLUSIVE MODE`);
    const { rows } = await client.query(`SELECT NOT EXISTS (SELECT 1 FROM "${tableName}") AS "empty"`);
    if (rows[0]?.empty) return true;
  } catch (err) {
    console.warn(`stage finalize: no exclusive lock on ${tableName} (${err.message}) — merging instead`);
  }
  // Release the lock (or the failed attempt) and carry on with an ordinary merge.
  await client.query('ROLLBACK TO SAVEPOINT empty_table_probe');
  await client.query('RESET lock_timeout');
  return false;
}

function distinctStageSql(stage) {
  const cols = stage.columns.map(c => `"${c.name}"`).join(', ');
  const keys = stage.keyColumns.map(k => `"${k}"`).join(', ');
  // One row per key; the last batch sent for a key is not guaranteed to win, so
  // callers dedupe upstream as they do today. systemId is stamped from the stage.
  return { cols, sql: `SELECT DISTINCT ON (${keys}) ${cols} FROM "${stage.stageTable}"` };
}

function withSystem(stage, cols, selectCols) {
  const hasSystem = stage.columns.some(c => c.name === 'systemId');
  if (hasSystem || stage.systemId == null) return { cols, selectCols };
  return { cols: `${cols}, "systemId"`, selectCols: `${selectCols}, ${Number(stage.systemId)}` };
}

async function loadIntoEmptyTable(client, stage) {
  const { rows: idx } = await client.query(
    `SELECT i.indexname, i.indexdef FROM pg_indexes i
      WHERE i.schemaname = 'public' AND i.tablename = $1
        AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname)`, [stage.tableName]);
  for (const { indexname } of idx) await client.query(`DROP INDEX "${indexname}"`);
  const d = distinctStageSql(stage);
  const { cols, selectCols } = withSystem(stage, d.cols, d.cols);
  const res = await client.query(
    `INSERT INTO "${stage.tableName}" (${cols}) SELECT ${selectCols} FROM (${d.sql}) s`);
  for (const { indexdef } of idx) await client.query(indexdef);
  return res.rowCount || 0;
}

function keyMatch(stage, t = 't', s = 's') {
  return stage.keyColumns.map(k => `${t}."${k}" = ${s}."${k}"`).join(' AND ');
}

function targetFilter(stage) {
  return stage.conflictFilter ? ` AND (${stage.conflictFilter.replace(/"(\w+)"/g, 't."$1"')})` : '';
}

async function insertNew(client, stage) {
  const d = distinctStageSql(stage);
  const { cols, selectCols } = withSystem(stage, d.cols, d.cols.split(', ').map(c => `s.${c}`).join(', '));
  const conflict = `(${stage.keyColumns.map(k => `"${k}"`).join(', ')})${stage.conflictFilter ? ` WHERE ${stage.conflictFilter}` : ''}`;
  const res = await client.query(`
    INSERT INTO "${stage.tableName}" (${cols})
    SELECT ${selectCols} FROM (${d.sql}) s
     WHERE NOT EXISTS (SELECT 1 FROM "${stage.tableName}" t WHERE ${keyMatch(stage)}${targetFilter(stage)})
    ON CONFLICT ${conflict} DO NOTHING`);
  return res.rowCount || 0;
}

// Only rows whose values differ are written. A soft-deleted row that is back in the
// stage is revived. "updatedAt" (when present) is stamped on the rows written only.
async function updateChanged(client, stage, nonKey) {
  const preserved = new Set(stage.preserveColumns || []);
  const writable = nonKey.filter(c => c.name !== 'systemId' || !preserved.has('systemId'));
  const set = writable.map(c => (preserved.has(c.name)
    ? `"${c.name}" = COALESCE(t."${c.name}", s."${c.name}")`
    : `"${c.name}" = s."${c.name}"`));
  const tableCols = new Set((await discoverColumns(null, stage.tableName)).map(c => c.name));
  const changed = writable.filter(c => !preserved.has(c.name))
    .map(c => `t."${c.name}" IS DISTINCT FROM s."${c.name}"`);
  const revive = SOFT_DELETE_TABLES.has(stage.tableName) ? ['t."deletedAt" IS NOT NULL'] : [];
  if (revive.length) set.push('"deletedAt" = NULL');
  if (tableCols.has('updatedAt') && !writable.some(c => c.name === 'updatedAt')) set.push('"updatedAt" = now()');
  const when = [...changed, ...revive];
  if (set.length === 0 || when.length === 0) return 0;
  const res = await client.query(`
    UPDATE "${stage.tableName}" t SET ${set.join(', ')}
      FROM (${distinctStageSql(stage).sql}) s
     WHERE ${keyMatch(stage)}${targetFilter(stage)} AND (${when.join(' OR ')})`);
  return res.rowCount || 0;
}

async function deleteMissingRows(client, stage) {
  const tableColumnNames = new Set((await discoverColumns(null, stage.tableName)).map(c => c.name));
  return scopedDelete(client, stage.tableName, stage.keyColumns, stage.stageTable, stage.systemId, stage.scope,
    'systemId', tableColumnNames, stage.scopeDeleteFilter, stage.restrictSystemIds);
}

// Test hook.
export function _stagesForTest() { return stages; }

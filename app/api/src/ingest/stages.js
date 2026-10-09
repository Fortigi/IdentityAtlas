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
// A stage opened with `keysOnly` — a key sweep — is only saying what still exists:
// finalize inserts and updates nothing and only removes what is missing. (A stage whose
// records carry no non-key column at all is treated the same way, but a sweep must say
// so: the rows endpoint stamps systemId on every record, so a sweep's stage and an
// ordinary load of a scope with no optional attributes look identical.) `maxDeleteShare`
// caps that removal at a share of the scope's live rows and refuses the whole finalize
// (409, nothing written) above it. Every result carries `distinct`, the number of
// distinct keys the stage held (see distinctKeyCount); a finalize WITHOUT deleteMissing
// also carries `present`, how many of those are live in the table afterwards. Stages live in memory; an API restart abandons them
// (their tables are dropped at startup) and the caller starts over.

import crypto from 'crypto';
import { markInitialLoad, markInitialLoadForAll } from './initialLoad.js';
import * as db from '../db/connection.js';
import { resolveActiveColumns, discoverColumns, scopedDelete, scopeLiveCount, markGovernanceMemberships, SOFT_DELETE_TABLES } from './engine.js';
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
  scopeDeleteFilter = null, preserveColumns = null, restrictSystemIds = null, ownerId = null,
  keysOnly = false, now = Date.now() }) {
  sweepExpired(now);
  const id = crypto.randomUUID();
  const stage = {
    id, tableName, keyColumns, systemId, scope, conflictFilter, scopeDeleteFilter, preserveColumns,
    restrictSystemIds, ownerId, keysOnly, stageTable: `${STAGE_PREFIX}${id.replace(/-/g, '')}`,
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
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND starts_with(tablename, $1)`, [STAGE_PREFIX]);
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

export async function finalizeStage(stage, options = {}) {
  return (await finalizeStages([stage], options))[0];
}

const EMPTY_STAGE = { path: 'empty-stage', inserted: 0, updated: 0, deleted: 0, rows: 0, distinct: 0 };
const nonKeyColumns = (st) => st.columns.filter(c => !st.keyColumns.includes(c.name));

// Is this stage here only to say what still exists?
//
// It cannot be inferred from the columns, which is the trap: the rows endpoint
// stamps `systemId` on every normalized record, so a key sweep's stage always
// carries key columns PLUS systemId — and so does a perfectly ordinary load of a
// scope whose rows have no optional attributes set, which must still insert. The
// two are indistinguishable by shape and opposite in intent, so the CALLER says
// which it is. `keysOnly` only ever makes finalize write less, so trusting it
// cannot corrupt anything.
//
// Left to inference, a sweep inserted a bare keyed row for every grant the delta
// had not yet loaded — attributes all null, outside its own scope filter, and
// invisible; and against an empty table it did that through the index-dropping
// bulk path.
const isKeysOnly = (st) => st.keysOnly === true || nonKeyColumns(st).length === 0;

// A sweep is the one operation here with no undo, and the source it reads can
// be caught mid-aggregation — rows deleted and about to be re-inserted. So a
// finalize may be given a ceiling: remove at most this share of the scope's
// live rows, or remove nothing at all. The count is exact (the delete runs and
// its transaction is rolled back), never an estimate.
export class DeleteShareExceeded extends StageError {
  constructor(stage, deleted, scopeRows, maxShare) {
    super(409, `Refusing to finalize: it would remove ${deleted} of ${scopeRows} rows in ` +
      `${stage.tableName} for system ${stage.systemId} (${(100 * deleted / scopeRows).toFixed(1)}%), ` +
      `more than the ${(100 * maxShare).toFixed(1)}% allowed. Nothing was written. ` +
      `A source read mid-aggregation looks exactly like this; re-run when it has finished, ` +
      `or repeat with the share raised if the removal is real.`);
    Object.assign(this, { deleted, scopeRows, maxShare });
  }
}

// Finalize stages of ONE table together — the natural unit is a crawler run, which
// syncs many systems. Together they get one chance at the empty-table path (one
// lock, one index drop and rebuild, every stage inserted bare); a stage finalized
// alone after the first would find the table populated. When that path does not
// apply, each stage merges in its own transaction, so a large re-import is never
// one giant transaction. Results come back in the order the stages were given.
export async function finalizeStages(list, { deleteMissing = false, maxDeleteShare = 0 } = {}) {
  for (const st of list) stages.delete(st.id);
  const tables = new Set(list.map(st => st.tableName));
  try {
    if (tables.size > 1) throw new StageError(400, 'Stages finalized together must target the same table');
    const loaded = list.filter(st => st.columns);
    if (loaded.length === 0) return list.map(() => ({ ...EMPTY_STAGE }));
    const results = await runnerFor(loaded[0].tableName)(() => applyStages(loaded, deleteMissing, maxDeleteShare));
    return list.map(st => (st.columns ? results.get(st.id) : { ...EMPTY_STAGE }));
  } finally {
    for (const st of list) await db.query(`DROP TABLE IF EXISTS "${st.stageTable}"`).catch(() => {});
  }
}

async function applyStages(loaded, deleteMissing, maxDeleteShare) {
  const results = new Map();
  const canBulk = loaded.every(st => !isKeysOnly(st));
  const bulked = canBulk && await db.tx(async (client) => {
    for (const st of loaded) await client.query(`ANALYZE "${st.stageTable}"`);
    if (!(await lockEmptyTable(client, loaded[0].tableName))) return false;
    await loadIntoEmptyTable(client, loaded, results, deleteMissing);
    return true;
  });
  if (!bulked) {
    for (const st of loaded) {
      results.set(st.id, await db.tx(client => mergeStage(client, st, deleteMissing, maxDeleteShare)));
    }
  }
  await analyzeIfChanged(loaded[0].tableName, results);
  return results;
}

// A finalize can write millions of rows in one statement, and the planner only
// learns that when autovacuum next analyzes the table — minutes later. Whatever
// runs first plans against the old statistics: after a staged first load of 4.1M
// assignments the matrix-view refresh that follows took 353 s instead of 17 s,
// and autoanalyze landed a minute into it. So the finalize analyzes the table it
// changed before it returns. It samples a fixed number of rows, so it costs
// seconds even at tens of millions; a finalize that wrote nothing (an unchanged
// re-import, a sweep that found nothing gone) skips it and stays write-free.
async function analyzeIfChanged(tableName, results) {
  const changed = [...results.values()].some(r => (r.inserted || 0) + (r.updated || 0) + (r.deleted || 0) > 0);
  if (changed) await db.query(`ANALYZE "${tableName}"`);
}

// A membership of a governance resource is governed by definition. The engine and
// session paths flag such rows before their upsert (#1272); a stage must too, or
// its key — governed is part of it — misses the row classify already flipped and a
// staged re-import inserts an ungoverned copy beside it.
const markGoverned = (client, stage) =>
  markGovernanceMemberships(client, stage.tableName, stage.stageTable, stage.keyColumns, stage.columns);

async function mergeStage(client, stage, deleteMissing, maxDeleteShare = 0) {
  const nonKey = nonKeyColumns(stage);
  const keysOnly = isKeysOnly(stage);
  await markGoverned(client, stage);
  await client.query(`ANALYZE "${stage.stageTable}"`);
  // A system's initial load writes no per-row insert history (migration 073).
  await markInitialLoad(client, stage.systemId, stage.tableName);
  const distinct = await distinctKeyCount(client, stage);
  const inserted = keysOnly ? 0 : await insertNew(client, stage);
  const updated = keysOnly ? 0 : await updateChanged(client, stage, nonKey);
  // The guard's denominator is read BEFORE the delete and inside this same
  // transaction, so nothing can change between the two halves of the ratio.
  const scopeRows = deleteMissing && maxDeleteShare > 0 ? await liveCount(client, stage) : null;
  const deleted = deleteMissing ? await deleteMissingRows(client, stage) : 0;
  // Throwing here rolls the transaction back, so the rows counted above are
  // still there: the refusal is not "we deleted and then apologised".
  if (scopeRows !== null && scopeRows > 0 && deleted > scopeRows * maxDeleteShare) {
    throw new DeleteShareExceeded(stage, deleted, scopeRows, maxDeleteShare);
  }
  // A stage applied WITHOUT deleteMissing is a window, not the complete set: the
  // scope keeps every row the window did not mention, so its total proves nothing
  // about this stage. What can be proven is that every key the stage held is now
  // live in the table — counted here, inside the transaction that wrote them.
  const present = deleteMissing || keysOnly ? null : await presentKeyCount(client, stage);
  return { path: 'merge', inserted, updated, deleted, rows: stage.rows, distinct, ...(present === null ? {} : { present }) };
}

// How many of the stage's distinct keys are live rows of the target.
async function presentKeyCount(client, stage) {
  const keys = stage.keyColumns.map(k => `"${k}"`).join(', ');
  const live = SOFT_DELETE_TABLES.has(stage.tableName) ? ' AND t."deletedAt" IS NULL' : '';
  const { rows } = await client.query(`
    SELECT count(*) AS n FROM (SELECT DISTINCT ${keys} FROM "${stage.stageTable}") s
     WHERE EXISTS (SELECT 1 FROM "${stage.tableName}" t WHERE ${keyMatch(stage)}${targetFilter(stage)}${live})`);
  return Number(rows[0]?.n ?? 0);
}

// How many DISTINCT keys the stage holds — what the scope holds once a finalize
// with deleteMissing has run, and the only number a caller can verify the result
// against exactly. `rows` cannot be it (the same key sent in two batches is two
// rows and one record), and neither can a recount of the source: a source that
// is still being written to has moved on by the time it is counted again. A
// crawler holding tens of millions of keys cannot count them itself; the stage
// can, in one pass. Counted after markGoverned, which may change a key.
async function distinctKeyCount(client, stage) {
  const keys = stage.keyColumns.map(k => `"${k}"`).join(', ');
  const { rows } = await client.query(
    `SELECT count(*) AS n FROM (SELECT DISTINCT ${keys} FROM "${stage.stageTable}") d`);
  return Number(rows[0]?.n ?? 0);
}

async function liveCount(client, stage) {
  const tableColumnNames = new Set((await discoverColumns(null, stage.tableName)).map(c => c.name));
  return scopeLiveCount(client, stage.tableName, stage.systemId, stage.scope, 'systemId',
    tableColumnNames, stage.scopeDeleteFilter, stage.restrictSystemIds);
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

async function loadIntoEmptyTable(client, loaded, results, deleteMissing = false) {
  const tableName = loaded[0].tableName;
  const { rows: idx } = await client.query(
    `SELECT i.indexname, i.indexdef FROM pg_indexes i
      WHERE i.schemaname = 'public' AND i.tablename = $1
        AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname)`, [tableName]);
  for (const { indexname } of idx) await client.query(`DROP INDEX "${indexname}"`);
  // One transaction for every stage: flagged only if all their systems are on
  // their initial load (migration 073).
  await markInitialLoadForAll(client, loaded.map(st => st.systemId), tableName);
  for (const stage of loaded) {
    await markGoverned(client, stage);
    const d = distinctStageSql(stage);
    const { cols, selectCols } = withSystem(stage, d.cols, d.cols);
    const res = await client.query(
      `INSERT INTO "${tableName}" (${cols}) SELECT ${selectCols} FROM (${d.sql}) s`);
    // The insert IS one row per distinct key, so its count is the distinct count.
    const inserted = res.rowCount || 0;
    results.set(stage.id, { path: 'empty-table', inserted, updated: 0, deleted: 0, rows: stage.rows, distinct: inserted,
      // Into an empty table every distinct key was just inserted, so all of them are present.
      ...(deleteMissing ? {} : { present: inserted }) });
  }
  for (const { indexdef } of idx) await client.query(indexdef);
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

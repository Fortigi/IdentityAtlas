// Clean database — removes what a crawler or plugin can recreate, keeps what a
// person made. What goes and what stays is decided by tableClassification.js;
// this file only carries it out.
//
// Runs on ONE transaction client (db.tx): any statement that fails rolls the
// whole clean back, so it never half-applies.

import { TABLE_CLASSIFICATION, isRemovedLabel, classificationOf } from './tableClassification.js';

const HISTORY = '_history';

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

// A removed table without a row rule is emptied whole.
const isWholeTable = (e) => isRemovedLabel(e.label) && !e.removeWhere;

/** Tables the clean DELETEs from, in classification order (children first). */
export function removalSteps(classification = TABLE_CLASSIFICATION) {
  return classification.filter(e => e.table !== HISTORY && (isRemovedLabel(e.label) || e.removeWhere));
}

/** The DELETE for one step. */
export function deleteSql(entry) {
  return `DELETE FROM ${quoteIdent(entry.table)}${entry.removeWhere ? ` WHERE ${entry.removeWhere}` : ''}`;
}

/** Tables whose loss is measured by counting before and after (all but the whole-table removals). */
export function countedTables(classification = TABLE_CLASSIFICATION) {
  return classification.filter(e => e.table !== HISTORY && !isWholeTable(e)).map(e => e.table);
}

async function countRows(client, tables) {
  const sql = tables
    .map(t => `SELECT '${t.replace(/'/g, "''")}' AS t, count(*)::bigint AS n FROM ${quoteIdent(t)}`)
    .join(' UNION ALL ');
  const { rows } = await client.query(sql);
  return new Map(rows.map(r => [r.t, Number(r.n)]));
}

// A kept context whose parent is removed would be cascaded away with it
// (parentContextId is ON DELETE CASCADE). It moves to the top level instead.
export function reparentSql() {
  const removed = classificationOf('Contexts').removeWhere;
  return `UPDATE "Contexts" SET "parentContextId" = NULL
           WHERE NOT (${removed})
             AND "parentContextId" IN (SELECT id FROM "Contexts" WHERE ${removed})`;
}

// History: all of it for a table emptied whole; for the rest, the history of
// exactly the rows this clean deleted — the 'D' rows the audit trigger wrote
// since `mark`. Cascaded deletes are caught the same way.
async function removeHistory(client, wholeTables, mark) {
  const whole = await client.query(`DELETE FROM "${HISTORY}" WHERE "tableName" = ANY($1::text[])`, [wholeTables]);
  const rows = await client.query(
    `DELETE FROM "${HISTORY}" h
      USING (SELECT DISTINCT "tableName", "rowId" FROM "${HISTORY}" WHERE id > $1 AND operation = 'D') d
      WHERE h."tableName" = d."tableName" AND h."rowId" = d."rowId"`,
    [mark],
  );
  return (whole.rowCount || 0) + (rows.rowCount || 0);
}

// Restart each touched table's sequence after the highest id still there, so a
// re-crawl into an empty table starts at 1 again (the demo data relies on
// Systems starting at 1) while a kept uploaded list keeps its id.
async function resetSequences(client, tables) {
  const { rows } = await client.query(
    `SELECT t.relname AS tbl, a.attname AS col, s.oid::regclass::text AS seq
       FROM pg_class t
       JOIN pg_attribute a ON a.attrelid = t.oid
       JOIN pg_depend d ON d.refobjid = t.oid AND d.refobjsubid = a.attnum
       JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
      WHERE t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        AND t.relname = ANY($1::text[])`,
    [tables],
  );
  for (const r of rows) {
    await client.query(
      `SELECT setval($1::regclass, COALESCE((SELECT max(${quoteIdent(r.col)}) FROM ${quoteIdent(r.tbl)}), 0) + 1, false)`,
      [r.seq],
    );
  }
}

/**
 * Carry out the clean on a transaction client.
 * @returns {Promise<{ wiped: Array<{table, rowsAffected}>, alsoRemoved: Array<{table, rowsAffected}>, historyRowsRemoved: number }>}
 */
export async function cleanDatabase(client) {
  const steps = removalSteps();
  const counted = countedTables();
  const mark = Number((await client.query(`SELECT COALESCE(max(id), 0) AS m FROM "${HISTORY}"`)).rows[0]?.m ?? 0);
  const before = await countRows(client, counted);

  await client.query(reparentSql());
  const deleted = new Map();
  for (const step of steps) {
    const r = await client.query(deleteSql(step));
    deleted.set(step.table, r.rowCount || 0);
  }

  const wholeTables = steps.filter(isWholeTable).map(e => e.table);
  const historyRowsRemoved = await removeHistory(client, wholeTables, mark);

  // Crawl state in WorkerConfig: advance syncVersion so the effective-access
  // cache cannot serve removed data (lib/syncVersion.js).
  await client.query(
    `UPDATE "WorkerConfig" SET "configValue" = ("configValue"::bigint + 1)::text, "updatedAt" = now() AT TIME ZONE 'utc'
      WHERE "configKey" = 'syncVersion' AND "configValue" ~ '^[0-9]+$'`,
  );
  await client.query(`UPDATE "CrawlerConfigs" SET "lastRunAt" = NULL, "lastRunStatus" = NULL`);

  await resetSequences(client, steps.map(e => e.table));

  const after = await countRows(client, counted);
  const wiped = [];
  const alsoRemoved = [];
  for (const e of TABLE_CLASSIFICATION) {
    if (e.table === HISTORY) continue;
    const gone = before.has(e.table) ? before.get(e.table) - after.get(e.table) : deleted.get(e.table);
    if (isRemovedLabel(e.label) || e.removeWhere) wiped.push({ table: e.table, rowsAffected: gone });
    else if (gone > 0) alsoRemoved.push({ table: e.table, rowsAffected: gone });
  }
  return { wiped, alsoRemoved, historyRowsRemoved, touched: steps.map(e => e.table) };
}

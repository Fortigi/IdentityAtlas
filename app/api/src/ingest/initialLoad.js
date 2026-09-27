// A system's initial load writes no per-row "created" history (migration 073).
//
// A system is on its initial load until one of its syncs has completed, which is
// when refresh-views stamps Systems."lastSyncDateTime". For such a system, the
// ingest transaction sets identity_atlas.initial_load = 'on' — SET LOCAL, so it
// ends with the transaction — and the history INSERT trigger skips its rows.
// Updates and deletes are still recorded, and every sync after the first records
// its inserts as before.
//
// Instead, the load is recorded ONCE per (table, system): an anchor event (see
// anchorSql). For imported data a per-row creation event was never true — a
// principal that has existed in the source for nine years was not created on the
// day it was imported. What is true is "this system's rows arrived at T", and one
// event states exactly that. It is also what keeps the matrix scope timeline's
// historyStart at the load time (matrix/scopeHistory.js): with no per-row insert
// events, the anchor is the first event of the table.
//
// Why skip the rows at all: at 41M assignments, the initial load's history was
// 25.7 of 34.9 GB and cost more insert time than all of ResourceAssignments'
// indexes together (docs/architecture/scale-rehearsal.md).

const INITIAL_LOAD_SQL = `SELECT "lastSyncDateTime" IS NULL AS "initialLoad" FROM "Systems" WHERE "id" = $1`;

// The anchor's rowId. No entity has it, so entity timelines — which all select
// _history by an entity's id — never show it, and the as-of reconstruction in
// scopeHistory.js ignores it (an INSERT has no prevData, and no live row has
// this key).
export function initialLoadRowId(systemId) {
  return `initial-load:${systemId}`;
}

// One anchor per (table, system): written by the first batch of the load, a
// no-op for every later one. A plain INSERT, so it is not subject to the flag.
const ANCHOR_SQL = `
  INSERT INTO "_history" ("tableName", "rowId", "operation", "rowData", "prevData")
  SELECT $1, $2, 'I', jsonb_build_object('initialLoad', true, 'systemId', $3::int), NULL
   WHERE NOT EXISTS (SELECT 1 FROM "_history" WHERE "tableName" = $1 AND "rowId" = $2)`;

// Returns true when the flag was set for this transaction.
export async function markInitialLoad(client, systemId, tableName) {
  if (systemId === null || systemId === undefined) return false;
  const { rows } = await client.query(INITIAL_LOAD_SQL, [systemId]);
  if (!rows[0]?.initialLoad) return false;
  if (tableName) await client.query(ANCHOR_SQL, [tableName, initialLoadRowId(systemId), systemId]);
  await client.query(`SET LOCAL identity_atlas.initial_load = 'on'`);
  return true;
}

// The same for several systems loaded in ONE transaction (the staged finalize's
// empty-table path inserts every stage of a table together). SET LOCAL covers
// the whole transaction, so the flag is set only when every one of the systems
// is on its initial load; one that has already synced keeps its inserts recorded,
// and then so does the rest of the group. Anchors are written for each system.
export async function markInitialLoadForAll(client, systemIds, tableName) {
  const ids = [...new Set(systemIds)];
  if (ids.length === 0 || ids.some(id => id === null || id === undefined)) return false;
  const { rows } = await client.query(
    `SELECT count(*) FILTER (WHERE "lastSyncDateTime" IS NULL)::int AS "initial" FROM "Systems" WHERE "id" = ANY($1::int[])`,
    [ids]);
  if (rows[0]?.initial !== ids.length) return false;
  for (const id of ids) await client.query(ANCHOR_SQL, [tableName, initialLoadRowId(id), id]);
  await client.query(`SET LOCAL identity_atlas.initial_load = 'on'`);
  return true;
}

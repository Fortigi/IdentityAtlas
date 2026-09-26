// A system's initial load writes no per-row "created" history (migration 073).
//
// A system is on its initial load until one of its syncs has completed, which is
// when refresh-views stamps Systems."lastSyncDateTime". For such a system, the
// ingest transaction sets identity_atlas.initial_load = 'on' — SET LOCAL, so it
// ends with the transaction — and the history INSERT trigger skips its rows.
// Updates and deletes are still recorded, and every sync after the first records
// its inserts as before.
//
// Why: at 41M assignments, the initial load's history was 25.7 of 34.9 GB and cost
// more insert time than all of ResourceAssignments' indexes together
// (docs/architecture/scale-rehearsal.md).

const INITIAL_LOAD_SQL = `SELECT "lastSyncDateTime" IS NULL AS "initialLoad" FROM "Systems" WHERE "id" = $1`;

// Returns true when the flag was set for this transaction.
export async function markInitialLoad(client, systemId) {
  if (systemId === null || systemId === undefined) return false;
  const { rows } = await client.query(INITIAL_LOAD_SQL, [systemId]);
  if (!rows[0]?.initialLoad) return false;
  await client.query(`SET LOCAL identity_atlas.initial_load = 'on'`);
  return true;
}

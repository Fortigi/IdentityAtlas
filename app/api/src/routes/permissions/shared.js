// Shared runtime config for the permission endpoints: the USE_SQL flag and the
// lazily-imported db connection module.
//
// Extracted from routes/permissions.js as part of splitting that fat controller
// (audit finding C1) so every split sub-router shares one binding. No behaviour
// change — pure code move.

export const useSql = process.env.USE_SQL === 'true';

// Only pull in the pg connection module when running against a real database;
// the mock-data path (useSql=false) must not require it.
export let db = null;
if (useSql) {
  db = await import('../../db/connection.js');
}

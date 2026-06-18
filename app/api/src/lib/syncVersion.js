// WorkerConfig('syncVersion') — a monotonic counter bumped once per completed sync.
//
// The effective-access engine keys its cache on this value, so all cache entries are
// invalidated atomically when a sync finishes (stale entries simply miss — never serve wrong
// data). It is deliberately a SEPARATE counter from MAX(GraphSyncLog.id): the sync-log id
// advances when a sync BEGINS, which would let requests cache partially-synced data for the
// duration of the sync. This counter is advanced by the API only at end-of-sync (the
// /ingest/refresh-views handler the crawler calls after all ingest writes are durable), never
// by a crawler directly — crawlers have no DB connection. See spec §13.2 / §15.2.

import * as db from '../db/connection.js';

const KEY = 'syncVersion';

/**
 * Current sync version. Returns 0 when no sync has completed yet (fresh install) — which makes
 * the engine run uncached until the first sync finishes, the correct behavior.
 * @returns {Promise<number>}
 */
export async function getSyncVersion() {
  const row = await db.queryOne(
    `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
    [KEY],
  );
  const n = row ? Number.parseInt(row.configValue, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Atomically increment the sync version (creating the row at 1 on first call). Returns the new
 * value. Called by the API at end-of-sync.
 * @returns {Promise<number>}
 */
export async function bumpSyncVersion() {
  const row = await db.queryOne(
    `INSERT INTO "WorkerConfig" ("configKey", "configValue", "updatedAt")
     VALUES ($1, '1', now() AT TIME ZONE 'utc')
     ON CONFLICT ("configKey") DO UPDATE
       SET "configValue" = (("WorkerConfig"."configValue")::bigint + 1)::text,
           "updatedAt"   = now() AT TIME ZONE 'utc'
     RETURNING "configValue"`,
    [KEY],
  );
  const n = row ? Number.parseInt(row.configValue, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

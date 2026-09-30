// One crawler configuration runs at most one job at a time.
//
// Two runs of the same configuration read the same source into the same systems:
// they double the load, each one's verification counts rows the other is still
// writing, and on the customer laptop a second run ended the first with HTTP 409.
// It happened twice in two days — a scheduled delta queued beside a full load
// that was still going, because the scheduler only looked back 55 minutes and
// the worker claimed whatever was queued.
//
// The rule lives here once and is asked in three places:
//   - Run Now refuses (routes/jobs/helpers.js → checkConfigConflict, HTTP 409);
//   - the scheduler skips the occurrence (scheduler.js → fireScheduleIfDue);
//   - the worker claim never starts one beside another (CLAIM_NEXT_JOB_SQL) —
//     the guarantee for jobs already queued, whichever path queued them.
//
// A job with no configId (an inline config) belongs to no configuration and is
// never held back. After a restart bootstrap marks every running or queued job
// failed, so a job killed by a reboot cannot block its configuration forever.

// The job, queued or running, that stands in the way of another run of this
// configuration — or null. `query` is anything with a pg-style
// query(sql, params) → { rows }.
export async function findActiveConfigJob(query, configId) {
  if (configId === undefined || configId === null) return null;
  const r = await query(
    `SELECT id, status FROM "CrawlerJobs"
      WHERE "configId" = $1 AND status IN ('queued', 'running')
      ORDER BY id LIMIT 1`,
    [configId]
  );
  return r.rows[0] || null;
}

// Atomic claim of the oldest queued job whose configuration has nothing running.
// FOR UPDATE SKIP LOCKED lets several workers contend without double pickup.
export const CLAIM_NEXT_JOB_SQL = `
      WITH next_job AS (
        SELECT id FROM "CrawlerJobs" q
         WHERE q."status" = 'queued'
           AND (q."configId" IS NULL OR NOT EXISTS (
                 SELECT 1 FROM "CrawlerJobs" r
                  WHERE r."configId" = q."configId" AND r."status" = 'running'))
         ORDER BY q."createdAt" ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      UPDATE "CrawlerJobs" cj
         SET "status" = 'running', "startedAt" = (now() AT TIME ZONE 'utc')
        FROM next_job
       WHERE cj.id = next_job.id
       RETURNING cj.id, cj."jobType", cj."config", cj."configId"
    `;

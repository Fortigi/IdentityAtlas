// Queue a risk-scoring run only when none is already in flight
// (SEC-2026-09 L-11).
//
// Every run scores the whole tenant in the background; starting one per click
// let a user stack up unbounded concurrent full scorings. The check and the
// insert are one statement, so two simultaneous requests can't both see "idle".
//
// A run whose process died leaves its row 'pending'/'running' forever, so rows
// older than STALE_RUN_MINUTES no longer block a new run.

export const STALE_RUN_MINUTES = 6 * 60;

// Returns the inserted ScoringRuns row, or null when a run is already active.
export async function insertScoringRunIfIdle(db, classifierId, triggeredBy) {
  return db.queryOne(
    `INSERT INTO "ScoringRuns" ("classifierId", status, step, pct, "triggeredBy")
     SELECT $1::bigint, 'pending', 'Queued', 0, $2::text
      WHERE NOT EXISTS (
        SELECT 1 FROM "ScoringRuns"
         WHERE status IN ('pending', 'running')
           AND "startedAt" > now() - ($3::int * interval '1 minute')
      )
     RETURNING *`,
    [classifierId, triggeredBy, STALE_RUN_MINUTES]
  );
}

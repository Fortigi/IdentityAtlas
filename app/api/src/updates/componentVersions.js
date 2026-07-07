// Component version tracking for skew detection (Admin → Updates).
//
// The web version is always known live (getCurrentVersion). The worker has no
// DB access, so it reports its version on its regular job-claim poll and the API
// upserts it here. The Updates screen reads this to show web + worker side by
// side and warn when they drift out of step (a partial/interrupted update).
//
// `client` is injectable so unit/contract tests can pass a test pool.

import * as db from '../db/connection.js';

// How long since the worker last checked in before we treat it as stale. The
// worker polls the claim endpoint every ~30s, but there is a startup gap while
// it discovers its API key (up to ~5 min on a cold boot), so keep this well
// above the poll interval to avoid false "worker unseen" flags.
export const WORKER_STALE_MS = 10 * 60 * 1000;

// Upsert the last-seen version for a component. Best-effort: the caller invokes
// this fire-and-forget on a hot path (every worker poll), so it must not throw
// into the request.
export async function recordComponentVersion(component, version, client = db) {
  if (!component || !version) return;
  await client.query(
    `INSERT INTO "ComponentVersions" ("component", "version", "lastSeenAt")
       VALUES ($1, $2, now() AT TIME ZONE 'utc')
     ON CONFLICT ("component") DO UPDATE
       SET "version" = EXCLUDED."version",
           "lastSeenAt" = EXCLUDED."lastSeenAt"`,
    [component, version]
  );
}

// Read the last-seen row for a component, or null if it has never reported.
// Uses `.query` (not the db module's `.queryOne`) so it works against any
// pg-compatible client — the shared pool, or a raw pool in contract tests.
export async function getComponentVersion(component, client = db) {
  const r = await client.query(
    `SELECT "component", "version", "lastSeenAt"
       FROM "ComponentVersions"
      WHERE "component" = $1`,
    [component]
  );
  return r.rows[0] || null;
}

// Given the running web version and the worker's last-seen row, compute the
// skew signals the UI renders. Pure so it is trivially unit-testable.
//   - mismatch:    worker reported a version and it differs from web
//   - workerStale: worker reported but hasn't checked in within WORKER_STALE_MS
//   - workerKnown: the worker has ever reported (else "unknown", not a mismatch)
export function computeSkew(webVersion, workerRow, now = Date.now()) {
  const workerVersion = workerRow?.version || null;
  const lastSeenAt = workerRow?.lastSeenAt || null;
  const workerKnown = !!workerVersion;
  const workerStale =
    workerKnown && lastSeenAt ? now - new Date(lastSeenAt).getTime() > WORKER_STALE_MS : false;
  const mismatch = !!(workerKnown && webVersion && workerVersion !== webVersion);
  return { mismatch, workerStale, workerKnown };
}

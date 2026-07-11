// Component version tracking for skew detection (Admin → Updates).
//
// The web version is always known live (getCurrentVersion). The worker has no
// DB access, so it reports its version on its regular job-claim poll and the API
// upserts it here. The Updates screen reads this to show web + worker side by
// side and warn when they drift out of step (a partial/interrupted update).
//
// `client` is injectable so unit/contract tests can pass a test pool.

import * as db from '../db/connection.js';
import { getMigrationStatus } from '../db/migrate.js';
import { getCurrentVersion } from './channel.js';
import { isNewer } from './versionCompare.js';

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

// Pure guard for stamping the DB's schema version. Stamp only when it stays
// trustworthy:
//   - a known running version;
//   - every shipped migration applied and none pending (the migrations that were
//     needed have actually run — this is the check the caller asked for);
//   - the DB is not structurally AHEAD of this code (no applied migrations this
//     image doesn't ship) — that's a rollback, so keep the higher stamp and let
//     the UI show the mismatch rather than silently downgrading;
//   - never downgrade over a newer existing stamp.
export function shouldStampSchemaVersion(version, status, existing) {
  if (!version || !status) return false;
  if (status.pending || status.ahead) return false;
  if (existing?.version && isNewer(existing.version, version)) return false;
  return true;
}

// Stamp the running app version onto the DB as its "schema version" — the version
// that last successfully migrated it. Called once after migrations complete
// (before the port binds). Idempotent: re-stamping the same version just refreshes
// the row. Migrations themselves are guarded against double-running by the
// per-file `_migrations` table in the runner, independent of this stamp.
export async function stampSchemaVersion(version = getCurrentVersion(), client = db) {
  const [status, existing] = await Promise.all([
    getMigrationStatus(client),
    getComponentVersion('database', client),
  ]);
  if (!shouldStampSchemaVersion(version, status, existing)) return null;
  await recordComponentVersion('database', version, client);
  return version;
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

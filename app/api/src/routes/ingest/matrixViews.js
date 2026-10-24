// Matrix materialized-view refresh + default-filter seed endpoints —
// /api/ingest/refresh-views and /api/ingest/matrix-default-filter — plus the
// refreshKeyword / refreshMatrixViews helpers (refreshMatrixViews is also called
// by bootstrap.js).
//
// Extracted verbatim from routes/ingest.js (audit finding C1). Mounted by
// routes/ingest.js via router.use() so the public paths are unchanged; the two
// helpers are re-exported by routes/ingest.js. No behaviour change.

import { Router } from 'express';
import * as db from '../../db/connection.js';
import { crawlerHasPermission } from '../../middleware/crawlerAuth.js';
import { bumpSyncVersion } from '../../lib/syncVersion.js';
import { breakCycles } from '../../contexts/cycleGuard.js';
import { createViewRefreshCoordinator, matrixRefreshDebounceMs } from '../../ingest/viewRefresh.js';
import { refreshContextAssignmentCounts } from '../../contexts/assignmentCounts.js';

const router = Router();

const MATRIX_VIEWS = [
  '"vw_ResourceUserPermissionAssignments"',
  '"vw_UserPermissionAssignmentViaBusinessRole"',
];
const MATRIX_VIEW_NAMES = MATRIX_VIEWS.map(v => v.replace(/"/g, ''));
const useSql = process.env.USE_SQL === 'true';

// Why a built matrix view would have rows: the cheap base-table question the
// view answers the long way. A view that is populated AND empty while its probe
// returns a row is in a state that cannot be right.
//
// That state is reachable and was reached: a matview refreshed once against an
// empty database is `ispopulated`, and `ispopulated` was the only thing startup
// looked at, so nothing ever rebuilt it. A customer's install carried 42.6
// million assignments behind two 40 kB views for as long as it took someone to
// refresh them by hand.
//
// Each probe is a NECESSARY condition for its view to have rows, chosen to stop
// at the first row rather than to be exact: the view's own top-level GROUP BY
// means "run the view with LIMIT 1" is not cheap at scale. Over-claiming
// therefore costs a rebuild, which is why the cooldown below exists.
const MATRIX_VIEW_PROBES = {
  // The matrix view is a projection of live assignments carrying a subject.
  vw_ResourceUserPermissionAssignments: `
    SELECT 1 FROM "ResourceAssignments"
     WHERE "deletedAt" IS NULL
       AND ("principalId" IS NOT NULL OR "identityId" IS NOT NULL)
     LIMIT 1`,
  // Governance only. An install with no business roles has this view empty and
  // CORRECT — the common case — and the probe must agree, or every such install
  // would rebuild on a timer. So it asks for a governance resource that actually
  // contains something and is actually held by somebody.
  vw_UserPermissionAssignmentViaBusinessRole: `
    SELECT 1
      FROM "ResourceRelationships" rr
      JOIN "Resources" gov ON gov.id = rr."parentResourceId" AND gov."governanceResource"
      JOIN "ResourceAssignments" bru ON bru."resourceId" = rr."parentResourceId"
                                    AND bru."principalId" IS NOT NULL
                                    AND bru."deletedAt" IS NULL
     WHERE rr."relationshipType" = 'Contains'
     LIMIT 1`,
};

// A probe-driven rebuild is expensive: measured at 42.6M assignments, rebuilding
// both views plus ANALYZE is 3m17s and 7.6 GB of result. A probe that
// over-claims must not be able to spend that on every container restart, so a
// rebuild the probe asked for claims this key and no other one runs until the
// window has passed. A view that was NEVER built bypasses it — that one has to
// happen, and it only ever happens once.
const AUTO_REBUILD_KEY = 'matrixViews.lastProbeRebuildAt';
export const AUTO_REBUILD_COOLDOWN = '6 hours';

function canRefresh(req) {
  return crawlerHasPermission(req, 'refreshViews') || crawlerHasPermission(req, 'admin');
}

// Ask for the post-ingest refresh. Returns at once (202); the refresh runs in the
// background — see ingest/viewRefresh.js for why it no longer runs in the request.
//
// ?wait=1 is for scripts that need fresh views before their next step (CI checks,
// the demo loader, the load benchmark): the request still goes through the same
// coordinator — coalesced, one at a time — and then waits for it to finish,
// answering 200, or 500 with the error when the refresh failed. Crawlers do not
// pass it; the worker waits for them at the end of the job instead.
router.post('/ingest/refresh-views', async (req, res) => {
  if (!canRefresh(req)) {
    return res.status(403).json({ error: 'Insufficient permissions (requires refreshViews)' });
  }
  if (!useSql) {
    return res.json({ message: 'SQL disabled — nothing to refresh' });
  }
  const refresh = viewRefresh.schedule(req.crawler?.displayName || 'refresh-views');
  if (!['1', 'true'].includes(String(req.query.wait))) {
    return res.status(202).json({ message: 'Matrix view refresh scheduled', refresh });
  }
  const done = await viewRefresh.whenIdle();
  if (done.last && !done.last.ok) {
    return res.status(500).json({ error: `refresh-views failed: ${done.last.error}`, refresh: done });
  }
  return res.json({ message: 'Materialized views refreshed', refresh: done });
});

// The state of the background refresh and the outcome of the last one. The worker
// polls this at the end of a job so the job reports what really happened.
router.get('/ingest/refresh-views', (req, res) => {
  if (!canRefresh(req)) {
    return res.status(403).json({ error: 'Insufficient permissions (requires refreshViews)' });
  }
  res.json(viewRefresh.status());
});

// Everything that follows an ingest: rebuild the matrix views, then the cheap
// bookkeeping that depends on them. A failure of the view refresh fails the run;
// the bookkeeping steps stay best-effort, as before.
export async function refreshAfterIngest() {
  await refreshMatrixViews();

  // Mark every system that has synced data with the current timestamp so the
  // Systems page shows "Last sync: <date>" instead of "Never".
  try {
    await db.query(`
      UPDATE "Systems" s
         SET "lastSyncDateTime" = now() AT TIME ZONE 'utc'
       WHERE s.id IN (
         SELECT DISTINCT "systemId" FROM "Resources"  WHERE "systemId" IS NOT NULL
         UNION
         SELECT DISTINCT "systemId" FROM "Principals" WHERE "systemId" IS NOT NULL
       )
    `);
  } catch (tsErr) {
    console.warn('lastSyncDateTime update failed (non-fatal):', tsErr.message);
  }

  // Defensive: migration 059's trigger prevents new cycles, but breakCycles
  // here still cleans any cycle that predates the trigger (or arrived via a
  // trigger-disabled path) so the CYCLE-guarded roll-up below computes a
  // complete totalMemberCount for every subtree. A no-op on a trigger-protected
  // tree (#627).
  try {
    const broken = await breakCycles(db);
    if (broken) console.warn(`Context cycle guard: broke ${broken} cyclic parentContextId link(s) after ingest`);
  } catch (cycErr) {
    console.warn('Context cycle repair failed (non-fatal):', cycErr.message);
  }

  // Recalculate directMemberCount and totalMemberCount on all Contexts
  // that have ContextMembers. The ingest engine doesn't trigger the
  // per-context recalc helper (that's for manual analyst writes), so we
  // do a bulk UPDATE here instead.
  try {
    const pool = await db.getPool();
    await pool.query(`
      UPDATE "Contexts" c
         SET "directMemberCount" = (
               SELECT COUNT(*)::int FROM "ContextMembers" WHERE "contextId" = c.id
             ),
             "lastCalculatedAt"  = now() AT TIME ZONE 'utc';

      WITH RECURSIVE subtree AS (
        SELECT id AS root_id, id AS node_id FROM "Contexts"
        UNION ALL
        SELECT s.root_id, c.id
          FROM "Contexts" c JOIN subtree s ON c."parentContextId" = s.node_id
      )
      -- CYCLE guard: this seeds from every context and runs on each sync,
      -- so a single corrupt parent chain would otherwise hang ingest.
      CYCLE node_id SET "isCycle" USING "cyclePath",
      totals AS (
        SELECT s.root_id, COUNT(DISTINCT cm."memberId")::int AS cnt
          FROM subtree s
          LEFT JOIN "ContextMembers" cm ON cm."contextId" = s.node_id
         GROUP BY s.root_id
      )
      UPDATE "Contexts" c
         SET "totalMemberCount" = t.cnt
        FROM totals t
       WHERE c.id = t.root_id;
    `);
  } catch (countErr) {
    console.warn('Context member count refresh failed (non-fatal):', countErr.message);
  }

  // How much access hangs off each context that groups resources. Minutes, not
  // seconds, on a very large tenant — which is exactly why it is done here, once
  // per sync, instead of when somebody opens a report.
  try {
    const { updated, durationMs } = await refreshContextAssignmentCounts();
    console.log(`Context assignment counts: ${updated} context(s) changed in ${Math.round(durationMs / 1000)}s`);
  } catch (acErr) {
    console.warn('Context assignment count refresh failed (non-fatal):', acErr.message);
  }

  // Advance the effective-access cache version. The crawler calls this endpoint only
  // after all ingest writes are durable, so bumping here invalidates engine cache entries
  // exactly once per completed sync — never mid-sync. Non-fatal: a failed bump just means
  // the cache serves slightly stale data until the next sync. See spec §13.2.
  try {
    await bumpSyncVersion();
  } catch (svErr) {
    console.warn('syncVersion bump failed (non-fatal):', svErr.message);
  }
}

// Shared helper used by /ingest/refresh-views, the classify endpoint, and
// bootstrap's initial refresh. CONCURRENTLY falls back to a plain REFRESH
// on the very first run (CONCURRENTLY requires the matview to already have
// data, which it doesn't on first boot). After refreshing we ANALYZE both
// matviews and the big base tables so the planner has accurate row counts
// (dashboard-stats uses pg_class.reltuples for its fast-path counts and
// that field is only updated by ANALYZE).
// Pure helper — determines whether CONCURRENTLY can be used for a given view.
// Exported for unit testing.
//
// A populated but EMPTY view counts as unpopulated here. CONCURRENTLY builds the
// new contents into a temp table and then DIFFS it against the old one; filling
// an empty view that way is the worst case the diff has — every row of a 7.6 GB
// result is an insert found by a full outer join — while a plain REFRESH swaps
// the heap in one pass. The trade CONCURRENTLY buys (readers keep the old
// contents during the refresh) is worth nothing when the old contents are
// nothing, so the case that needs the rebuild most gets the fast path.
export function refreshKeyword(viewName, populatedSet, isDesktop, emptySet = new Set()) {
  return !isDesktop && populatedSet.has(viewName) && !emptySet.has(viewName) ? 'CONCURRENTLY' : '';
}

// Crawler-triggered refreshes all go through this one coordinator: debounced,
// one at a time, callers that arrive mid-refresh share one follow-up, and
// back-to-back refreshes are spaced out (SEC-2026-09 M-05).
// MATRIX_REFRESH_MIN_INTERVAL_MS overrides the spacing (tests set it to 0).
export function matrixRefreshMinIntervalMs(env = process.env) {
  const n = Number.parseInt(env.MATRIX_REFRESH_MIN_INTERVAL_MS ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 5000;
}
export const viewRefresh = createViewRefreshCoordinator(() => refreshAfterIngest(), {
  debounceMs: matrixRefreshDebounceMs(),
  minIntervalMs: matrixRefreshMinIntervalMs(),
});

// What each matrix matview is right now: built or not, and — when built —
// whether it holds any row at all. Both are cheap: pg_matviews is a catalog
// read and the emptiness question is a one-row scan that stops immediately.
export async function readMatrixViewStates() {
  const { rows } = await db.query(
    `SELECT matviewname, ispopulated FROM pg_matviews WHERE matviewname = ANY($1)`,
    [MATRIX_VIEW_NAMES],
  );
  const states = [];
  for (const r of rows) {
    // The identifier is not user input: pg_matviews was filtered against our own
    // literal list, so matviewname can only be one of those two strings.
    const probe = r.ispopulated ? await db.query(`SELECT 1 FROM "${r.matviewname}" LIMIT 1`) : null;
    states.push({ name: r.matviewname, populated: r.ispopulated === true, empty: probe ? probe.rows.length === 0 : true });
  }
  return states;
}

// Every matrix view that needs rebuilding, and why. `neverBuilt` separates the
// first-boot case (must always run) from the probe-driven one (cooled down).
export async function findStaleMatrixViews() {
  const stale = [];
  for (const s of await readMatrixViewStates()) {
    if (!s.populated) {
      stale.push({ view: s.name, neverBuilt: true, reason: 'never built' });
      continue;
    }
    if (!s.empty) continue;
    const probe = MATRIX_VIEW_PROBES[s.name];
    if (!probe) continue;
    const { rows } = await db.query(probe);
    if (rows.length > 0) {
      stale.push({ view: s.name, neverBuilt: false, reason: 'populated but empty while the rows it is built from exist' });
    }
  }
  return stale;
}

// Claim the probe-driven rebuild, atomically: the row is written only when there
// is none or the last one is older than the cooldown, so two web containers
// starting together do not both spend three minutes on the same rebuild.
// Returns false when the claim was refused. A failure to reach WorkerConfig is
// not a reason to skip a rebuild the probe asked for.
export async function claimProbeRebuild() {
  try {
    const row = await db.queryOne(
      `INSERT INTO "WorkerConfig" ("configKey", "configValue", "updatedAt")
       VALUES ($1, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SSZ'), now() AT TIME ZONE 'utc')
       ON CONFLICT ("configKey") DO UPDATE
          SET "configValue" = EXCLUDED."configValue",
              "updatedAt"   = EXCLUDED."updatedAt"
        WHERE "WorkerConfig"."updatedAt" < (now() AT TIME ZONE 'utc') - $2::interval
       RETURNING "configKey"`,
      [AUTO_REBUILD_KEY, AUTO_REBUILD_COOLDOWN],
    );
    return row !== null && row !== undefined;
  } catch (err) {
    console.warn(`Matrix-view rebuild cooldown unavailable (${err.message}) — rebuilding anyway`);
    return true;
  }
}

// Startup: rebuild a matrix view that is unusable, and only then.
//
// Two ways a view is unusable. It was never populated (first boot, after the
// migrations create them WITH NO DATA), or it is populated and EMPTY while the
// rows it is built from are there — the state `ispopulated` alone cannot see,
// and the one that left a customer's person-detail page showing no entitlements
// at all behind 42.6 million perfectly loaded assignments.
//
// A view that is populated and non-empty is still left alone: refreshing it is
// not cheap — 3m17s and 7.6 GB at that size — and it used to run on every
// restart, including the restart after a crash.
//
// The rebuild is NOT awaited. index.js already binds the port before bootstrap
// runs, and this keeps it true from this end too: a three-minute rebuild here
// must never be able to sit in front of a platform's startup probe, which is how
// this product crash-looped a deployment once already. Pass { wait: true } to
// await it (tests, and desktop, where the data is small and the caller is the
// one that wants it ready).
export async function ensureMatrixViewsPopulated({ wait = false } = {}) {
  if (process.env.DESKTOP_MODE === 'true') {
    await refreshMatrixViews();
    return 'refreshed';
  }
  const stale = await findStaleMatrixViews();
  if (stale.length === 0) return 'already-populated';
  const detail = stale.map(s => `${s.view} (${s.reason})`).join(', ');
  if (!stale.some(s => s.neverBuilt) && !(await claimProbeRebuild())) {
    console.warn(`Matrix views need rebuilding but one was already rebuilt within ${AUTO_REBUILD_COOLDOWN}: ${detail}`);
    return `stale, rebuild on cooldown: ${detail}`;
  }
  console.warn(`Rebuilding matrix views: ${detail}`);
  const run = refreshMatrixViews().then(
    () => console.log(`Matrix view rebuild finished: ${detail}`),
    (err) => console.error(`Matrix view rebuild failed: ${err.message}`),
  );
  if (wait) await run;
  return stale.some(s => s.neverBuilt) ? 'populating' : 'rebuilding';
}


export async function refreshMatrixViews() {
  const views = MATRIX_VIEWS;
  // PGlite (DESKTOP_MODE) runs in a single WASM process with no background
  // worker, so CONCURRENTLY is not supported. Always use plain REFRESH there.
  const isDesktop = process.env.DESKTOP_MODE === 'true';
  let populatedSet = new Set();
  let emptySet = new Set();
  if (!isDesktop) {
    // Which matviews are already populated, and which of those hold nothing, so
    // we can choose CONCURRENTLY vs plain REFRESH without letting PostgreSQL log
    // an ERROR on first boot — and without asking CONCURRENTLY to diff a full
    // rebuild against an empty view. See refreshKeyword.
    const states = await readMatrixViewStates();
    populatedSet = new Set(states.filter(s => s.populated).map(s => s.name));
    emptySet = new Set(states.filter(s => s.empty).map(s => s.name));
  }
  for (const v of views) {
    const concurrently = refreshKeyword(v.replace(/"/g, ''), populatedSet, isDesktop, emptySet);
    await db.query(`REFRESH MATERIALIZED VIEW ${concurrently} ${v}`);
  }
  // Refresh planner statistics on the matviews and the big base tables.
  // Cheap (milliseconds) and gives dashboard-stats fast reltuples-based
  // counts that stay close to reality.
  const tables = [
    '"vw_ResourceUserPermissionAssignments"',
    '"vw_UserPermissionAssignmentViaBusinessRole"',
    '"ResourceAssignments"',
    '"Resources"',
    '"Principals"',
    '"ResourceRelationships"',
    '"Contexts"',
    '"Identities"',
    '"IdentityMembers"',
    '"Systems"',
    '"CertificationDecisions"',
    '"GraphSyncLog"',
    '"RiskScores"',
  ];
  for (const t of tables) {
    try { await db.query(`ANALYZE ${t}`); } catch { /* best effort */ }
  }
}

// ─── Seed default matrix filter ─────────────────────────────────────────────
// Creates or replaces the org-wide default matrix filter (isDefault = true).
// Called by Ingest-DemoDataset.ps1 to pre-configure the Matrix tab so new
// installs with demo data don't require the wizard on first visit.

// Worker-class keys only: this replaces the org-wide default filter and can
// overwrite an analyst's saved filter of the same name (SEC-2026-09 M-05). The
// only caller is the demo dataset loader, run by the built-in worker.
router.post('/ingest/matrix-default-filter', async (req, res) => {
  if (!crawlerHasPermission(req, 'admin')) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  if (!useSql) return res.status(503).json({ error: 'SQL not configured' });
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : 'Default';
  const description = typeof body.description === 'string' ? body.description.slice(0, 1000) : null;
  if (!body.filter || typeof body.filter !== 'object') {
    return res.status(400).json({ error: 'filter is required' });
  }
  try {
    const p = await db.getPool();
    // The SavedMatrixFilters table, its indexes, and the isDefault column are
    // owned by migrations 023/028 — no runtime DDL here (schema via migrations).
    await p.query(`UPDATE "SavedMatrixFilters" SET "isDefault" = false WHERE "isDefault" = true`);
    await p.query(
      `INSERT INTO "SavedMatrixFilters" (id, "name", "description", "filter", "isDefault", "createdBy", "updatedBy")
       VALUES (gen_random_uuid(), $1, $2, $3, true, 'seed', 'seed')
       ON CONFLICT (LOWER("name")) DO UPDATE
         SET "filter"      = EXCLUDED."filter",
             "description" = EXCLUDED."description",
             "isDefault"   = true,
             "updatedBy"   = 'seed',
             "updatedAt"   = (now() AT TIME ZONE 'utc')`,
      [name, description, body.filter],
    );
    const row = await db.queryOne(`SELECT * FROM "SavedMatrixFilters" WHERE "isDefault" = true LIMIT 1`);
    res.status(201).json(row);
  } catch (err) {
    console.error('POST ingest/matrix-default-filter failed:', err.message);
    res.status(500).json({ error: 'Failed to seed default filter' });
  }
});


export default router;

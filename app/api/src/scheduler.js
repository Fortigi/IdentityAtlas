// Crawler schedule runner.
//
// Reads schedules from CrawlerConfigs.config.schedules (written by the wizard)
// and queues a job whenever the current wall-clock time matches a schedule's
// (hour, minute) that hasn't already fired in this minute.
//
// Schedule shape (from the UI):
//   { enabled: true, frequency: 'daily'|'hourly'|'weekly',
//     hour: 0-23, minute: 0-59, day?: 0-6 }
//
// Matching rules:
//   - hourly: fires when `now.minute === schedule.minute` (ignores hour)
//   - daily:  fires when minute + hour match
//   - weekly: fires when minute + hour + day-of-week match
//
// Double-fire protection: the runner tracks the last fired (configId, scheduleIndex,
// matched minute) in memory. On container restart the in-memory cache resets, but
// a second safety net checks CrawlerJobs for any job from the same config in the
// last 55 minutes — if one exists, the scheduler skips to prevent duplicates.
//
// Why server-side and not in the worker:
//   - The web container already runs setInterval loops (history prune). Same
//     pattern keeps scheduling concerns out of the worker, which should remain
//     a pure job-dispatcher.
//   - Server-side can query and insert atomically via the native pg client.
//   - Worker restarts (common during debugging) don't lose scheduled runs.

import * as db from './db/connection.js';
import { storeJobCredentials, OTHER_SECRET_FIELDS } from './secrets/crawlerSecrets.js';
import { VALID_JOB_TYPES } from './routes/jobs.js';
import { validateStoredCrawlerConfig } from './crawlerManifests.js';
import { parseJsonbColumn } from './lib/jsonb.js';

const TICK_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 45_000;

// Tracks the last time each schedule fired, keyed by `${configId}:${scheduleIndex}`,
// value = ISO string of the minute. Prevents double-firing within the same minute.
const lastFired = new Map();

// Resolve a config's schedule list, supporting both the new `schedules` array
// and the legacy single `schedule` object.
export function extractSchedules(cfg) {
  return cfg.schedules?.length ? cfg.schedules : (cfg.schedule ? [cfg.schedule] : []);
}

export function scheduleMatches(schedule, now) {
  if (!schedule || schedule.enabled === false) return false;
  if (typeof schedule.minute !== 'number' || schedule.minute < 0 || schedule.minute > 59) return false;

  const freq = schedule.frequency || 'daily';
  // Hourly fires every hour at the configured minute
  if (freq === 'hourly') {
    return now.getUTCMinutes() === schedule.minute;
  }
  // Daily fires once per day at hour:minute
  if (freq === 'daily') {
    if (typeof schedule.hour !== 'number') return false;
    return now.getUTCHours() === schedule.hour && now.getUTCMinutes() === schedule.minute;
  }
  // Weekly fires once per week on `day` at hour:minute
  if (freq === 'weekly') {
    if (typeof schedule.hour !== 'number' || typeof schedule.day !== 'number') return false;
    return (
      now.getUTCDay() === schedule.day &&
      now.getUTCHours() === schedule.hour &&
      now.getUTCMinutes() === schedule.minute
    );
  }
  return false;
}

export async function recentlyQueuedJobExists(configId, jobType) {
  // Second safety net against double-firing (survives container restart).
  // If any job from this config was queued/running/completed in the last 55 min,
  // we skip. 55 < 60 so the next minute's tick can still fire if the schedule
  // is hourly, but we won't duplicate within a minute boundary after restart.
  const r = await db.queryOne(
    `SELECT 1 FROM "CrawlerJobs"
      WHERE "jobType" = $1
        AND (config->>'_scheduledByConfigId')::int = $2
        AND "createdAt" > now() - interval '55 minutes'
      LIMIT 1`,
    [jobType, configId]
  );
  return !!r;
}

export async function queueScheduledJob(configRow, scheduleIndex) {
  const cfg = parseJsonbColumn(configRow.config);

  // Resolve the effective syncMode for this scheduled run.
  //   1. Explicit `syncMode` on the schedule entry itself (operator config —
  //      e.g. "daily deltas at 02/08/14/20, weekly full on Sunday").
  //   2. Otherwise fall through to the config-level `nextRunMode` override
  //      (the "Force full sync next run" toggle on the crawler card, which
  //      stays sticky until the scheduler itself resets it below).
  //   3. Otherwise default to 'delta'.
  const schedules = extractSchedules(cfg);
  const thisSchedule = schedules[scheduleIndex] || {};
  const scheduleSyncMode = ['full', 'delta'].includes(thisSchedule.syncMode) ? thisSchedule.syncMode : null;
  const effectiveSyncMode = scheduleSyncMode
    || (['full', 'delta'].includes(configRow.nextRunMode) ? configRow.nextRunMode : null)
    || 'delta';

  // Stamp the config with the schedule's configId so we can look it up later
  // without adding a new column. Non-breaking: workers ignore unknown fields.
  const jobConfig = {
    ...cfg,
    _scheduledByConfigId: configRow.id,
    _scheduleIndex: scheduleIndex,
    _syncMode: effectiveSyncMode,
  };
  // The clientSecret lives in the vault (keyed by config id) and is injected at
  // claim time — never persisted in the job config.
  delete jobConfig.clientSecret;

  const jobType = configRow.crawlerType;
  if (!VALID_JOB_TYPES.includes(jobType)) {
    console.warn(`Scheduler: unsupported crawlerType '${jobType}' for config ${configRow.id}`);
    return;
  }

  // Validate before queueing — the crawler will fail otherwise. jobConfig
  // never has clientSecret (deleted above) — validateStoredCrawlerConfig
  // checks the vault instead of failing on its absence for types whose
  // schema requires it (entra-id; omada/midPoint's OAuth2 methods).
  const configErr = await validateStoredCrawlerConfig(jobType, jobConfig, configRow.id);
  if (configErr) {
    console.warn(`Scheduler: config ${configRow.id} invalid ${jobType} config — skipping scheduled run: ${configErr}`);
    return;
  }

  // Strip all credential fields before storing in CrawlerJobs — they are
  // vaulted per-job and injected at claim time by injectJobSecret.
  const extraCreds = {};
  for (const f of OTHER_SECRET_FIELDS) {
    if (jobConfig[f]) { extraCreds[f] = jobConfig[f]; delete jobConfig[f]; }
  }

  const inserted = await db.queryOne(
    `INSERT INTO "CrawlerJobs" ("jobType", config, "createdBy")
     VALUES ($1, $2::jsonb, 'scheduler')
     RETURNING id`,
    [jobType, JSON.stringify(jobConfig)]
  );
  if (inserted && Object.keys(extraCreds).length) {
    await storeJobCredentials(inserted.id, extraCreds).catch(err =>
      console.warn(`Scheduler: failed to vault credentials for job ${inserted.id}:`, err.message)
    );
  }

  // Update lastRunAt on the source config (same bookkeeping as the manual route)
  try {
    await db.query(
      `UPDATE "CrawlerConfigs" SET "lastRunAt" = now() WHERE id = $1`,
      [configRow.id]
    );
  } catch { /* non-critical */ }

  console.log(`Scheduler: queued ${jobType} job from config ${configRow.id} (${configRow.displayName})`);
}


// Write today's row in DashboardSnapshots if it's missing. Cheap idempotent
// check — runs every scheduler tick (60s), the COUNTs only fire once per
// UTC day (after the first successful insert ON CONFLICT does nothing).
// Uses the same `pg_class.reltuples` fast-path as /admin/dashboard-stats
// for the big tables, exact COUNT(*) for the small / filtered ones.
async function captureDashboardSnapshotIfMissing() {
  try {
    // Existence check via to_regclass — first install may not have the
    // table yet if migration 027 hasn't applied (unlikely, bootstrap runs
    // first, but cheap to check).
    const exists = await db.queryOne(
      `SELECT to_regclass('"DashboardSnapshots"') AS t`
    );
    if (!exists?.t) return;

    const row = await db.queryOne(
      `SELECT 1 FROM "DashboardSnapshots" WHERE "snapshotDate" = CURRENT_DATE`
    );
    if (row) return;  // already captured today

    await db.query(`
      WITH estimates AS (
        SELECT relname, reltuples::bigint AS est
          FROM pg_class
         WHERE relname IN (
           'Resources','Principals','Identities','ResourceAssignments',
           'ResourceRelationships','Contexts','IdentityMembers',
           'CertificationDecisions'
         )
           AND relkind = 'r'
      )
      INSERT INTO "DashboardSnapshots" (
        "snapshotDate",
        "systems", "resources", "businessRoles", "principals",
        "identities", "assignments", "governedAssignments",
        "relationships", "contexts", "identityMembers", "certifications"
      )
      SELECT
        CURRENT_DATE,
        (SELECT COUNT(*)::int FROM "Systems"),
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname='Resources'), 0), 0)::int,
        (SELECT COUNT(*)::int FROM "Resources" WHERE "resourceType" = 'BusinessRole'),
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname='Principals'), 0), 0)::int,
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname='Identities'), 0), 0)::int,
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname='ResourceAssignments'), 0), 0)::int,
        (SELECT COUNT(*)::int FROM "ResourceAssignments" WHERE "governed" = true),
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname='ResourceRelationships'), 0), 0)::int,
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname='Contexts'), 0), 0)::int,
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname='IdentityMembers'), 0), 0)::int,
        GREATEST(COALESCE((SELECT est FROM estimates WHERE relname='CertificationDecisions'), 0), 0)::int
      ON CONFLICT ("snapshotDate") DO NOTHING
    `);
  } catch (err) {
    // Never fail the tick over a snapshot — counts can wait for the next day.
    console.warn(`Scheduler: dashboard snapshot skipped: ${err.message}`);
  }
}

// Fire one schedule if it's due this minute and hasn't already fired. Handles
// the in-memory and cross-restart double-fire guards and swallows queue errors
// so one bad config can't abort the whole tick.
async function fireScheduleIfDue(configRow, scheduleIndex, schedule, now, minuteKey) {
  if (!scheduleMatches(schedule, now)) return;

  const key = `crawler:${configRow.id}:${scheduleIndex}`;
  if (lastFired.get(key) === minuteKey) return; // already fired this minute

  // Cross-restart safety: check DB for recent job from this config
  if (await recentlyQueuedJobExists(configRow.id, configRow.crawlerType)) {
    lastFired.set(key, minuteKey);
    return;
  }

  try {
    await queueScheduledJob(configRow, scheduleIndex);
    lastFired.set(key, minuteKey);
  } catch (err) {
    console.error(`Scheduler: failed to queue job for config ${configRow.id}: ${err.message}`);
  }
}

// Walk every schedule on a single crawler config and fire the due ones.
async function processConfigSchedules(configRow, now, minuteKey) {
  const cfg = parseJsonbColumn(configRow.config);
  const schedules = extractSchedules(cfg);
  for (let i = 0; i < schedules.length; i++) {
    await fireScheduleIfDue(configRow, i, schedules[i], now, minuteKey);
  }
}

// Drop entries from previous minutes — they've served their double-fire
// protection purpose and would otherwise grow unbounded.
function pruneLastFired(minuteKey) {
  for (const [k, v] of lastFired) {
    if (v !== minuteKey) lastFired.delete(k);
  }
}

async function tick() {
  try {
    // Daily snapshot for the dashboard trends. Idempotent; cheap check
    // unless it's the first tick of a new day.
    await captureDashboardSnapshotIfMissing();

    // Load all enabled crawler configs that have at least one schedule
    // Support both 'schedules' (array, new format) and 'schedule' (object, legacy)
    const crawlerRows = await db.query(
      `SELECT id, "crawlerType", "displayName", config, "nextRunMode"
         FROM "CrawlerConfigs"
        WHERE enabled = TRUE
          AND (
            (config ? 'schedules' AND jsonb_array_length(config->'schedules') > 0)
            OR (config ? 'schedule' AND (config->'schedule'->>'enabled')::boolean = TRUE)
          )`
    );

    if (crawlerRows.rows.length === 0) return;

    const now = new Date();
    const minuteKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}T${now.getUTCHours()}:${now.getUTCMinutes()}`;

    for (const configRow of crawlerRows.rows) {
      await processConfigSchedules(configRow, now, minuteKey);
    }

    // Account linking + risk scoring are no longer cron-scheduled — they run after
    // every crawl (see postCrawlJobs.js) or on demand. Only crawlers are scheduled here.

    pruneLastFired(minuteKey);
  } catch (err) {
    console.error(`Scheduler tick failed: ${err.message}`);
  }
}

export function startScheduler() {
  // Delay first run so bootstrap (migrations, built-in crawler creation) finishes first.
  setTimeout(() => {
    tick().catch(err => console.error('Scheduler initial tick failed:', err.message));
    setInterval(() => {
      tick().catch(err => console.error('Scheduler tick failed:', err.message));
    }, TICK_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
  console.log('Scheduler started (crawlers, ticks every 60s)');
}

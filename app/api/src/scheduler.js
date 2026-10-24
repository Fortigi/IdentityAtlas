// Crawler schedule runner.
//
// Reads schedules from CrawlerConfigs.config.schedules (written by the wizard)
// and queues a job whenever the current wall-clock time matches a schedule's
// (hour, minute) that hasn't already fired in this minute.
//
// Schedule shape (from the UI):
//   { enabled: true, frequency: 'interval'|'hourly'|'daily'|'weekly',
//     intervalMinutes?: 5|10|15|20|30, hour: 0-23, minute: 0-59, day?: 0-6 }
//
// Matching rules:
//   - interval: fires every `intervalMinutes`, on the clock (:00, :15, :30, …)
//   - hourly:   fires when `now.minute === schedule.minute` (ignores hour)
//   - daily:    fires when minute + hour match
//   - weekly:   fires when minute + hour + day-of-week match
//
// Double-fire protection: the runner tracks the last fired (configId, scheduleIndex,
// matched minute) in memory. On container restart the in-memory cache resets, but
// a second safety net checks CrawlerJobs for a job queued by the SAME schedule
// entry within its period (55 minutes, or the interval minus one) — if one exists,
// the scheduler skips to prevent duplicates. Per entry, not per config: with a
// delta every 10 minutes, a per-config look-back would always find a delta and
// the daily full would never run.
//
// One job per config: a schedule never queues beside a job of the same config
// that is still queued or running, however old (lib/crawlerJobQueue.js). An
// occurrence that hits a busy config is skipped — except one that is not an
// interval: a daily full that lands while a five-minute delta is running would
// otherwise be lost for the day, so it is retried every tick for up to an hour.
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
import { findActiveConfigJob } from './lib/crawlerJobQueue.js';
import { stampConfigName } from './lib/jobConfig.js';
import { validateStoredCrawlerConfig } from './crawlerManifests.js';
import { parseJsonbColumn } from './lib/jsonb.js';

const TICK_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 45_000;

// Tracks the last time each schedule fired, keyed by `${configId}:${scheduleIndex}`,
// value = ISO string of the minute. Prevents double-firing within the same minute.
const lastFired = new Map();

// Occurrences that came due while their config was busy, retried every tick until
// they queue or their deadline passes. Same key as lastFired; value = deadline (ms).
const pendingRetry = new Map();
const PENDING_RETRY_MS = 60 * 60_000;

// The intervals an 'interval' schedule may use: divisors of 60, so every
// occurrence lands on the same minutes each hour.
export const INTERVAL_MINUTES = [5, 10, 15, 20, 30];

// Resolve a config's schedule list, supporting both the new `schedules` array
// and the legacy single `schedule` object.
export function extractSchedules(cfg) {
  return cfg.schedules?.length ? cfg.schedules : (cfg.schedule ? [cfg.schedule] : []);
}

const validMinute = (s) => typeof s.minute === 'number' && s.minute >= 0 && s.minute <= 59;

// One matcher per frequency. Each answers "is this schedule due at `now`?".
const MATCHERS = {
  // Every intervalMinutes, counted from midnight UTC.
  interval: (s, now) => INTERVAL_MINUTES.includes(s.intervalMinutes)
    && (now.getUTCHours() * 60 + now.getUTCMinutes()) % s.intervalMinutes === 0,
  // Every hour at the configured minute.
  hourly: (s, now) => validMinute(s) && now.getUTCMinutes() === s.minute,
  // Once per day at hour:minute.
  daily: (s, now) => validMinute(s) && typeof s.hour === 'number'
    && now.getUTCHours() === s.hour && now.getUTCMinutes() === s.minute,
  // Once per week on `day` at hour:minute.
  weekly: (s, now) => typeof s.day === 'number' && now.getUTCDay() === s.day && MATCHERS.daily(s, now),
};

export function scheduleMatches(schedule, now) {
  if (!schedule || schedule.enabled === false) return false;
  const match = MATCHERS[schedule.frequency || 'daily'];
  return match ? match(schedule, now) : false;
}

// How far back the cross-restart guard looks for a job of the same schedule
// entry: just under its period, so the next occurrence can still fire.
export function guardWindowMinutes(schedule) {
  return schedule?.frequency === 'interval' ? Math.max(1, schedule.intervalMinutes - 1) : 55;
}

export async function recentlyQueuedJobExists(configId, jobType, scheduleIndex, windowMinutes = 55) {
  // Second safety net against double-firing (survives container restart): a job
  // this schedule entry queued within its window means this occurrence already
  // fired before the restart. Jobs queued by the config's other entries, or by
  // hand, do not count — the busy check below keeps them from overlapping.
  const r = await db.queryOne(
    `SELECT 1 FROM "CrawlerJobs"
      WHERE "jobType" = $1
        AND "configId" = $2
        AND config->>'_scheduleIndex' = $3
        AND "createdAt" > now() - $4::int * interval '1 minute'
      LIMIT 1`,
    [jobType, configId, String(scheduleIndex), windowMinutes]
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

  // Stamp the schedule metadata into the job config for the UI and the worker.
  // Which config's credentials the job receives is decided by the "configId"
  // column written below, never by these JSON fields (SEC-2026-09 H-02).
  const jobConfig = {
    // Drop any _-prefixed keys an admin saved into the config; only the
    // scheduler sets those.
    ...Object.fromEntries(Object.entries(cfg || {}).filter(([k]) => !k.startsWith('_'))),
    _scheduledByConfigId: configRow.id,
    _scheduleIndex: scheduleIndex,
    _syncMode: effectiveSyncMode,
  };
  // Same stamp the Run Now path applies, so a scheduled run names the system it
  // registers identically to a manual one.
  stampConfigName(jobConfig, configRow.displayName);
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
    `INSERT INTO "CrawlerJobs" ("jobType", config, "createdBy", "configId")
     VALUES ($1, $2::jsonb, 'scheduler', $3)
     RETURNING id`,
    [jobType, JSON.stringify(jobConfig), configRow.id]
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
// so one bad config can't abort the whole tick. Exported for unit tests.
export async function fireScheduleIfDue(configRow, scheduleIndex, schedule, now, minuteKey) {
  const key = `crawler:${configRow.id}:${scheduleIndex}`;
  const retrying = pendingRetry.has(key);
  if (!retrying && !scheduleMatches(schedule, now)) return;
  if (lastFired.get(key) === minuteKey) return; // already fired this minute

  // Cross-restart safety: check DB for a recent job from this schedule entry.
  // A retry is past its own occurrence, so the look-back would only find itself.
  if (!retrying && await recentlyQueuedJobExists(configRow.id, configRow.crawlerType, scheduleIndex, guardWindowMinutes(schedule))) {
    lastFired.set(key, minuteKey);
    return;
  }

  // One job per configuration: a run that is still going (a full load can take
  // most of a day) makes this occurrence wait, not a second run beside it.
  const busy = await findActiveConfigJob(db.query, configRow.id);
  if (busy) {
    holdForRetry(key, schedule, now, `config ${configRow.id} (${configRow.displayName}) — job ${busy.id} is still ${busy.status}`);
    lastFired.set(key, minuteKey);
    return;
  }

  try {
    await queueScheduledJob(configRow, scheduleIndex);
    pendingRetry.delete(key);
    lastFired.set(key, minuteKey);
  } catch (err) {
    console.error(`Scheduler: failed to queue job for config ${configRow.id}: ${err.message}`);
  }
}

// A busy config makes an interval occurrence a skip (the next one is minutes
// away) and any other occurrence a retry, until its deadline. Exported for tests.
export function holdForRetry(key, schedule, now, reason) {
  if (schedule?.frequency === 'interval') {
    console.log(`Scheduler: skipped ${reason}`);
    return;
  }
  if (!pendingRetry.has(key)) {
    pendingRetry.set(key, now.getTime() + PENDING_RETRY_MS);
    console.log(`Scheduler: postponed ${reason}; retrying every minute for up to an hour`);
  }
}

// Run a config's full-sync entries before its deltas, so a full and a delta due
// in the same minute do not leave the full waiting behind the delta. Pure.
export function scheduleFiringOrder(schedules) {
  return schedules.map((_, i) => i)
    .sort((a, b) => (schedules[a]?.syncMode === 'full' ? 0 : 1) - (schedules[b]?.syncMode === 'full' ? 0 : 1));
}

// Walk every schedule on a single crawler config and fire the due ones.
async function processConfigSchedules(configRow, now, minuteKey) {
  const cfg = parseJsonbColumn(configRow.config);
  const schedules = extractSchedules(cfg);
  for (const i of scheduleFiringOrder(schedules)) {
    await fireScheduleIfDue(configRow, i, schedules[i], now, minuteKey);
  }
}

// Drop entries from previous minutes — they've served their double-fire
// protection purpose and would otherwise grow unbounded — and retries whose
// deadline has passed (also those of a schedule that has since been removed).
// Exported for unit tests.
export function pruneSchedulerState(minuteKey, now) {
  for (const [k, v] of lastFired) {
    if (v !== minuteKey) lastFired.delete(k);
  }
  for (const [k, deadline] of pendingRetry) {
    if (now.getTime() > deadline) {
      console.log(`Scheduler: gave up on ${k} — its config stayed busy for an hour`);
      pendingRetry.delete(k);
    }
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

    pruneSchedulerState(minuteKey, now);
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

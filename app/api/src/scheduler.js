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
import { runScoring } from './riskscoring/engine.js';

const TICK_INTERVAL_MS = 60_000;
const FIRST_RUN_DELAY_MS = 45_000;

// Tracks the last time each schedule fired, keyed by `${configId}:${scheduleIndex}`,
// value = ISO string of the minute. Prevents double-firing within the same minute.
const lastFired = new Map();

function scheduleMatches(schedule, now) {
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

async function recentlyQueuedJobExists(configId, jobType) {
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

async function queueScheduledJob(configRow, scheduleIndex) {
  const cfg = typeof configRow.config === 'string' ? JSON.parse(configRow.config) : configRow.config;

  // Stamp the config with the schedule's configId so we can look it up later
  // without adding a new column. Non-breaking: workers ignore unknown fields.
  const jobConfig = {
    ...cfg,
    _scheduledByConfigId: configRow.id,
    _scheduleIndex: scheduleIndex,
  };

  // The jobType is derived from crawlerType. The CrawlerConfigs.crawlerType is
  // the canonical source — 'entra-id' or 'csv'.
  const jobType = configRow.crawlerType;
  if (!['entra-id', 'csv', 'omada'].includes(jobType)) {
    console.warn(`Scheduler: unsupported crawlerType '${jobType}' for config ${configRow.id}`);
    return;
  }

  // Validate before queueing — the crawler will fail otherwise
  if (jobType === 'entra-id') {
    if (!jobConfig.tenantId || !jobConfig.clientId || !jobConfig.clientSecret) {
      console.warn(`Scheduler: config ${configRow.id} missing Entra credentials — skipping scheduled run`);
      return;
    }
  }
  if (jobType === 'omada') {
    if (!jobConfig.omadaBaseUrl || !jobConfig.authMode) {
      console.warn(`Scheduler: config ${configRow.id} missing Omada settings — skipping scheduled run`);
      return;
    }
  }

  await db.query(
    `INSERT INTO "CrawlerJobs" ("jobType", config, "createdBy")
     VALUES ($1, $2::jsonb, 'scheduler')`,
    [jobType, JSON.stringify(jobConfig)]
  );

  // Update lastRunAt on the source config (same bookkeeping as the manual route)
  try {
    await db.query(
      `UPDATE "CrawlerConfigs" SET "lastRunAt" = now() WHERE id = $1`,
      [configRow.id]
    );
  } catch { /* non-critical */ }

  console.log(`Scheduler: queued ${jobType} job from config ${configRow.id} (${configRow.displayName})`);
}

async function queueScheduledScoringRun(classifierRow, scheduleIndex) {
  // Check if a scoring run already exists in the last 55 minutes for this classifier
  const recent = await db.queryOne(
    `SELECT 1 FROM "ScoringRuns"
      WHERE "classifierId" = $1
        AND "startedAt" > now() - interval '55 minutes'
      LIMIT 1`,
    [classifierRow.id]
  );
  if (recent) return; // Skip duplicate

  const triggeredBy = 'scheduler';
  const run = await db.queryOne(
    `INSERT INTO "ScoringRuns" ("classifierId", status, step, pct, "triggeredBy")
     VALUES ($1, 'pending', 'Queued', 0, $2)
     RETURNING *`,
    [classifierRow.id, triggeredBy]
  );

  // Fire the scoring runner in the background (same pattern as manual runs)
  runScoring(run.id, classifierRow.id).catch(err => {
    console.error(`Scheduled scoring run ${run.id} crashed:`, err);
  });

  console.log(`Scheduler: queued risk scoring run for classifier ${classifierRow.id} (${classifierRow.displayName})`);
}

async function tick() {
  try {
    // Load all enabled crawler configs that have at least one schedule
    // Support both 'schedules' (array, new format) and 'schedule' (object, legacy)
    const crawlerRows = await db.query(
      `SELECT id, "crawlerType", "displayName", config
         FROM "CrawlerConfigs"
        WHERE enabled = TRUE
          AND (
            (config ? 'schedules' AND jsonb_array_length(config->'schedules') > 0)
            OR (config ? 'schedule' AND (config->'schedule'->>'enabled')::boolean = TRUE)
          )`
    );

    // Load all active risk classifiers that have at least one schedule
    const classifierRows = await db.query(
      `SELECT id, "displayName", schedules
         FROM "RiskClassifiers"
        WHERE "isActive" = TRUE
          AND schedules IS NOT NULL
          AND jsonb_array_length(schedules) > 0`
    );

    if (crawlerRows.rows.length === 0 && classifierRows.rows.length === 0) return;

    const now = new Date();
    const minuteKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}T${now.getUTCHours()}:${now.getUTCMinutes()}`;

    // Process crawler schedules
    for (const configRow of crawlerRows.rows) {
      const cfg = typeof configRow.config === 'string' ? JSON.parse(configRow.config) : configRow.config;
      // Support both 'schedules' (array, new format) and 'schedule' (object, legacy)
      const schedules = cfg.schedules?.length ? cfg.schedules : (cfg.schedule ? [cfg.schedule] : []);

      for (let i = 0; i < schedules.length; i++) {
        const s = schedules[i];
        if (!scheduleMatches(s, now)) continue;

        const key = `crawler:${configRow.id}:${i}`;
        if (lastFired.get(key) === minuteKey) continue; // already fired this minute

        // Cross-restart safety: check DB for recent job from this config
        if (await recentlyQueuedJobExists(configRow.id, configRow.crawlerType)) {
          lastFired.set(key, minuteKey);
          continue;
        }

        try {
          await queueScheduledJob(configRow, i);
          lastFired.set(key, minuteKey);
        } catch (err) {
          console.error(`Scheduler: failed to queue job for config ${configRow.id}: ${err.message}`);
        }
      }
    }

    // Process risk scoring schedules
    for (const classifierRow of classifierRows.rows) {
      const schedules = Array.isArray(classifierRow.schedules)
        ? classifierRow.schedules
        : (typeof classifierRow.schedules === 'string' ? JSON.parse(classifierRow.schedules) : []);

      for (let i = 0; i < schedules.length; i++) {
        const s = schedules[i];
        if (!scheduleMatches(s, now)) continue;

        const key = `scoring:${classifierRow.id}:${i}`;
        if (lastFired.get(key) === minuteKey) continue; // already fired this minute

        try {
          await queueScheduledScoringRun(classifierRow, i);
          lastFired.set(key, minuteKey);
        } catch (err) {
          console.error(`Scheduler: failed to queue scoring run for classifier ${classifierRow.id}: ${err.message}`);
        }
      }
    }
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
  console.log('Scheduler started (crawlers + risk scoring, ticks every 60s)');
}

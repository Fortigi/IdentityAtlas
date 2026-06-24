// Post-crawl job pipeline.
//
// Account linking, context-plugin refresh, and risk scoring are all "derived data"
// jobs that should run after a crawl. Rather than hard-wiring each into the
// crawl-completion handler, they register here. The pipeline runs the *enabled*
// jobs in *order*, each to completion before the next — so the dependency chain
// holds: crawl → account linking → context plugins → risk scoring. Adding a new
// post-crawl job is one entry in POST_CRAWL_JOBS.

import * as db from './db/connection.js';
import { startAccountLinkingRun } from './accountlinking/engine.js';
import { refreshGeneratedContexts } from './contexts/plugins/runner.js';
import { startRiskScoringRun } from './riskscoring/engine.js';

export const POST_CRAWL_JOBS = [
  {
    id: 'account-linking', name: 'Account linking', defaultOrder: 1,
    configTab: 'account-linking', runsTable: 'AccountLinkingRuns',
    run: (by, opts) => startAccountLinkingRun(by, { onlyIfConfigured: true, ...opts }),
  },
  {
    id: 'context-plugins', name: 'Context plugins', defaultOrder: 2,
    configTab: 'plugins', runsTable: 'ContextAlgorithmRuns',
    run: (by, opts) => refreshGeneratedContexts(by, opts),
  },
  {
    id: 'risk-scoring', name: 'Risk scoring', defaultOrder: 3,
    configTab: 'risk-scoring', runsTable: 'ScoringRuns',
    run: (by, opts) => startRiskScoringRun(by, { onlyIfConfigured: true, ...opts }),
  },
];

const byId = new Map(POST_CRAWL_JOBS.map((j) => [j.id, j]));

async function settingsMap() {
  try {
    const { rows } = await db.query(`SELECT "jobId", enabled, "sortOrder" FROM "PostCrawlJobConfig"`);
    return new Map(rows.map((r) => [r.jobId, r]));
  } catch {
    return new Map(); // table may not exist yet (pre-migration)
  }
}

// The jobs with their effective settings (enabled + order), ordered. Absence of a
// stored row = enabled at the registry default order.
export async function getJobSettings() {
  const s = await settingsMap();
  return POST_CRAWL_JOBS.map((j) => {
    const cfg = s.get(j.id);
    return {
      id: j.id, name: j.name, configTab: j.configTab,
      enabled: cfg ? cfg.enabled : true,
      order: cfg && cfg.sortOrder != null ? cfg.sortOrder : j.defaultOrder,
    };
  }).sort((a, b) => a.order - b.order);
}

// Same, plus each job's most recent run — for the Automation admin view.
export async function getJobsWithStatus() {
  const jobs = await getJobSettings();
  for (const j of jobs) {
    const job = byId.get(j.id);
    try {
      j.lastRun = await db.queryOne(
        `SELECT status, "startedAt", "triggeredBy" FROM "${job.runsTable}" ORDER BY "startedAt" DESC LIMIT 1`);
    } catch {
      j.lastRun = null;
    }
  }
  return jobs;
}

// Run the enabled jobs in order, each to completion before the next. The caller
// fires this and forgets it (so the crawl HTTP request returns immediately), but
// internally it is sequential so ordering/dependencies hold.
export async function runPostCrawlJobs(triggeredBy = 'crawl-complete') {
  const jobs = await getJobSettings();
  for (const j of jobs) {
    if (!j.enabled) continue;
    const job = byId.get(j.id);
    if (!job) continue;
    try {
      await job.run(triggeredBy, { awaitCompletion: true });
    } catch (err) {
      console.error(`[post-crawl] job ${j.id} failed:`, err.message);
    }
  }
}

export async function setJobConfig(jobId, { enabled, order }) {
  if (!byId.has(jobId)) throw new Error(`Unknown job: ${jobId}`);
  await db.query(
    `INSERT INTO "PostCrawlJobConfig" ("jobId", enabled, "sortOrder")
     VALUES ($1, COALESCE($2, true), $3)
     ON CONFLICT ("jobId") DO UPDATE SET
       enabled = COALESCE($2, "PostCrawlJobConfig".enabled),
       "sortOrder" = COALESCE($3, "PostCrawlJobConfig"."sortOrder")`,
    [jobId, enabled ?? null, order ?? null]);
}

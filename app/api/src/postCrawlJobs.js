// Post-crawl job pipeline.
//
// Account linking, context-plugin refresh, and risk scoring are "derived data" jobs
// that run after every crawl, in order, each to completion before the next — so
// contexts rebuild after account linking, and scoring runs after contexts. Account
// linking and risk scoring no-op when not configured; all three can also be run on
// demand from their own admin tabs. Adding a post-crawl job is one entry here.

import { startAccountLinkingRun } from './accountlinking/engine.js';
import { refreshGeneratedContexts } from './contexts/plugins/runner.js';
import { startRiskScoringRun } from './riskscoring/engine.js';

const POST_CRAWL_JOBS = [
  { id: 'account-linking', run: (by) => startAccountLinkingRun(by, { onlyIfConfigured: true, awaitCompletion: true }) },
  { id: 'context-plugins', run: (by) => refreshGeneratedContexts(by, { awaitCompletion: true }) },
  { id: 'risk-scoring',    run: (by) => startRiskScoringRun(by, { onlyIfConfigured: true, awaitCompletion: true }) },
];

// Run the jobs in order, each to completion before the next. The caller fires this
// and forgets it (so the crawl HTTP request returns immediately), but internally it
// is sequential so ordering/dependencies hold.
export async function runPostCrawlJobs(triggeredBy = 'crawl-complete') {
  for (const job of POST_CRAWL_JOBS) {
    try {
      await job.run(triggeredBy);
    } catch (err) {
      console.error(`[post-crawl] job ${job.id} failed:`, err.message);
    }
  }
}

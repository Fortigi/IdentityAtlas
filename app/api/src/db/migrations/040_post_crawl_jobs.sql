-- Post-crawl job orchestration.
--
-- Several "derived data" jobs run after a crawl: account linking, context-plugin
-- refresh, and risk scoring. This table holds, per job, whether it runs after a
-- crawl and in what order. Absence of a row = enabled at the registry default
-- order (see postCrawlJobs.js). The post-crawl pipeline runs the enabled jobs in
-- order, each to completion before the next (so e.g. contexts rebuild after
-- account linking, and scoring runs after contexts).

CREATE TABLE IF NOT EXISTS "PostCrawlJobConfig" (
  "jobId"     TEXT PRIMARY KEY,
  "enabled"   BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER
);

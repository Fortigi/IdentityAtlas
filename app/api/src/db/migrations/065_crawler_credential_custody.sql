-- Identity Atlas — crawler credential custody (SEC-2026-09 H-02, M-06)
--
-- 1. CrawlerJobs."configId" — the stored config a job was created from.
--
--    Until now the worker's claim handler decided whose vaulted credentials to
--    inject from `config->>'_scheduledByConfigId'`, a key inside the job's
--    config JSON. For an inline job that JSON is written by the caller, so it
--    could name any config. The server now writes this column itself (the
--    create-job route from its validated `configId` parameter, the scheduler
--    from the config row it fires) and credential injection reads only the
--    column.
--
--    Backfill: jobs that already exist keep working after the upgrade (a job
--    still queued must receive its config's credentials). The JSON value is
--    only trusted when it names an existing config of the SAME crawler type and
--    the job has no inline clientSecret of its own — the shape every
--    server-created, config-based job has always had.
--
-- 2. Crawlers."isBuiltIn" — the bootstrap-created worker crawler.
--
--    The built-in worker holds the `admin` crawler permission (it claims jobs
--    and receives vaulted credentials). It used to be recognised by its display
--    name alone, which an admin could copy or rename. The flag is set only by
--    bootstrap; a partial unique index allows at most one such row.
--
--    Backfill: the existing worker is the bootstrap-created row with that name
--    (preferring the enabled, oldest one when several exist).

ALTER TABLE "CrawlerJobs"
    ADD COLUMN "configId" INTEGER REFERENCES "CrawlerConfigs" ("id") ON DELETE SET NULL;

UPDATE "CrawlerJobs" j
   SET "configId" = c."id"
  FROM "CrawlerConfigs" c
 WHERE j."configId" IS NULL
   AND jsonb_typeof(j."config") = 'object'
   AND (j."config"->>'_scheduledByConfigId') ~ '^[0-9]{1,9}$'
   AND c."id" = (j."config"->>'_scheduledByConfigId')::int
   AND c."crawlerType" = j."jobType"
   AND NOT EXISTS (
         SELECT 1 FROM "Secrets" s
          WHERE s."id" = 'crawler-job:' || j."id" || ':clientSecret'
       );

CREATE INDEX "ix_CrawlerJobs_configId" ON "CrawlerJobs" ("configId", "createdAt" DESC);

ALTER TABLE "Crawlers"
    ADD COLUMN "isBuiltIn" BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE "Crawlers"
   SET "isBuiltIn" = TRUE
 WHERE "id" = (
         SELECT "id" FROM "Crawlers"
          WHERE "displayName" = 'Built-in Worker'
          ORDER BY ("createdBy" = 'system-bootstrap') DESC NULLS LAST,
                   "enabled" DESC,
                   "id" ASC
          LIMIT 1
       );

CREATE UNIQUE INDEX "ux_Crawlers_isBuiltIn" ON "Crawlers" ("isBuiltIn") WHERE "isBuiltIn";

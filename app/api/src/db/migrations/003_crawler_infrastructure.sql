-- Identity Atlas v5 — Crawler infrastructure (camelCase identifiers)

CREATE TABLE "Crawlers" (
    "id"               SERIAL PRIMARY KEY,
    "displayName"      TEXT NOT NULL,
    "description"      TEXT,
    "apiKeyHash"       BYTEA NOT NULL,
    "apiKeySalt"       BYTEA NOT NULL,
    "apiKeyPrefix"     TEXT NOT NULL,
    "enabled"          BOOLEAN NOT NULL DEFAULT TRUE,
    "rateLimit"        INTEGER NOT NULL DEFAULT 100,
    "permissions"      JSONB NOT NULL DEFAULT '[]'::jsonb,
    "systemIds"        JSONB,
    "createdBy"        TEXT,
    "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "lastRotatedAt"    TIMESTAMPTZ,
    "lastUsedAt"       TIMESTAMPTZ,
    "expiresAt"        TIMESTAMPTZ
);
CREATE INDEX "ix_Crawlers_apiKeyPrefix" ON "Crawlers"("apiKeyPrefix");

CREATE TABLE "CrawlerAuditLog" (
    "id"           SERIAL PRIMARY KEY,
    "crawlerId"    INTEGER NOT NULL REFERENCES "Crawlers"("id") ON DELETE CASCADE,
    "action"       TEXT NOT NULL,
    "endpoint"     TEXT,
    "recordCount"  INTEGER,
    "statusCode"   INTEGER,
    "ipAddress"    TEXT,
    "timestamp"    TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX "ix_Audit_crawlerId" ON "CrawlerAuditLog"("crawlerId");
CREATE INDEX "ix_Audit_timestamp" ON "CrawlerAuditLog"("timestamp");

CREATE TABLE "CrawlerConfigs" (
    "id"              SERIAL PRIMARY KEY,
    "crawlerType"     TEXT NOT NULL,
    "displayName"     TEXT NOT NULL,
    "config"          JSONB NOT NULL,
    "enabled"         BOOLEAN NOT NULL DEFAULT TRUE,
    "lastRunAt"       TIMESTAMPTZ,
    "lastRunStatus"   TEXT,
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX "ix_CrawlerConfigs_type" ON "CrawlerConfigs"("crawlerType");

CREATE TABLE "CrawlerJobs" (
    "id"             SERIAL PRIMARY KEY,
    "jobType"        TEXT NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'queued',
    "config"         JSONB,
    "progress"       JSONB,
    "result"         JSONB,
    "errorMessage"   TEXT,
    "createdBy"      TEXT,
    "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "startedAt"      TIMESTAMPTZ,
    "completedAt"    TIMESTAMPTZ
);
CREATE INDEX "ix_CrawlerJobs_status"    ON "CrawlerJobs"("status");
CREATE INDEX "ix_CrawlerJobs_jobType"   ON "CrawlerJobs"("jobType");
CREATE INDEX "ix_CrawlerJobs_createdAt" ON "CrawlerJobs"("createdAt" DESC);

-- Sync log: kept the v4 name 'GraphSyncLog' to minimise route changes.
CREATE TABLE "GraphSyncLog" (
    "Id"               SERIAL PRIMARY KEY,
    "SyncType"         TEXT NOT NULL,
    "TableName"        TEXT,
    "StartTime"        TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "EndTime"          TIMESTAMPTZ,
    "DurationSeconds"  INTEGER,
    "RecordCount"      INTEGER,
    "Status"           TEXT NOT NULL,
    "ErrorMessage"     TEXT,
    "CreatedAt"        TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE INDEX "ix_GraphSyncLog_StartTime" ON "GraphSyncLog"("StartTime" DESC);

CREATE TABLE "GraphUserPreferences" (
    "userId"      TEXT PRIMARY KEY,
    "displayName" TEXT,
    "email"       TEXT,
    "visibleTabs" JSONB,
    "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

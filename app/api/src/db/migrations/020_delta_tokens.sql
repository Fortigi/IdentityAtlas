-- Delta-token state for Graph /delta endpoints.
--
-- /users/delta, /groups/delta, /servicePrincipals/delta (and others) return
-- only the records that changed since the last call — provided the caller
-- passes back the `@odata.deltaLink` token Graph handed out at the end of
-- the previous run. The pattern is:
--
--   first run     : GET /users/delta                   → tokenA
--   subsequent run: GET /users/delta?$deltatoken=tokenA → changes, tokenB
--
-- We persist the token here per (system, endpoint). Tokens can also encode
-- query-scoping ($select, $filter), so it's important we pair the token
-- with the exact endpoint+params the caller used. The key enforces one
-- token per (systemId, endpoint) so a query shape change (e.g. adding a
-- new $select field) is a deliberate token reset, not silent corruption.
--
-- When Graph returns 410 Gone or 400 on a stored token (expired, revoked),
-- the caller must delete the row and restart with a full fetch. Same for
-- when an operator forces a full sync via the UI.
CREATE TABLE IF NOT EXISTS "DeltaTokens" (
    "systemId"   INTEGER NOT NULL REFERENCES "Systems"(id) ON DELETE CASCADE,
    "endpoint"   TEXT    NOT NULL,
    "token"      TEXT    NOT NULL,
    "lastSyncAt" TIMESTAMPTZ NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
    "recordsLastSeen" INTEGER,
    PRIMARY KEY ("systemId", "endpoint")
);

CREATE INDEX IF NOT EXISTS "ix_DeltaTokens_lastSyncAt" ON "DeltaTokens"("lastSyncAt" DESC);

-- Per-crawler-config "next run is full" override. The UI surfaces this as a
-- "Force full sync next run" toggle. The crawler reads it at start, honors
-- full-mode if true, and resets it to false after a successful full run so
-- subsequent runs return to delta. We track nextRunMode on CrawlerConfigs
-- (not per-job) because the UI edits the config, and the scheduler/worker
-- queue jobs from the config row.
ALTER TABLE "CrawlerConfigs"
    ADD COLUMN IF NOT EXISTS "nextRunMode" TEXT NOT NULL DEFAULT 'delta'
    CHECK ("nextRunMode" IN ('full', 'delta'));

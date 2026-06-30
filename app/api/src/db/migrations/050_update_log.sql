-- Auto-update: a log of update checks and applied updates.
--
-- The app never touches Docker. It records (a) what the nightly check found and
-- (b) when the running version actually changed (an update was applied, by
-- whatever external agent — a Docker-host cron, an Azure scheduled job, a local
-- script, or a manual `docker compose pull`). The Admin → Updates tab reads this
-- table; the AUTO_UPDATE_ENABLED switch lives in WorkerConfig.
--
-- status values:
--   'up-to-date' — checked, already on the newest version for the channel
--   'available'  — checked, a newer version exists on the channel
--   'checked'    — checked, no comparable version info (e.g. pinned deployment)
--   'failed'     — the check itself errored (network, parse, …); detail has why
--   'installed'  — the running version changed since the last row (update applied)
--   'applying'   — an external agent reported it has started applying (optional)

CREATE TABLE IF NOT EXISTS "UpdateLog" (
    "id"              SERIAL PRIMARY KEY,
    "channel"         TEXT NOT NULL,                       -- edge | beta | latest | pinned
    "currentVersion"  TEXT,                                -- running MODULE_VERSION at the time
    "latestVersion"   TEXT,                                -- newest available on the channel
    "updateAvailable" BOOLEAN NOT NULL DEFAULT FALSE,
    "status"          TEXT NOT NULL,
    "detail"          TEXT,                                -- error / human note
    "source"          TEXT,                                -- scheduler | manual | agent | auto-detected
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ix_UpdateLog_createdAt" ON "UpdateLog" ("createdAt" DESC);

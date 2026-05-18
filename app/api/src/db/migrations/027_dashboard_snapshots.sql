-- Identity Atlas — daily snapshot of dashboard counts.
--
-- One row per UTC day. Used by the new Trends tab on the Dashboard page
-- to plot growth over time for users, resources, assignments, and the
-- % of assignments that are governed.
--
-- The scheduler writes a row once per day; if today's row is already
-- present the insert is a no-op (ON CONFLICT). Reads are a simple
--   SELECT * FROM "DashboardSnapshots"
--    WHERE "snapshotDate" >= CURRENT_DATE - INTERVAL 'N days'
-- which is index-only on the primary key.
--
-- We deliberately do NOT backfill from `_history`. Pre-v6 history coverage
-- was partial (composite-PK tables only got history triggers in migration
-- 018), and a reconstructed early section would tell a misleading story.
-- The chart starts as a single point on the day this migration applies
-- and grows from there.

CREATE TABLE IF NOT EXISTS "DashboardSnapshots" (
    "snapshotDate"          DATE PRIMARY KEY,
    "capturedAt"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "systems"               INT NOT NULL DEFAULT 0,
    "resources"             INT NOT NULL DEFAULT 0,
    "businessRoles"         INT NOT NULL DEFAULT 0,
    "principals"            INT NOT NULL DEFAULT 0,
    "identities"            INT NOT NULL DEFAULT 0,
    "assignments"           INT NOT NULL DEFAULT 0,
    "governedAssignments"   INT NOT NULL DEFAULT 0,
    "relationships"         INT NOT NULL DEFAULT 0,
    "contexts"              INT NOT NULL DEFAULT 0,
    "identityMembers"       INT NOT NULL DEFAULT 0,
    "certifications"        INT NOT NULL DEFAULT 0
);

-- Identity Atlas — audit trail for role→permission mapping changes (#786, security M-04).
--
-- The Admin → Roles & Permissions editor (routes/authRoles.js) hot-updates the
-- role→permission mapping stored in WorkerConfig, but recorded nothing about WHO
-- changed it or WHEN. This table captures every save / reset so a change to who
-- can do what in the app is attributable and reviewable after the fact. The
-- editor already refuses a change that would strip the acting admin's own
-- admin.auth (the self-lockout guard); this closes the "no audit trail" half.

CREATE TABLE IF NOT EXISTS "AuthRoleChangeLog" (
    "id"        BIGSERIAL PRIMARY KEY,
    "changedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "changedBy" TEXT,             -- acting admin (name / UPN / object id); NULL when auth is disabled
    "action"    TEXT NOT NULL,    -- 'save' | 'reset'
    "mapping"   JSONB             -- the role→permission mapping in effect AFTER the change
);

-- The audit view lists newest-first.
CREATE INDEX IF NOT EXISTS "ix_AuthRoleChangeLog_changedAt"
    ON "AuthRoleChangeLog" ("changedAt" DESC);

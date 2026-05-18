-- Identity Atlas — broaden the matrix matview to include EVERY assignment
-- type stored in ResourceAssignments, not just the original four.
--
-- Background: migration 013 hardcoded a UNION ALL of Direct/Owner/Eligible/
-- Governed. That meant later assignment types — most notably OAuth2Grant
-- for per-user OAuth2 consent grants — never made it into the matrix view.
-- The data was there, but the matrix simply didn't see it.
--
-- This migration drops the matview and recreates it as a single
-- SELECT from ResourceAssignments with no assignmentType filter, so any
-- current or future type flows through automatically. The output shape
-- (columns + indexes) is unchanged, so callers continue to work without
-- modification.

-- ─── 1. Drop dependent views ────────────────────────────────────────────
-- The compat alias depends on the matview; CASCADE would also work, but
-- being explicit keeps the migration easy to read.
DROP VIEW IF EXISTS "vw_UserPermissionAssignments";
DROP MATERIALIZED VIEW IF EXISTS "vw_ResourceUserPermissionAssignments";

-- ─── 2. Recreate matrix matview — every assignment type included ────────
CREATE MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments" AS
WITH governed_pairs AS (
    SELECT DISTINCT "resourceId", "principalId"
      FROM "ResourceAssignments"
     WHERE "assignmentType" = 'Governed'
)
SELECT
    ra."resourceId",
    ra."principalId",
    ra."principalType",
    ra."assignmentType" AS "membershipType",
    (ra."assignmentType" = 'Governed'
       OR gp."resourceId" IS NOT NULL) AS "managedByAccessPackage"
FROM "ResourceAssignments" ra
LEFT JOIN governed_pairs gp
       ON gp."resourceId"  = ra."resourceId"
      AND gp."principalId" = ra."principalId"
WITH NO DATA;

-- ─── 3. Recreate indexes (same as migration 013) ────────────────────────
CREATE UNIQUE INDEX "ix_vw_ResUserPerm_pk"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId", "principalId", "membershipType");
CREATE INDEX "ix_vw_ResUserPerm_principalId"
    ON "vw_ResourceUserPermissionAssignments" ("principalId");
CREATE INDEX "ix_vw_ResUserPerm_resourceId"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId");

-- ─── 4. Recreate compat alias view ──────────────────────────────────────
CREATE VIEW "vw_UserPermissionAssignments" AS
SELECT
    "resourceId"  AS "groupId",
    "principalId" AS "memberId",
    "principalType",
    "membershipType",
    "managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments";

-- Note: the matview starts empty (WITH NO DATA). bootstrap.js calls
-- refreshMatrixViews() at web container start, which will populate it
-- on first boot after this migration applies.

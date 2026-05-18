-- Identity Atlas — collapse source-attribute assignment types into their
-- type-attribute equivalents in the matrix's membershipType column.
--
-- Background: several assignmentType values conflate two orthogonal concepts:
--   - HOW the user holds the resource (direct / eligible / owner / ...)
--   - WHY / VIA WHAT mechanism the membership was created (manually vs.
--     a governed BR assignment, an OAuth2 user consent, an app role
--     assignment, etc.)
--
-- The "WHY" belongs in either the resource's resourceType (which already
-- exists on the resource side) or a separate source attribute — not in
-- the type column. From the user's perspective:
--   * Governed BR → user        — user directly holds the BR     → Direct
--   * OAuth2 grant              — user directly consented        → Direct
--   * App role direct assignment — user directly assigned        → Direct
--   * App role via group        — user inherits via group        → Indirect
--
-- Fix: rewrite the matview's `membershipType` output via CASE. Leave the
-- raw assignmentType in ResourceAssignments untouched so the rest of the
-- system (BR-via mapping, scoped-delete by assignmentType, ingest
-- validation enums) continues to work without churn. The
-- managedByAccessPackage column also still uses the raw assignmentType,
-- so cell colouring is unchanged — the badge changes, the AP-color
-- doesn't.

DROP VIEW IF EXISTS "vw_UserPermissionAssignments";
DROP MATERIALIZED VIEW IF EXISTS "vw_ResourceUserPermissionAssignments";

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
    -- Collapse source-attribute types onto their HOW equivalents. The
    -- resource type column already conveys WHY (BR / DelegatedPermission /
    -- AppRole / etc.); the badge should only convey HOW.
    CASE
      WHEN ra."assignmentType" IN ('Governed', 'OAuth2Grant', 'AppRole') THEN 'Direct'
      WHEN ra."assignmentType" = 'AppRoleViaGroup'                       THEN 'Indirect'
      ELSE ra."assignmentType"
    END AS "membershipType",
    (ra."assignmentType" = 'Governed'
       OR gp."resourceId" IS NOT NULL) AS "managedByAccessPackage"
FROM "ResourceAssignments" ra
LEFT JOIN governed_pairs gp
       ON gp."resourceId"  = ra."resourceId"
      AND gp."principalId" = ra."principalId"
WITH NO DATA;

-- Same indexes as migrations 013 / 024.
CREATE UNIQUE INDEX "ix_vw_ResUserPerm_pk"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId", "principalId", "membershipType");
CREATE INDEX "ix_vw_ResUserPerm_principalId"
    ON "vw_ResourceUserPermissionAssignments" ("principalId");
CREATE INDEX "ix_vw_ResUserPerm_resourceId"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId");

-- Compat alias view.
CREATE VIEW "vw_UserPermissionAssignments" AS
SELECT
    "resourceId"  AS "groupId",
    "principalId" AS "memberId",
    "principalType",
    "membershipType",
    "managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments";

-- bootstrap.js calls refreshMatrixViews() at web start to populate the matview.

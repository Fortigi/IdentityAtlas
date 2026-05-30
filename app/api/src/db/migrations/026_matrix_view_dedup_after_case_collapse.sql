-- Identity Atlas — dedup matview output after the membershipType CASE
-- collapse (migration 025) so the unique PK index never collides.
--
-- Background: migration 025 introduced
--   CASE WHEN assignmentType IN ('Governed','OAuth2Grant','AppRole') THEN 'Direct'
--        WHEN assignmentType = 'AppRoleViaGroup'                     THEN 'Indirect'
--        ELSE assignmentType END
-- to render those source-attribute types as D / I in the matrix badge.
--
-- That collapse can produce duplicate output rows if a single
-- (resourceId, principalId) pair has *more than one* raw row that
-- collapses to the same value — e.g. a user with both a Direct and a
-- Governed assignment to the same resource. The matview's unique index
-- ix_vw_ResUserPerm_pk(resourceId, principalId, membershipType) then
-- refuses the REFRESH with "duplicate key value violates unique
-- constraint". CI's load-test dataset triggers exactly this.
--
-- Fix: GROUP BY (resourceId, principalId, collapsed-type) so the matview
-- emits at most one row per output PK. managedByAccessPackage is
-- bool_or'd across the duplicates so a cell still flags as governed if
-- *any* of the underlying assignment rows are governed.

DROP VIEW IF EXISTS "vw_UserPermissionAssignments";
DROP MATERIALIZED VIEW IF EXISTS "vw_ResourceUserPermissionAssignments";

CREATE MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments" AS
WITH governed_pairs AS (
    SELECT DISTINCT "resourceId", "principalId"
      FROM "ResourceAssignments"
     WHERE "assignmentType" = 'Governed'
),
collapsed AS (
    SELECT
        ra."resourceId",
        ra."principalId",
        ra."principalType",
        CASE
          WHEN ra."assignmentType" IN ('Governed', 'OAuth2Grant', 'AppRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                       THEN 'Indirect'
          ELSE ra."assignmentType"
        END AS "membershipType",
        (ra."assignmentType" = 'Governed' OR gp."resourceId" IS NOT NULL) AS "managedByAccessPackage"
    FROM "ResourceAssignments" ra
    LEFT JOIN governed_pairs gp
           ON gp."resourceId"  = ra."resourceId"
          AND gp."principalId" = ra."principalId"
)
SELECT
    "resourceId",
    "principalId",
    -- All rows for the same (resourceId, principalId) carry the same
    -- principalType in practice (e.g. always User). Aggregate just to
    -- satisfy the GROUP BY contract; MAX is deterministic.
    MAX("principalType") AS "principalType",
    "membershipType",
    bool_or("managedByAccessPackage") AS "managedByAccessPackage"
FROM collapsed
GROUP BY "resourceId", "principalId", "membershipType"
WITH NO DATA;

CREATE UNIQUE INDEX "ix_vw_ResUserPerm_pk"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId", "principalId", "membershipType");
CREATE INDEX "ix_vw_ResUserPerm_principalId"
    ON "vw_ResourceUserPermissionAssignments" ("principalId");
CREATE INDEX "ix_vw_ResUserPerm_resourceId"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId");

CREATE VIEW "vw_UserPermissionAssignments" AS
SELECT
    "resourceId"  AS "groupId",
    "principalId" AS "memberId",
    "principalType",
    "membershipType",
    "managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments";

-- bootstrap.js refreshMatrixViews() repopulates the matview at startup.

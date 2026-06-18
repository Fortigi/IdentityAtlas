-- Identity Atlas — rebuild matrix view to expand identity-level assignments.
--
-- Adds a UNION arm inside the `collapsed` CTE that joins ResourceAssignments
-- (identityId IS NOT NULL) through IdentityMembers to produce one row per
-- principal. The existing GROUP BY dedup absorbs cross-arm duplicates so a
-- person with both a principal-level and an identity-level assignment to the
-- same resource yields a single matrix cell.
--
-- Pattern mirrors migration 026: drop the dependent view first, then the
-- matview, then recreate both.

DROP VIEW IF EXISTS "vw_UserPermissionAssignments";
DROP MATERIALIZED VIEW IF EXISTS "vw_ResourceUserPermissionAssignments";

CREATE MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments" AS
WITH governed_pairs AS (
    SELECT DISTINCT "resourceId", "principalId"
      FROM "ResourceAssignments"
     WHERE "assignmentType" = 'Governed'
       AND "principalId" IS NOT NULL
),
collapsed AS (
    -- Existing arm: principal-level assignments
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
    WHERE ra."principalId" IS NOT NULL

    UNION ALL

    -- New arm: identity-level assignments expanded through IdentityMembers
    SELECT
        ra."resourceId",
        im."principalId",
        NULL AS "principalType",
        CASE
          WHEN ra."assignmentType" IN ('Governed', 'OAuth2Grant', 'AppRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                       THEN 'Indirect'
          ELSE ra."assignmentType"
        END AS "membershipType",
        (ra."assignmentType" = 'Governed') AS "managedByAccessPackage"
    FROM "ResourceAssignments" ra
    JOIN "IdentityMembers" im ON im."identityId" = ra."identityId"
    WHERE ra."identityId" IS NOT NULL
)
SELECT
    "resourceId",
    "principalId",
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

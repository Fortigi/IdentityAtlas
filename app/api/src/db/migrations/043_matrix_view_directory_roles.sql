-- Identity Atlas — collapse the new directory-role assignment types in the matrix.
--
-- The Entra ID crawler's new SyncDirectoryRoles phase writes Entra directory
-- roles as Resources(resourceType='EntraRole') with assignments carrying two
-- new source-attribute assignment types:
--   * 'DirectoryRole'          — an active role assignment (permanent or
--                                PIM-activated). Renders as a 'Direct' badge.
--   * 'DirectoryRoleEligible'  — a PIM-eligible (not yet active) assignment.
--                                Renders as an 'Eligible' badge.
--
-- These get distinct raw assignment types (rather than reusing 'Direct' /
-- 'Eligible') so the crawler's scoped full-sync delete keys on them without
-- touching group memberships or PIM-group eligibilities — the same reason
-- AppRole/AppRoleViaGroup are distinct. The matrix collapses them back to the
-- standard Direct/Eligible badges here, mirroring how Governed/OAuth2Grant/
-- AppRole already collapse (see migrations 025/026/041 and matrix.md).
--
-- This file mirrors migration 041 (its soft-delete filters are preserved
-- verbatim) and recreates the matview plus all four of its indexes — including
-- the partial Direct index added in 042, which a DROP MATERIALIZED VIEW removes.

DROP VIEW IF EXISTS "vw_UserPermissionAssignments";
DROP MATERIALIZED VIEW IF EXISTS "vw_ResourceUserPermissionAssignments";

CREATE MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments" AS
WITH governed_pairs AS (
    SELECT DISTINCT "resourceId", "principalId"
      FROM "ResourceAssignments"
     WHERE "assignmentType" = 'Governed'
       AND "principalId" IS NOT NULL
       AND "deletedAt" IS NULL
),
collapsed AS (
    -- Existing arm: principal-level assignments
    SELECT
        ra."resourceId",
        ra."principalId",
        ra."principalType",
        CASE
          WHEN ra."assignmentType" IN ('Governed', 'OAuth2Grant', 'AppRole', 'DirectoryRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                                        THEN 'Indirect'
          WHEN ra."assignmentType" = 'DirectoryRoleEligible'                                  THEN 'Eligible'
          ELSE ra."assignmentType"
        END AS "membershipType",
        (ra."assignmentType" = 'Governed' OR gp."resourceId" IS NOT NULL) AS "managedByAccessPackage"
    FROM "ResourceAssignments" ra
    LEFT JOIN governed_pairs gp
           ON gp."resourceId"  = ra."resourceId"
          AND gp."principalId" = ra."principalId"
    WHERE ra."principalId" IS NOT NULL
      AND ra."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Resources"  r WHERE r.id = ra."resourceId"  AND r."deletedAt" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM "Principals" p WHERE p.id = ra."principalId" AND p."deletedAt" IS NOT NULL)

    UNION ALL

    -- New arm: identity-level assignments expanded through IdentityMembers
    SELECT
        ra."resourceId",
        im."principalId",
        NULL AS "principalType",
        CASE
          WHEN ra."assignmentType" IN ('Governed', 'OAuth2Grant', 'AppRole', 'DirectoryRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                                        THEN 'Indirect'
          WHEN ra."assignmentType" = 'DirectoryRoleEligible'                                  THEN 'Eligible'
          ELSE ra."assignmentType"
        END AS "membershipType",
        (ra."assignmentType" = 'Governed') AS "managedByAccessPackage"
    FROM "ResourceAssignments" ra
    JOIN "IdentityMembers" im ON im."identityId" = ra."identityId"
    WHERE ra."identityId" IS NOT NULL
      AND ra."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Resources"  r WHERE r.id = ra."resourceId"  AND r."deletedAt" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM "Principals" p WHERE p.id = im."principalId" AND p."deletedAt" IS NOT NULL)
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
-- Partial Direct index — carried over from migration 042 (dropped with the matview).
CREATE INDEX "ix_vw_ResUserPerm_direct"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId", "principalId")
    WHERE "membershipType" = 'Direct';

CREATE VIEW "vw_UserPermissionAssignments" AS
SELECT
    "resourceId"  AS "groupId",
    "principalId" AS "memberId",
    "principalType",
    "membershipType",
    "managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments";

-- bootstrap.js refreshMatrixViews() repopulates the matview at startup.

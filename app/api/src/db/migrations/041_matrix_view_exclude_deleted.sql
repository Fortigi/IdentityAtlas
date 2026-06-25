-- Identity Atlas — rebuild the matrix matview to exclude soft-deleted rows.
--
-- Mirrors migration 037 exactly, plus three filters per arm so the live matrix
-- never shows access involving a soft-deleted assignment, principal, or resource:
--   * ra."deletedAt" IS NULL              — the assignment itself isn't tombstoned
--   * NOT EXISTS (deleted Resource)       — the target resource isn't tombstoned
--   * NOT EXISTS (deleted Principal)      — the holder isn't tombstoned
-- Deleted entities remain visible on detail pages ("include deleted"); they're
-- only hidden from the default matrix. NOT EXISTS (rather than a join) keeps any
-- row whose endpoint is simply missing, excluding only explicit tombstones.

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
          WHEN ra."assignmentType" IN ('Governed', 'OAuth2Grant', 'AppRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                       THEN 'Indirect'
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

CREATE VIEW "vw_UserPermissionAssignments" AS
SELECT
    "resourceId"  AS "groupId",
    "principalId" AS "memberId",
    "principalType",
    "membershipType",
    "managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments";

-- bootstrap.js refreshMatrixViews() repopulates the matview at startup.

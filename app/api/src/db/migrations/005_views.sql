-- Identity Atlas v5 — Read views (camelCase identifiers)
--
-- Postgres recursive CTEs replace the v4 SQL Server recursive CTE views.
-- Syntax is essentially identical (`WITH RECURSIVE` instead of `WITH`).
-- Cycle prevention via depth limit of 10 levels.
-- No more ValidTo filtering — temporal tables are gone in v5.

CREATE VIEW "vw_ResourceMembersRecursive" AS
WITH RECURSIVE recursive_memberships AS (
    SELECT
        ra."resourceId",
        ra."principalId",
        ra."principalType",
        'Direct'::TEXT AS "membershipType",
        1 AS "depth",
        (ra."resourceId"::TEXT || ' -> ' || ra."principalId"::TEXT) AS "path"
    FROM "ResourceAssignments" ra
    WHERE ra."assignmentType" = 'Direct'

    UNION ALL

    SELECT
        rm."resourceId",
        ra2."principalId",
        ra2."principalType",
        'Indirect'::TEXT AS "membershipType",
        rm."depth" + 1 AS "depth",
        (rm."path" || ' -> ' || ra2."principalId"::TEXT) AS "path"
    FROM recursive_memberships rm
    JOIN "ResourceAssignments" ra2
      ON ra2."resourceId" = rm."principalId"
     AND ra2."assignmentType" = 'Direct'
    WHERE rm."depth" < 10
)
SELECT * FROM recursive_memberships;

-- Combined view: direct + indirect + owner + eligible. Used by /api/permissions.
CREATE VIEW "vw_ResourceUserPermissionAssignments" AS
WITH all_memberships AS (
    SELECT "resourceId", "principalId", "principalType", "membershipType"
    FROM "vw_ResourceMembersRecursive"
    UNION ALL
    SELECT "resourceId", "principalId", "principalType", 'Owner'::TEXT AS "membershipType"
    FROM "ResourceAssignments"
    WHERE "assignmentType" = 'Owner'
    UNION ALL
    SELECT "resourceId", "principalId", "principalType", 'Eligible'::TEXT AS "membershipType"
    FROM "ResourceAssignments"
    WHERE "assignmentType" = 'Eligible'
)
SELECT
    am."resourceId",
    am."principalId",
    am."principalType",
    am."membershipType",
    EXISTS (
        SELECT 1 FROM "ResourceAssignments" rab
        WHERE rab."resourceId" = am."resourceId"
          AND rab."principalId" = am."principalId"
          AND rab."assignmentType" = 'Governed'
    ) AS "managedByAccessPackage"
FROM all_memberships am;

-- v4 compat alias for the older view name still referenced in some routes.
CREATE VIEW "vw_UserPermissionAssignments" AS
SELECT
    "resourceId" AS "groupId",
    "principalId" AS "memberId",
    "principalType",
    "membershipType",
    "managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments";

-- AP mapping view: which (user, group) assignments come from which business role.
-- Used by /api/permissions to colour matrix cells by their controlling AP.
CREATE VIEW "vw_UserPermissionAssignmentViaBusinessRole" AS
SELECT
    bru."principalId" AS "userId",
    rr."childResourceId" AS "groupId",
    rr."childResourceId" AS "resourceId",
    rr."parentResourceId" AS "businessRoleId"
FROM "ResourceRelationships" rr
JOIN "ResourceAssignments" bru
  ON bru."resourceId" = rr."parentResourceId"
 AND bru."assignmentType" = 'Governed'
WHERE rr."relationshipType" = 'Contains';

-- Fix: include Governed assignments in the matrix view.
--
-- The original view only included Direct (via recursive CTE), Owner, and
-- Eligible assignments. Governed assignments (business role memberships) were
-- only used as a side-check for the managedByAccessPackage flag but never
-- appeared as actual rows in the matrix. This meant the matrix showed no
-- business-role assignments even when they existed in ResourceAssignments.

CREATE OR REPLACE VIEW "vw_ResourceUserPermissionAssignments" AS
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
    UNION ALL
    SELECT "resourceId", "principalId", "principalType", 'Governed'::TEXT AS "membershipType"
    FROM "ResourceAssignments"
    WHERE "assignmentType" = 'Governed'
)
SELECT
    am."resourceId",
    am."principalId",
    am."principalType",
    am."membershipType",
    (am."membershipType" = 'Governed' OR EXISTS (
        SELECT 1 FROM "ResourceAssignments" rab
        WHERE rab."resourceId" = am."resourceId"
          AND rab."principalId" = am."principalId"
          AND rab."assignmentType" = 'Governed'
    )) AS "managedByAccessPackage"
FROM all_memberships am;

-- Also update the compat alias
CREATE OR REPLACE VIEW "vw_UserPermissionAssignments" AS
SELECT
    "resourceId" AS "groupId",
    "principalId" AS "memberId",
    "principalType",
    "membershipType",
    "managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments";

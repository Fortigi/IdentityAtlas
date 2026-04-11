-- Identity Atlas v5 — AP mapping view (added during smoke testing)
--
-- Used by /api/permissions to colour matrix cells by their controlling business
-- role. Maps each (user, group) direct membership to the business role(s) that
-- granted it via a 'Contains' resource relationship.

DROP VIEW IF EXISTS "vw_UserPermissionAssignmentViaBusinessRole";

CREATE VIEW "vw_UserPermissionAssignmentViaBusinessRole" AS
SELECT
    bru."principalId"     AS "userId",
    rr."childResourceId"  AS "groupId",
    rr."childResourceId"  AS "resourceId",
    rr."parentResourceId" AS "businessRoleId"
FROM "ResourceRelationships" rr
JOIN "ResourceAssignments" bru
  ON bru."resourceId" = rr."parentResourceId"
 AND bru."assignmentType" = 'Governed'
WHERE rr."relationshipType" = 'Contains';

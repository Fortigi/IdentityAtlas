-- 061: a business role also covers its own membership row
--
-- "vw_UserPermissionAssignmentViaBusinessRole" answers one question: which
-- business role(s) account for this (subject, resource) cell? Migration 049
-- built it purely from the `Contains` relationships, so it listed the resources
-- a role grants but never the role itself — even though holding a business role
-- IS governed access (a Direct assignment carrying governed=true, see 049).
--
-- The business role is a resource row in the matrix like any other, so that
-- omission surfaced everywhere the view is the governed signal:
--   * the role's own row rendered ungoverned — no business-role colour on its
--     cells, and it disappeared from the Governed view entirely;
--   * the scope statistics counted every business-role membership as an
--     ungoverned assignment, understating the governed percentage;
--   * a role that grants no resources at all never appeared in the roll-ups.
--
-- Fixed at the source: the view gains a self arm, so every consumer (matrix
-- colouring, the Governed filter, scope statistics, the roll-up builders)
-- agrees without any of them special-casing the role row.

DROP MATERIALIZED VIEW IF EXISTS "vw_UserPermissionAssignmentViaBusinessRole" CASCADE;
CREATE MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole" AS
-- Arm 1 (unchanged): the resources a governance resource Contains.
SELECT
    bru."principalId"     AS "userId",
    rr."childResourceId"  AS "groupId",
    rr."childResourceId"  AS "resourceId",
    rr."parentResourceId" AS "businessRoleId"
FROM "ResourceRelationships" rr
JOIN "Resources" gov
  ON gov.id = rr."parentResourceId" AND gov."governanceResource"
JOIN "ResourceAssignments" bru
  ON bru."resourceId" = rr."parentResourceId"
 AND bru."principalId" IS NOT NULL
 AND bru."deletedAt" IS NULL
WHERE rr."relationshipType" = 'Contains'
UNION
-- Arm 2 (new): the governance resource covers its own membership cell.
SELECT
    bru."principalId" AS "userId",
    gov.id            AS "groupId",
    gov.id            AS "resourceId",
    gov.id            AS "businessRoleId"
FROM "Resources" gov
JOIN "ResourceAssignments" bru
  ON bru."resourceId" = gov.id
 AND bru."principalId" IS NOT NULL
 AND bru."deletedAt" IS NULL
WHERE gov."governanceResource"
WITH NO DATA;

CREATE UNIQUE INDEX "ix_vw_UPABR_pk"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("userId", "groupId", "businessRoleId");
CREATE INDEX "ix_vw_UPABR_userId"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("userId");
CREATE INDEX "ix_vw_UPABR_groupId"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("groupId");

REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole";

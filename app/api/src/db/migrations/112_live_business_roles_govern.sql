-- 112: a business role deleted in the source governs nothing
--
-- Governance coverage answers "which business role accounts for this (subject,
-- resource) cell?" and it is derived in two places that must agree:
--
--   * "vw_UserPermissionAssignmentViaBusinessRole" (migration 061) — the role
--     behind the cell, read by the matrix colouring, the Governed view, the
--     scope statistics and the roll-up builders;
--   * the `soll` CTE inside "vw_ResourceUserPermissionAssignments" (migration
--     049), which stamps `managedByAccessPackage` on every matrix cell.
--
-- Both derivations filtered only the ASSIGNMENT row's "deletedAt", never the
-- governance resource's. "Resources" is a soft-delete table (migration 040), so
-- a business role removed from the source keeps its row with "deletedAt"
-- stamped — and resources and assignments reconcile independently
-- (ingest/reconcileStale.js tombstones each table by its own scope), so a role
-- can be tombstoned while its membership row is still live. Every resource that
-- role Contains then kept the business-role colour, kept counting toward the
-- governed share in the scope statistics, and kept being listed by the Governed
-- view — governance claimed by a role that no longer exists. For an access
-- reviewer that is the worst direction to be wrong in: the access that just
-- lost its control looks like the access that already has one.
--
-- Migration 041 / PR #1484 established this rule for the effective arm ("no
-- current access through a tombstoned row"); it was never applied to the `gov`
-- join. Fixed at the source — both views gain the liveness filter, so every
-- consumer picks it up with no code change:
--
--   1. gov."deletedAt" IS NULL on every arm of both derivations;
--   2. the Contains arm of the coverage matview also joins the CHILD resource
--      and requires it live — a tombstoned group is not covered access either.
--      (The `soll` CTE needs no child filter: it is probed by EXISTS against
--      effective cells, which already exclude deleted resources.)
--
-- "ResourceRelationships" has no "deletedAt" column (040 adds it to Principals,
-- Resources and ResourceAssignments only), so its handling is unchanged.
--
-- A role the source shows again has its "deletedAt" cleared by the upsert, and
-- the next refresh restores its coverage — correct by construction.

-- ── 1. Coverage matview: which live role accounts for this cell ──────────────
DROP MATERIALIZED VIEW IF EXISTS "vw_UserPermissionAssignmentViaBusinessRole" CASCADE;
CREATE MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole" AS
-- Arm 1: the resources a live governance resource Contains.
SELECT
    bru."principalId"     AS "userId",
    rr."childResourceId"  AS "groupId",
    rr."childResourceId"  AS "resourceId",
    rr."parentResourceId" AS "businessRoleId"
FROM "ResourceRelationships" rr
JOIN "Resources" gov
  ON gov.id = rr."parentResourceId"
 AND gov."governanceResource"
 AND gov."deletedAt" IS NULL
JOIN "Resources" child
  ON child.id = rr."childResourceId"
 AND child."deletedAt" IS NULL
JOIN "ResourceAssignments" bru
  ON bru."resourceId" = rr."parentResourceId"
 AND bru."principalId" IS NOT NULL
 AND bru."deletedAt" IS NULL
WHERE rr."relationshipType" = 'Contains'
UNION
-- Arm 2 (061): the governance resource covers its own membership cell.
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
  AND gov."deletedAt" IS NULL
WITH NO DATA;

CREATE UNIQUE INDEX "ix_vw_UPABR_pk"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("userId", "groupId", "businessRoleId");
CREATE INDEX "ix_vw_UPABR_userId"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("userId");
CREATE INDEX "ix_vw_UPABR_groupId"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("groupId");

-- ── 2. Matrix matview: managedByAccessPackage from live coverage only ────────
-- Identical to migration 049 §4 except for gov."deletedAt" IS NULL on both
-- `soll` arms. The wrapper view and all four indexes are recreated with it.
DROP VIEW IF EXISTS "vw_UserPermissionAssignments";
DROP MATERIALIZED VIEW IF EXISTS "vw_ResourceUserPermissionAssignments";

CREATE MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments" AS
WITH effective AS (
    -- principal arm
    SELECT ra."resourceId", ra."principalId", ra."principalType",
        CASE
          WHEN ra."assignmentType" IN ('OAuth2Grant', 'AppRole', 'DirectoryRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                            THEN 'Indirect'
          WHEN ra."assignmentType" = 'DirectoryRoleEligible'                      THEN 'Eligible'
          ELSE ra."assignmentType"
        END AS "membershipType"
    FROM "ResourceAssignments" ra
    WHERE ra."principalId" IS NOT NULL
      AND ra."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Resources"  r WHERE r.id = ra."resourceId"  AND r."deletedAt" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM "Principals" p WHERE p.id = ra."principalId" AND p."deletedAt" IS NOT NULL)
    UNION ALL
    -- identity arm
    SELECT ra."resourceId", im."principalId", NULL AS "principalType",
        CASE
          WHEN ra."assignmentType" IN ('OAuth2Grant', 'AppRole', 'DirectoryRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                            THEN 'Indirect'
          WHEN ra."assignmentType" = 'DirectoryRoleEligible'                      THEN 'Eligible'
          ELSE ra."assignmentType"
        END AS "membershipType"
    FROM "ResourceAssignments" ra
    JOIN "IdentityMembers" im ON im."identityId" = ra."identityId"
    WHERE ra."identityId" IS NOT NULL
      AND ra."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Resources"  r WHERE r.id = ra."resourceId"  AND r."deletedAt" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM "Principals" p WHERE p.id = im."principalId" AND p."deletedAt" IS NOT NULL)
),
-- SOLL: (subject, child resource, expected type) implied by holding a LIVE
-- governance resource that Contains the child.
soll AS (
    SELECT bru."principalId" AS "principalId", rr."childResourceId" AS "resourceId",
           CASE WHEN lower(COALESCE(rr."roleName",'')) LIKE '%eligible%' THEN 'Eligible' ELSE 'Direct' END AS "membershipType"
    FROM "ResourceRelationships" rr
    JOIN "Resources" gov ON gov.id = rr."parentResourceId" AND gov."governanceResource" AND gov."deletedAt" IS NULL
    JOIN "ResourceAssignments" bru ON bru."resourceId" = rr."parentResourceId" AND bru."principalId" IS NOT NULL AND bru."deletedAt" IS NULL
    WHERE rr."relationshipType" = 'Contains'
    UNION
    SELECT im."principalId", rr."childResourceId",
           CASE WHEN lower(COALESCE(rr."roleName",'')) LIKE '%eligible%' THEN 'Eligible' ELSE 'Direct' END
    FROM "ResourceRelationships" rr
    JOIN "Resources" gov ON gov.id = rr."parentResourceId" AND gov."governanceResource" AND gov."deletedAt" IS NULL
    JOIN "ResourceAssignments" bru ON bru."resourceId" = rr."parentResourceId" AND bru."identityId" IS NOT NULL AND bru."deletedAt" IS NULL
    JOIN "IdentityMembers" im ON im."identityId" = bru."identityId"
    WHERE rr."relationshipType" = 'Contains'
),
eff_agg AS (
    SELECT "resourceId", "principalId", "membershipType", MAX("principalType") AS "principalType"
    FROM effective
    GROUP BY "resourceId", "principalId", "membershipType"
)
-- Effective (actual) membership cells only — managed if a LIVE governance
-- resource the subject holds Contains this resource. The provisioning gap (a
-- managed subject/resource with no actual cell here) is derived for the matrix
-- grid from managedByAccessPackage + the absence of an effective cell, so it
-- never inflates the many count/list consumers of this view.
SELECT e."resourceId", e."principalId", e."principalType", e."membershipType",
       EXISTS (SELECT 1 FROM soll s WHERE s."resourceId" = e."resourceId" AND s."principalId" = e."principalId") AS "managedByAccessPackage"
FROM eff_agg e
WITH NO DATA;

CREATE UNIQUE INDEX "ix_vw_ResUserPerm_pk"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId", "principalId", "membershipType");
CREATE INDEX "ix_vw_ResUserPerm_principalId"
    ON "vw_ResourceUserPermissionAssignments" ("principalId");
CREATE INDEX "ix_vw_ResUserPerm_resourceId"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId");
CREATE INDEX "ix_vw_ResUserPerm_direct"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId", "principalId")
    WHERE "membershipType" = 'Direct';

CREATE VIEW "vw_UserPermissionAssignments" AS
SELECT
    "resourceId"            AS "groupId",
    "principalId"           AS "memberId",
    "principalType",
    "membershipType",
    "managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments";

-- ── 3. Populate the freshly-created matviews ────────────────────────────────
REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole";
REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments";

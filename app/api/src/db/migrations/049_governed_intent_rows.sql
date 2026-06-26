-- 049: Governed as an IGA-driven flag + data-derived provisioning gap
--
-- Model: every ResourceAssignments row is an EFFECTIVE assignment (the subject
-- actually holds it). `governed` (migration 047) marks whether that access is
-- driven by a governance structure (an access package / business role / IGA),
-- as opposed to a raw directory grant. The old assignmentType='Governed' value
-- conflated "is a business-role membership" with the type — it is retired here:
-- a business-role membership becomes a normal Direct assignment with
-- governed=true.
--
-- The matview holds ONLY actual membership cells, with managedByAccessPackage
-- flagged when the subject holds a governance resource that Contains the cell's
-- resource. The provisioning gap (a managed subject/resource with no actual
-- cell) is DERIVED for the matrix grid from that flag — keeping it out of the
-- view so it never inflates the view's many count/list consumers. No intent
-- rows are materialised.

-- ── 1. Retire assignmentType='Governed' → Direct membership, governed=true ───
UPDATE "ResourceAssignments" ra
   SET "assignmentType" = 'Direct',
       "governed"       = true,
       "resourceType"   = COALESCE(ra."resourceType", r."resourceType")
  FROM "Resources" r
 WHERE r.id = ra."resourceId"
   AND ra."assignmentType" = 'Governed';

-- ── 2. Index supporting the governed flag ───────────────────────────────────
DROP INDEX IF EXISTS "ix_RA_governed";
CREATE INDEX "ix_RA_governed"
    ON "ResourceAssignments" ("resourceId", "principalId")
    WHERE "governed" = true;

-- ── 3. Business-role mapping matview: who is covered by which governance res ──
-- A subject holds a governance resource (business role / access package) that
-- Contains a child resource → that child membership is "managed by" the
-- governance resource. Drives the matrix AP colouring + the SOLL side.
DROP MATERIALIZED VIEW IF EXISTS "vw_UserPermissionAssignmentViaBusinessRole" CASCADE;
CREATE MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole" AS
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
WITH NO DATA;

CREATE UNIQUE INDEX "ix_vw_UPABR_pk"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("userId", "groupId", "businessRoleId");
CREATE INDEX "ix_vw_UPABR_userId"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("userId");
CREATE INDEX "ix_vw_UPABR_groupId"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("groupId");

-- ── 4. Main matrix matview: effective cells + derived gap cells ──────────────
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
-- SOLL: (subject, child resource, expected type) implied by holding a
-- governance resource that Contains the child.
soll AS (
    SELECT bru."principalId" AS "principalId", rr."childResourceId" AS "resourceId",
           CASE WHEN lower(COALESCE(rr."roleName",'')) LIKE '%eligible%' THEN 'Eligible' ELSE 'Direct' END AS "membershipType"
    FROM "ResourceRelationships" rr
    JOIN "Resources" gov ON gov.id = rr."parentResourceId" AND gov."governanceResource"
    JOIN "ResourceAssignments" bru ON bru."resourceId" = rr."parentResourceId" AND bru."principalId" IS NOT NULL AND bru."deletedAt" IS NULL
    WHERE rr."relationshipType" = 'Contains'
    UNION
    SELECT im."principalId", rr."childResourceId",
           CASE WHEN lower(COALESCE(rr."roleName",'')) LIKE '%eligible%' THEN 'Eligible' ELSE 'Direct' END
    FROM "ResourceRelationships" rr
    JOIN "Resources" gov ON gov.id = rr."parentResourceId" AND gov."governanceResource"
    JOIN "ResourceAssignments" bru ON bru."resourceId" = rr."parentResourceId" AND bru."identityId" IS NOT NULL AND bru."deletedAt" IS NULL
    JOIN "IdentityMembers" im ON im."identityId" = bru."identityId"
    WHERE rr."relationshipType" = 'Contains'
),
eff_agg AS (
    SELECT "resourceId", "principalId", "membershipType", MAX("principalType") AS "principalType"
    FROM effective
    GROUP BY "resourceId", "principalId", "membershipType"
)
-- Effective (actual) membership cells only — managed if a governance resource
-- the subject holds Contains this resource. The provisioning gap (a managed
-- subject/resource with no actual cell here) is derived for the matrix grid
-- from managedByAccessPackage + the absence of an effective cell, so it never
-- inflates the many count/list consumers of this view.
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

-- ── 5. Populate the freshly-created matviews ─────────────────────────────────
REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole";
REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments";

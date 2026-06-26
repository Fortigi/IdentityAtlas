-- 049: Governed-intent two-row model (retires assignmentType='Governed')
--
-- Before: a user→business-role membership was stored as a single
-- ResourceAssignments row with assignmentType='Governed' on the business-role
-- (access-package) resource, and the matrix computed "managed by access
-- package" + the provisioning gap CLIENT-SIDE from the Contains relationships.
--
-- After:
--   1. The user→business-role membership becomes a real Direct assignment to
--      the governance resource (governed=false) — the *actual* AP membership.
--   2. For every group the business role Contains, a governed=true *intent* row
--      is written on the GROUP (the SOLL). It carries the granting
--      business-role id(s) in extendedAttributes.businessRoleIds so multiple
--      packages granting one cell collapse to one row but keep the AP list.
--   3. The matrix matview derives managedByAccessPackage + provisioningGap from
--      the governed flag (intent without a matching actual = gap).
--
-- Existing 'Governed' rows are migrated in place below; the crawlers emit the
-- new shape directly.

-- ── 1. Materialise governed-intent rows from existing Governed + Contains ────
-- Runs BEFORE the Governed→Direct conversion so the governance memberships are
-- still identifiable by assignmentType='Governed'. Two arms: principal-based
-- (Entra access packages) and identity-based (midPoint/Omada roles, which key
-- the governance assignment on identityId). Multiple packages granting one
-- (subject, group, how) collapse to one row whose businessRoleIds lists them.
INSERT INTO "ResourceAssignments"
    ("resourceId", "principalId", "identityId", "assignmentType", "governed",
     "resourceType", "systemId", "extendedAttributes")
SELECT
    x."resourceId", x."principalId", x."identityId", x."assignmentType", true,
    x."resourceType", x."systemId",
    jsonb_build_object('businessRoleIds', to_jsonb(x."businessRoleIds"))
FROM (
    -- principal-based governance memberships
    SELECT
        rr."childResourceId"                                        AS "resourceId",
        bru."principalId"                                           AS "principalId",
        NULL::uuid                                                  AS "identityId",
        CASE WHEN lower(COALESCE(rr."roleName", '')) LIKE '%eligible%'
             THEN 'Eligible' ELSE 'Direct' END                     AS "assignmentType",
        g."resourceType"                                            AS "resourceType",
        bru."systemId"                                              AS "systemId",
        array_agg(DISTINCT rr."parentResourceId")                  AS "businessRoleIds"
    FROM "ResourceRelationships" rr
    JOIN "ResourceAssignments" bru
      ON bru."resourceId"     = rr."parentResourceId"
     AND bru."assignmentType" = 'Governed'
     AND bru."principalId" IS NOT NULL
     AND bru."deletedAt" IS NULL
    JOIN "Resources" g ON g.id = rr."childResourceId"
    WHERE rr."relationshipType" = 'Contains'
    GROUP BY rr."childResourceId", bru."principalId",
             CASE WHEN lower(COALESCE(rr."roleName", '')) LIKE '%eligible%'
                  THEN 'Eligible' ELSE 'Direct' END,
             g."resourceType", bru."systemId"

    UNION ALL

    -- identity-based governance memberships (midPoint / Omada)
    SELECT
        rr."childResourceId",
        NULL::uuid,
        bru."identityId",
        CASE WHEN lower(COALESCE(rr."roleName", '')) LIKE '%eligible%'
             THEN 'Eligible' ELSE 'Direct' END,
        g."resourceType",
        bru."systemId",
        array_agg(DISTINCT rr."parentResourceId")
    FROM "ResourceRelationships" rr
    JOIN "ResourceAssignments" bru
      ON bru."resourceId"     = rr."parentResourceId"
     AND bru."assignmentType" = 'Governed'
     AND bru."identityId" IS NOT NULL
     AND bru."principalId" IS NULL
     AND bru."deletedAt" IS NULL
    JOIN "Resources" g ON g.id = rr."childResourceId"
    WHERE rr."relationshipType" = 'Contains'
    GROUP BY rr."childResourceId", bru."identityId",
             CASE WHEN lower(COALESCE(rr."roleName", '')) LIKE '%eligible%'
                  THEN 'Eligible' ELSE 'Direct' END,
             g."resourceType", bru."systemId"
) x
ON CONFLICT DO NOTHING;

-- ── 2. Convert the user→business-role membership to a real Direct assignment ─
UPDATE "ResourceAssignments" ra
   SET "assignmentType" = 'Direct',
       "governed"       = false,
       "resourceType"   = COALESCE(ra."resourceType", r."resourceType")
  FROM "Resources" r
 WHERE r.id = ra."resourceId"
   AND ra."assignmentType" = 'Governed';

-- ── 3. Dashboard / lookup index now keys on the governed flag ───────────────
DROP INDEX IF EXISTS "ix_RA_governed";
CREATE INDEX "ix_RA_governed"
    ON "ResourceAssignments" ("resourceId", "principalId")
    WHERE "governed" = true;

-- ── 4. Rebuild the business-role mapping matview from governed-intent rows ───
-- Unnest the granting business-role list so (user, group, businessRole) rows
-- match the previous shape exactly (apColor / apCount / apNames keep working).
DROP MATERIALIZED VIEW IF EXISTS "vw_UserPermissionAssignmentViaBusinessRole" CASCADE;
CREATE MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole" AS
SELECT
    ra."principalId"   AS "userId",
    ra."resourceId"    AS "groupId",
    ra."resourceId"    AS "resourceId",
    br_id::uuid        AS "businessRoleId"
FROM "ResourceAssignments" ra
CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(ra."extendedAttributes"::jsonb -> 'businessRoleIds', '[]'::jsonb)) AS br_id
WHERE ra."governed" = true
  AND ra."principalId" IS NOT NULL
  AND ra."deletedAt" IS NULL
WITH NO DATA;

CREATE UNIQUE INDEX "ix_vw_UPABR_pk"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("userId", "groupId", "businessRoleId");
CREATE INDEX "ix_vw_UPABR_userId"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("userId");
CREATE INDEX "ix_vw_UPABR_groupId"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("groupId");

-- ── 5. Rebuild the main matrix matview: managed + gap from the governed flag ─
DROP VIEW IF EXISTS "vw_UserPermissionAssignments";
DROP MATERIALIZED VIEW IF EXISTS "vw_ResourceUserPermissionAssignments";

CREATE MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments" AS
WITH collapsed AS (
    -- principal arm
    SELECT
        ra."resourceId",
        ra."principalId",
        ra."principalType",
        CASE
          WHEN ra."assignmentType" IN ('OAuth2Grant', 'AppRole', 'DirectoryRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                            THEN 'Indirect'
          WHEN ra."assignmentType" = 'DirectoryRoleEligible'                      THEN 'Eligible'
          ELSE ra."assignmentType"
        END AS "membershipType",
        ra."governed"
    FROM "ResourceAssignments" ra
    WHERE ra."principalId" IS NOT NULL
      AND ra."deletedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Resources"  r WHERE r.id = ra."resourceId"  AND r."deletedAt" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM "Principals" p WHERE p.id = ra."principalId" AND p."deletedAt" IS NOT NULL)

    UNION ALL

    -- identity arm expanded through IdentityMembers
    SELECT
        ra."resourceId",
        im."principalId",
        NULL AS "principalType",
        CASE
          WHEN ra."assignmentType" IN ('OAuth2Grant', 'AppRole', 'DirectoryRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                            THEN 'Indirect'
          WHEN ra."assignmentType" = 'DirectoryRoleEligible'                      THEN 'Eligible'
          ELSE ra."assignmentType"
        END AS "membershipType",
        ra."governed"
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
    MAX("principalType")                                    AS "principalType",
    "membershipType",
    -- a governed=true intent row exists for this cell → governed by a package
    bool_or("governed")                                    AS "managedByAccessPackage",
    -- intent exists but no matching actual membership → provisioning gap
    (bool_or("governed") AND NOT bool_or(NOT "governed"))  AS "provisioningGap",
    -- at least one real (non-intent) membership → render the badge
    bool_or(NOT "governed")                                AS "isActualMembership"
FROM collapsed
GROUP BY "resourceId", "principalId", "membershipType"
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
    "managedByAccessPackage",
    "provisioningGap",
    "isActualMembership"
FROM "vw_ResourceUserPermissionAssignments";

-- ── 6. Populate the freshly-created matviews (first refresh is non-concurrent) ─
REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole";
REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments";

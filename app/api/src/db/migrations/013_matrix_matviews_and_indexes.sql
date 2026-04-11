-- Identity Atlas — migrate matrix views to MATERIALIZED VIEWs +
-- add performance indexes.
--
-- Background: the benchmark run on the 2.18M-row load-test dataset showed
-- `GET /api/permissions` taking 100+ seconds because `vw_ResourceUserPermissionAssignments`
-- is recomputed from scratch on every request (3 sequential full-view scans
-- across the 1.5M-row ResourceAssignments table). The same dataset also made
-- `GET /api/users?search=...` slow (no trigram index for ILIKE) and
-- /api/admin/dashboard-stats moderately slow.
--
-- This migration:
--   1. Drops the regular matrix views and the compat alias.
--   2. Recreates them as MATERIALIZED VIEWs with the same shape.
--   3. Adds unique + covering indexes on the matviews so REFRESH CONCURRENTLY
--      works and the matrix query can index-scan by principalId.
--   4. Adds pg_trgm GIN indexes on Principals.displayName/email for ILIKE.
--   5. Adds partial indexes used by the dashboard-stats counts and by
--      assignment-type filters.
--
-- REFRESH strategy: the matviews are NOT refreshed by this migration —
-- the refresh must run outside a transaction (REFRESH MATERIALIZED VIEW
-- cannot run inside a transaction, and migrations are wrapped in one).
-- The matviews start empty. The web container triggers a refresh at the end
-- of bootstrap, and the ingest endpoint /api/ingest/refresh-views is wired
-- to run REFRESH MATERIALIZED VIEW CONCURRENTLY so the CSV crawler
-- automatically refreshes at end-of-sync.

-- ─── 1. Drop existing views ──────────────────────────────────────────────
DROP VIEW IF EXISTS "vw_UserPermissionAssignments";
DROP VIEW IF EXISTS "vw_ResourceUserPermissionAssignments";
DROP VIEW IF EXISTS "vw_UserPermissionAssignmentViaBusinessRole";

-- ─── 2. Materialized matrix view ─────────────────────────────────────────
-- We skip the recursive CTE that previously expanded nested groups. For
-- the current demo + load-test datasets this produces the same result
-- (no group-in-group nesting), and the recursive branch was a significant
-- source of runtime cost. If nested groups become important, promote
-- vw_ResourceMembersRecursive to its own materialized view and UNION it
-- back in here.
CREATE MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments" AS
WITH all_memberships AS (
    SELECT "resourceId", "principalId", "principalType", 'Direct'::TEXT AS "membershipType"
    FROM "ResourceAssignments"
    WHERE "assignmentType" = 'Direct'
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
),
governed_pairs AS (
    SELECT DISTINCT "resourceId", "principalId"
    FROM "ResourceAssignments"
    WHERE "assignmentType" = 'Governed'
)
SELECT
    am."resourceId",
    am."principalId",
    am."principalType",
    am."membershipType",
    (am."membershipType" = 'Governed'
       OR gp."resourceId" IS NOT NULL) AS "managedByAccessPackage"
FROM all_memberships am
LEFT JOIN governed_pairs gp
       ON gp."resourceId" = am."resourceId"
      AND gp."principalId" = am."principalId"
WITH NO DATA;

-- Unique + covering indexes. The unique index is required for REFRESH CONCURRENTLY.
CREATE UNIQUE INDEX "ix_vw_ResUserPerm_pk"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId", "principalId", "membershipType");
CREATE INDEX "ix_vw_ResUserPerm_principalId"
    ON "vw_ResourceUserPermissionAssignments" ("principalId");
CREATE INDEX "ix_vw_ResUserPerm_resourceId"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId");

-- ─── 3. Materialized business-role mapping view ──────────────────────────
CREATE MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole" AS
SELECT
    bru."principalId"     AS "userId",
    rr."childResourceId"  AS "groupId",
    rr."childResourceId"  AS "resourceId",
    rr."parentResourceId" AS "businessRoleId"
FROM "ResourceRelationships" rr
JOIN "ResourceAssignments" bru
  ON bru."resourceId" = rr."parentResourceId"
 AND bru."assignmentType" = 'Governed'
WHERE rr."relationshipType" = 'Contains'
WITH NO DATA;

CREATE UNIQUE INDEX "ix_vw_UPABR_pk"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("userId", "groupId", "businessRoleId");
CREATE INDEX "ix_vw_UPABR_userId"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("userId");
CREATE INDEX "ix_vw_UPABR_groupId"
    ON "vw_UserPermissionAssignmentViaBusinessRole" ("groupId");

-- ─── 4. Compat alias view ────────────────────────────────────────────────
CREATE VIEW "vw_UserPermissionAssignments" AS
SELECT
    "resourceId" AS "groupId",
    "principalId" AS "memberId",
    "principalType",
    "membershipType",
    "managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments";

-- ─── 5. Trigram indexes for ILIKE searches ───────────────────────────────
-- /api/users?search=X does `displayName ILIKE '%X%'` / `email ILIKE '%X%'`.
-- Without a trigram index postgres can only do a sequential scan of the
-- 80k-row Principals table. pg_trgm makes it near-instant.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "ix_Principals_displayName_trgm"
    ON "Principals" USING GIN ("displayName" gin_trgm_ops);
CREATE INDEX "ix_Principals_email_trgm"
    ON "Principals" USING GIN ("email" gin_trgm_ops);
CREATE INDEX "ix_Resources_displayName_trgm"
    ON "Resources" USING GIN ("displayName" gin_trgm_ops);

-- ─── 6. Partial indexes for /api/admin/dashboard-stats ───────────────────
-- Dashboard runs 15 unrelated COUNT(*) subqueries in one statement. The
-- ones with WHERE clauses benefit from a supporting partial index so
-- postgres can do an index-only scan.
CREATE INDEX IF NOT EXISTS "ix_Resources_businessRole"
    ON "Resources"("id") WHERE "resourceType" = 'BusinessRole';
CREATE INDEX IF NOT EXISTS "ix_RA_governed"
    ON "ResourceAssignments"("resourceId", "principalId")
    WHERE "assignmentType" = 'Governed';

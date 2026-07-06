-- Identity Atlas — DB-level value guards for the universal data model.
--
-- These constraints move two data-model invariants from "enforced only by the
-- ingest API + a static crawler scan" down into the database, so they also hold
-- for any write that never goes through the ingest layer — a future SQL
-- migration, a manual backfill, a direct psql connection. That path was
-- previously unguarded: the columns are plain TEXT and a raw
-- `UPDATE ... SET "assignmentType" = 'Owner'` would have been accepted silently.
--
-- Prior migrations already normalised every existing row, so these apply cleanly:
--   * assignmentType: 044a/045 collapsed OAuth2Grant/AppRole/DirectoryRole/
--     AppRoleViaGroup/DirectoryRoleEligible; 046 converted Owner; 049 converted
--     Governed — leaving only Direct/Indirect/Eligible.
--   * resourceType:  052 renamed EntraGroup -> Group and EntraRole -> EntraDirectoryRole.
--
-- assignmentType is a CLOSED set of three values -> allow-list CHECK.
-- resourceType is an OPEN vocabulary (each connected system names its own types;
--   CSV / custom-connector / OData imports supply arbitrary values such as
--   SAPRole, AzureRoleAssignment, Service, Entitlement), so a strict allow-list
--   would reject legitimate types. We only FORBID the two retired Entra-era
--   literals. NULL is permitted — migration 044 leaves orphan assignment rows'
--   resourceType NULL and the Resources column is nullable.
--
-- Idempotent via DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT (repo house style,
-- see migration 006).

-- 1. assignmentType — only the three universal "how does this principal have it" values.
ALTER TABLE "ResourceAssignments"
  DROP CONSTRAINT IF EXISTS "ck_RA_assignmentType";
ALTER TABLE "ResourceAssignments"
  ADD CONSTRAINT "ck_RA_assignmentType"
  CHECK ("assignmentType" IN ('Direct', 'Indirect', 'Eligible'));

-- 2. resourceType — must never re-introduce the renamed Entra-era literals (open
--    vocabulary otherwise; NULL allowed).
ALTER TABLE "Resources"
  DROP CONSTRAINT IF EXISTS "ck_Resources_resourceType_not_retired";
ALTER TABLE "Resources"
  ADD CONSTRAINT "ck_Resources_resourceType_not_retired"
  CHECK ("resourceType" IS NULL OR "resourceType" NOT IN ('EntraGroup', 'EntraRole'));

ALTER TABLE "ResourceAssignments"
  DROP CONSTRAINT IF EXISTS "ck_RA_resourceType_not_retired";
ALTER TABLE "ResourceAssignments"
  ADD CONSTRAINT "ck_RA_resourceType_not_retired"
  CHECK ("resourceType" IS NULL OR "resourceType" NOT IN ('EntraGroup', 'EntraRole'));

-- Resource-type naming cleanup, part 2: 'EntraAppRole' -> 'AppRole'.
--
-- Migration 052 de-prefixed the types that baked the source system into the type
-- name (EntraGroup -> Group, EntraRole -> EntraDirectoryRole) on the rule that
-- resourceType describes the KIND of resource — which system it came from is
-- Resources.systemId's job. 052's own rationale lists AppRole among the types
-- that are already correctly unprefixed and shared across crawlers, but the
-- rename itself missed 'EntraAppRole', which the demo dataset kept emitting.
--
-- Not cosmetic. The Entra crawler emits resourceType = 'AppRole'
-- (EntraIDCrawler.Phases.ps1), and contexts/plugins/risky-consent.js filters on
-- ['DelegatedPermission', 'AppRole'] — so an 'EntraAppRole' row is invisible to
-- that plugin, and demo data behaves differently from a real tenant. Nothing
-- caught it because resourceType is deliberately an OPEN vocabulary (CSV /
-- custom-connector / OData / Omada / midPoint / Azure supply arbitrary values),
-- so there is no allow-list to fail against — only 054's negative guard, which
-- named just the two literals 052 renamed.
--
-- resourceType is denormalised onto ResourceAssignments (migration 044), so both
-- tables are rewritten — same as 052.
--
-- No matview work: as in 052, the matrix matviews key on assignmentType and do
-- not carry resourceType, so nothing needs rebuilding or refreshing.

-- 1. Rewrite the data FIRST. Tightening the CHECK below before this would make
--    the constraint reject the very rows this migration exists to fix.
UPDATE "Resources"           SET "resourceType" = 'AppRole' WHERE "resourceType" = 'EntraAppRole';
UPDATE "ResourceAssignments" SET "resourceType" = 'AppRole' WHERE "resourceType" = 'EntraAppRole';

-- 2. Extend 054's negative guard so the literal cannot return on any write path.
--    resourceType stays an OPEN vocabulary — this is a NOT IN (a deny-list), never
--    an allow-list, and NULL stays legal (migration 044 leaves orphan assignment
--    rows' resourceType NULL). Idempotent via DROP IF EXISTS + ADD (house style,
--    see migration 006).
ALTER TABLE "Resources"
  DROP CONSTRAINT IF EXISTS "ck_Resources_resourceType_not_retired";
ALTER TABLE "Resources"
  ADD CONSTRAINT "ck_Resources_resourceType_not_retired"
  CHECK ("resourceType" IS NULL OR "resourceType" NOT IN ('EntraGroup', 'EntraRole', 'EntraAppRole'));

ALTER TABLE "ResourceAssignments"
  DROP CONSTRAINT IF EXISTS "ck_RA_resourceType_not_retired";
ALTER TABLE "ResourceAssignments"
  ADD CONSTRAINT "ck_RA_resourceType_not_retired"
  CHECK ("resourceType" IS NULL OR "resourceType" NOT IN ('EntraGroup', 'EntraRole', 'EntraAppRole'));

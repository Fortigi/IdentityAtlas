-- Identity Atlas — governance catalogs become contexts
--
-- A catalog (an Entra ID access package catalog, another IGA source's grouping
-- of business roles) is a named grouping of resources that the source delivers:
-- a synced context. It had a table of its own ("GovernanceCatalogs", from before
-- Contexts existed) and a single "Resources"."catalogId" pointer, which could
-- not say who answers for a catalog and could not put a resource in two.
--
-- From here on a catalog is a synced context of the new template Catalog
-- (targetType Resource, its members the business roles it groups); the source's
-- own catalog properties sit in its extendedAttributes. The template is also a
-- role-bearing one, so a catalog's owners become its Accountable / Responsible.
--
-- The old catalog rows are dropped, not converted: the next crawl of the source
-- writes them again as contexts. History rows already recorded for the table
-- stay in "_history" as they are.

-- ─── 1. The template ─────────────────────────────────────────────────────────
-- The CHECK from migration 095 was created inline on ADD COLUMN, so PostgreSQL
-- named it <table>_<column>_check.
ALTER TABLE "Contexts" DROP CONSTRAINT IF EXISTS "Contexts_contextCategory_check";
ALTER TABLE "Contexts"
  ADD CONSTRAINT "Contexts_contextCategory_check"
    CHECK ("contextCategory" IN ('OrganizationalUnit', 'LogicalApplication', 'Tag', 'Segment', 'Catalog'));

-- ─── 2. The old catalog model goes ───────────────────────────────────────────
DROP INDEX IF EXISTS "ix_Resources_catalogId";
ALTER TABLE "Resources" DROP COLUMN IF EXISTS "catalogId";
DROP TABLE IF EXISTS "GovernanceCatalogs";

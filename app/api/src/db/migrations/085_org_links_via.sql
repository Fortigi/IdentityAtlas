-- Migration 085: a link remembers which attribute produced it.
--
-- A link rule links an organisation entity THROUGH one of its attributes:
-- "eigenaar" → an account, "team" (a cell listing several people) → several
-- accounts, the entity's own name → a resource. The link row therefore carries
--   "via"       the attribute the rule linked through ('displayName' for the entity itself)
--   "orgValue"  the value of that attribute that matched (one of several, for a list cell)
-- so a re-run can tell an analyst's confirmed owner from an engine-found team
-- member, and the UI can say "linked through team".
--
-- Nullable, no default, no backfill: links written before this migration have
-- NULL here and are treated as "via the whole entity".

ALTER TABLE "OrgLinks" ADD COLUMN IF NOT EXISTS "via"      TEXT;
ALTER TABLE "OrgLinks" ADD COLUMN IF NOT EXISTS "orgValue" TEXT;

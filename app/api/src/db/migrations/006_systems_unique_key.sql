-- Identity Atlas v5 — additional indexes/constraints found during smoke testing.
--
-- The ingest engine for the `systems` entity uses (systemType, tenantId) as the
-- conflict target for upserts (see ENTITY_KEY_MAP in ingest/validation.js).
-- The base schema declared `id` as the SERIAL primary key but didn't add the
-- alternate-key constraint, so ON CONFLICT (systemType, tenantId) failed with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
-- A real unique constraint is required (not just a unique index on an expression).

ALTER TABLE "Systems"
  DROP CONSTRAINT IF EXISTS "uq_Systems_systemType_tenantId";

ALTER TABLE "Systems"
  ADD CONSTRAINT "uq_Systems_systemType_tenantId"
  UNIQUE ("systemType", "tenantId");

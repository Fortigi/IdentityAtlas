-- Add a UUID surrogate id to ResourceAssignments and ResourceRelationships so
-- the audit history trigger can record per-row changes.
--
-- Context (April 2026): the audit trigger function fg_record_history() keys
-- every history row by `rowId := NEW->>'id'`. ResourceAssignments and
-- ResourceRelationships were created with composite primary keys and no `id`
-- column, so the trigger silently skipped them for every insert/update —
-- meaning these two high-churn tables had NO audit trail at all. The Access
-- Package detail page relied on this history to show an "assigned on" date,
-- and always came up blank.
--
-- The surrogate is added as a separate UNIQUE column rather than replacing the
-- composite primary key. Upserts still use the natural key for idempotency
-- (crawlers don't have the surrogate when they build a record); the surrogate
-- exists only to give the audit trigger a stable per-row handle.

ALTER TABLE "ResourceAssignments"
    ADD COLUMN IF NOT EXISTS "id" UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE "ResourceRelationships"
    ADD COLUMN IF NOT EXISTS "id" UUID NOT NULL DEFAULT gen_random_uuid();

-- Unique surrogate lets _history.rowId be joined back to the live row, and
-- also protects against the (astronomically unlikely) case of a UUID
-- collision during a re-sync.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_ResourceAssignments_id') THEN
        ALTER TABLE "ResourceAssignments" ADD CONSTRAINT "uq_ResourceAssignments_id" UNIQUE ("id");
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_ResourceRelationships_id') THEN
        ALTER TABLE "ResourceRelationships" ADD CONSTRAINT "uq_ResourceRelationships_id" UNIQUE ("id");
    END IF;
END $$;

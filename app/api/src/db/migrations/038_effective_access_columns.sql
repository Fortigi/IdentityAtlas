-- Identity Atlas — effect + propagationScope on ResourceAssignments; capabilityId on Resources.
--
-- Groundwork for the effective-access engine (docs/architecture/effective-access-engine.md §6, §13.6).
-- Adds the two resolution hot-path columns the engine reads when gathering ACEs, plus an
-- indexable generated column exposing capabilityId out of Resources.extendedAttributes.
--
-- Backfill is non-destructive. Existing rows become effect='allow' EXCEPT rows whose
-- assignmentType='Eligible', which become effect='eligible' so eligible-only (PIM) access is
-- not surfaced as currently-granted access (spec §17). propagationScope defaults to
-- 'selfAndDescendants' — the Azure-RBAC-style "applies at the node and below" — matching the
-- implicit semantics of every assignment written before this migration.
--
-- Migrations run at web boot before API traffic; the brief table rewrite/lock is acceptable.

-- 1. effect — allow | deny | eligible | notset. Read on every gather.
ALTER TABLE "ResourceAssignments"
    ADD COLUMN "effect" TEXT;

-- 2. propagationScope — self | descendants | selfAndDescendants.
ALTER TABLE "ResourceAssignments"
    ADD COLUMN "propagationScope" TEXT;

-- 3. Backfill. Eligible -> 'eligible' (potential access, excluded from effective answers);
--    everything else -> 'allow' (a concrete grant).
UPDATE "ResourceAssignments"
SET "effect" = CASE WHEN "assignmentType" = 'Eligible' THEN 'eligible' ELSE 'allow' END
WHERE "effect" IS NULL;

UPDATE "ResourceAssignments"
SET "propagationScope" = 'selfAndDescendants'
WHERE "propagationScope" IS NULL;

-- 4. Defaults for future inserts, then NOT NULL now that every row is populated.
ALTER TABLE "ResourceAssignments"
    ALTER COLUMN "effect" SET DEFAULT 'allow',
    ALTER COLUMN "effect" SET NOT NULL,
    ALTER COLUMN "propagationScope" SET DEFAULT 'selfAndDescendants',
    ALTER COLUMN "propagationScope" SET NOT NULL;

-- 5. Value guards. Kept to the documented vocabulary; the engine validates semantics.
ALTER TABLE "ResourceAssignments"
    ADD CONSTRAINT "ck_RA_effect"
    CHECK ("effect" IN ('allow', 'deny', 'eligible', 'notset'));

ALTER TABLE "ResourceAssignments"
    ADD CONSTRAINT "ck_RA_propagationScope"
    CHECK ("propagationScope" IN ('self', 'descendants', 'selfAndDescendants'));

-- 6. Index for effect-filtered / deny-presence gather (spec §13.6).
CREATE INDEX "ix_RA_resourceId_effect"
    ON "ResourceAssignments"("resourceId", "effect");

-- 7. capabilityId — generated stored column surfacing the JSONB attribute the engine reads in
--    the resolution inner loop, so it can be indexed (spec §13.6 / §15.9). '->>' on jsonb is
--    immutable, which a STORED generated column requires.
ALTER TABLE "Resources"
    ADD COLUMN "capabilityId" TEXT
    GENERATED ALWAYS AS (("extendedAttributes" ->> 'capabilityId')) STORED;

CREATE INDEX "ix_Resources_capabilityId"
    ON "Resources"("capabilityId")
    WHERE "capabilityId" IS NOT NULL;

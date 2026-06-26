-- Assignment-model redesign — label governance resources generically.
-- See docs/architecture/assignment-model-redesign.md.
--
-- The matrix is two matrices sharing the resource rows: subjects × resources
-- (the IST / actual access) and resources × governance-constructs (the SOLL —
-- which business role / access package grants each resource). The SOLL side was
-- identified implicitly (a separate endpoint + hardcoded knowledge that
-- "BusinessRole" is the governance type). Mark it in the data instead, with a
-- generic flag (no system-specific term like "access package"): a governance
-- resource is one that GOVERNS other access (Entra access packages, Omada/
-- midPoint business roles, … — all already stored as resourceType='BusinessRole').
--
-- Distinct from ResourceAssignments.governed (migration 047): that flags an
-- assignment as a governed-intent; this flags a resource as a governance
-- construct (the governor). Non-key column, so no ingest-key impact.

ALTER TABLE "Resources" ADD COLUMN IF NOT EXISTS "governanceResource" boolean NOT NULL DEFAULT false;

-- Backfill: every existing governance construct is resourceType='BusinessRole'.
UPDATE "Resources" SET "governanceResource" = true
 WHERE "resourceType" = 'BusinessRole' AND "governanceResource" IS DISTINCT FROM true;

CREATE INDEX IF NOT EXISTS "ix_Resources_governanceResource"
    ON "Resources" ("governanceResource") WHERE "governanceResource";

-- Assignment-model redesign — Phase 3 (governed), foundation.
-- See docs/architecture/assignment-model-redesign.md.
--
-- Add an explicit `governed` flag to ResourceAssignments and make it part of the
-- assignment identity, so the SAME (resource, principal, how) can hold TWO rows:
--   * governed=false — the ACTUAL assignment (a directory / system-of-record fact)
--   * governed=true  — the GOVERNED-INTENT (an IGA source says it should exist)
--
-- A provisioning gap then becomes "a governed-intent row with no matching actual
-- row" — derived from data in the matview instead of computed client-side. The
-- two facts may eventually come from different crawlers (IGA governs, directory
-- realizes), so they are separate rows owned/reconciled independently. (Cross-
-- system resource correlation is future work; this phase is Entra-internal.)
--
-- Inert on its own: every existing row defaults to governed=false, so the
-- extended unique key has identical uniqueness to before, and nothing reads the
-- flag yet. The crawler/matview/UI changes land in the follow-up.

ALTER TABLE "ResourceAssignments" ADD COLUMN IF NOT EXISTS "governed" boolean NOT NULL DEFAULT false;

-- Extend the two partial unique indexes (migration 036) to include governed, so
-- the actual + governed-intent rows can coexist for one (resource, principal, how).
-- The partial predicates are unchanged, so the ingest ON CONFLICT / scoped delete
-- (which pass them as conflictFilter / scopeDeleteFilter) keep resolving correctly.
DROP INDEX IF EXISTS "uq_RA_principal";
DROP INDEX IF EXISTS "uq_RA_identity";
CREATE UNIQUE INDEX "uq_RA_principal"
    ON "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "governed")
    WHERE "principalId" IS NOT NULL;
CREATE UNIQUE INDEX "uq_RA_identity"
    ON "ResourceAssignments" ("resourceId", "identityId", "assignmentType", "governed")
    WHERE "identityId" IS NOT NULL;

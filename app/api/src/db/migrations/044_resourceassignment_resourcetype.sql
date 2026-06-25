-- Assignment-model redesign — Phase 1 foundation (data only, no behaviour change).
-- See docs/architecture/assignment-model-redesign.md.
--
-- Today `ResourceAssignments.assignmentType` is overloaded: besides the
-- membership "how" (Direct/Indirect/Eligible/Owner) it is ALSO the full-sync
-- reconcile-delete partition key (each crawler phase sends a distinct
-- assignmentType so its delete only wipes its own rows — see
-- engine.js scopedDelete + ENTITY_SCOPE_MAP). That coupling is why the source
-- types (AppRole/OAuth2Grant/DirectoryRole/…) exist and why the matrix has to
-- collapse them back with a fragile CASE.
--
-- This migration denormalises `resourceType` onto ResourceAssignments so a later
-- phase can move the delete partition onto the resource axis and collapse
-- assignmentType to the three universal values. It is deliberately inert:
--   * the column is backfilled from Resources for existing rows;
--   * NOTHING reads or partitions on it yet (crawlers still scope deletes by
--     assignmentType — they start sending resourceType in a later PR);
--   * the matrix matview is untouched.

ALTER TABLE "ResourceAssignments" ADD COLUMN IF NOT EXISTS "resourceType" text;

-- Backfill from the owning resource. Rows whose resourceId has no matching
-- Resource (orphans) are left NULL.
UPDATE "ResourceAssignments" ra
   SET "resourceType" = r."resourceType"
  FROM "Resources" r
 WHERE r.id = ra."resourceId"
   AND ra."resourceType" IS DISTINCT FROM r."resourceType";

-- Partition index for the future resource-axis reconcile delete
-- (WHERE systemId = ? AND resourceType = ? AND assignmentType = ?).
CREATE INDEX IF NOT EXISTS "ix_ResourceAssignments_partition"
    ON "ResourceAssignments" ("systemId", "resourceType", "assignmentType");

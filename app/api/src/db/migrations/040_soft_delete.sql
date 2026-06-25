-- Identity Atlas v5 — soft-delete (lifecycle) for principals, resources, assignments.
--
-- Instead of hard-deleting entities that disappear from a source system (Graph
-- /delta @removed, or absence on a full sync), the ingest engine now stamps
-- "deletedAt". The row is kept so leavers / deleted resources stay auditable and
-- cross-system references (e.g. an Azure RM assignment to an Entra-deleted SP)
-- don't dangle. A later crawl that re-sees the entity clears deletedAt
-- (re-activation). A purge job finalises tombstones older than the configured
-- retention.
--
-- "Live" views filter `deletedAt IS NULL`; an "include deleted" path reveals them.
-- _history remains the deep audit trail (the soft-delete is recorded there as an
-- UPDATE, the eventual purge as a DELETE).

ALTER TABLE "Principals"          ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ;
ALTER TABLE "Resources"           ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ;
ALTER TABLE "ResourceAssignments" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMPTZ;

-- Partial indexes over only the deleted rows: cheap, and they support the two
-- queries that care about deleted rows — the purge ("older than retention") and
-- the show-deleted views. The common "live only" filter (deletedAt IS NULL) needs
-- no index since the vast majority of rows are live.
CREATE INDEX IF NOT EXISTS "ix_Principals_deletedAt"          ON "Principals"          ("deletedAt") WHERE "deletedAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ix_Resources_deletedAt"           ON "Resources"           ("deletedAt") WHERE "deletedAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ix_ResourceAssignments_deletedAt" ON "ResourceAssignments" ("deletedAt") WHERE "deletedAt" IS NOT NULL;

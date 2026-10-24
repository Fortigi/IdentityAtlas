-- Migration 083: how much access hangs off a context.
--
-- A context that groups resources (an application from a catalogue, a tag on a
-- set of groups) is only half described by how many resources it has. The
-- question asked of it is how much access that is: how many assignments, and
-- how many different holders. Those numbers cannot be computed when they are
-- asked for. Measured on 41 million assignments and 1,500 contexts: 101 seconds
-- for one count column, against the report builder's 15-second statement limit.
--
-- So they are stored on the context, next to the member counts that are already
-- kept there, and recalculated after each sync (contexts/assignmentCounts.js):
--
--   "resourceCount"            resources in this context
--   "directAssignmentCount"    holders that hold one of them directly
--   "indirectAssignmentCount"  holders that hold one of them through a role or group
--   "eligibleAssignmentCount"  holders that could activate one of them
--   "holderCount"              different holders across all of them (Direct or Indirect)
--
-- The first four count (resource, holder) pairs, so somebody holding ten
-- resources of one context counts ten times; "holderCount" counts that person
-- once. All of them are about the context's OWN members, not its sub-contexts'.
--
-- NULL means "not calculated": every context that does not group resources, and
-- every context until the first sync after this migration. It is deliberately
-- not 0: an application nobody has access to is a finding, an application
-- that has not been counted yet is not.
--
-- Nullable columns with no default: no table rewrite, nothing to backfill.

ALTER TABLE "Contexts" ADD COLUMN IF NOT EXISTS "resourceCount"           INTEGER;
ALTER TABLE "Contexts" ADD COLUMN IF NOT EXISTS "directAssignmentCount"   INTEGER;
ALTER TABLE "Contexts" ADD COLUMN IF NOT EXISTS "indirectAssignmentCount" INTEGER;
ALTER TABLE "Contexts" ADD COLUMN IF NOT EXISTS "eligibleAssignmentCount" INTEGER;
ALTER TABLE "Contexts" ADD COLUMN IF NOT EXISTS "holderCount"             INTEGER;

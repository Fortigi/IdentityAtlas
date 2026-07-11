-- ─── Timeline / recent-changes index coverage on _history ────────────
--
-- The entity-detail Timeline tab and the recent-changes panel query `_history`
-- for one entity's events, filtering on JSONB-extracted foreign keys, e.g.
--   ("tableName" = 'ResourceAssignments' AND "rowData"->>'principalId' = $id)
--
-- Migration 009 gave _history only ("tableName","rowId","changedAt") and
-- ("changedAt") indexes. Those cover the attribute-change branches (Principals /
-- Resources / Identities / Contexts, filtered by "rowId" = $id) but NOT the
-- relationship branches, which filter on a `rowData->>'...'` expression that no
-- index covers. Worse, the synthesized composite rowId (migration 022) puts
-- principalId in the MIDDLE of a ResourceAssignment's rowId
-- ("resourceId|principalId|assignmentType"), so the rowId index can't serve a
-- user timeline even as a prefix scan.
--
-- Result: every timeline/recent-changes load was a full sequential scan of
-- _history — an unbounded, ever-growing audit table (retention is deferred,
-- see migration 009). Measured on a small tenant (~100k history rows, 161 MB):
-- a user timeline read ~15,500 pages (the whole table). That cost grows linearly
-- with history size, so on a busy tenant it becomes seconds per load.
--
-- These partial expression indexes make each relationship branch an index scan,
-- so the planner combines them (BitmapOr) and the query becomes O(the entity's
-- events) instead of O(the whole table). Same measurement after: ~1,200 pages,
-- 30 ms -> 7 ms, and — crucially — flat as the table grows. They also cover the
-- recent-changes endpoints, which filter the same way.
--
-- Partial (WHERE "tableName" = ...) so each index only holds the rows of its own
-- relationship table — small, and a tight match for the query's tableName guard.
-- Plain CREATE INDEX (not CONCURRENTLY): the migration runner wraps each file in
-- a transaction. On a large existing _history this build briefly locks writes;
-- that is acceptable at deploy time for an append-mostly audit table.

-- User timeline: ResourceAssignments / IdentityMembers by principalId.
CREATE INDEX IF NOT EXISTS ix_hist_ra_principal
  ON "_history" (("rowData"->>'principalId')) WHERE "tableName" = 'ResourceAssignments';
CREATE INDEX IF NOT EXISTS ix_hist_im_principal
  ON "_history" (("rowData"->>'principalId')) WHERE "tableName" = 'IdentityMembers';

-- Resource / access-package timeline: ResourceAssignments by resourceId,
-- ResourceRelationships by either side.
CREATE INDEX IF NOT EXISTS ix_hist_ra_resource
  ON "_history" (("rowData"->>'resourceId')) WHERE "tableName" = 'ResourceAssignments';
CREATE INDEX IF NOT EXISTS ix_hist_rr_child
  ON "_history" (("rowData"->>'childResourceId')) WHERE "tableName" = 'ResourceRelationships';
CREATE INDEX IF NOT EXISTS ix_hist_rr_parent
  ON "_history" (("rowData"->>'parentResourceId')) WHERE "tableName" = 'ResourceRelationships';

-- Identity timeline: IdentityMembers by identityId.
CREATE INDEX IF NOT EXISTS ix_hist_im_identity
  ON "_history" (("rowData"->>'identityId')) WHERE "tableName" = 'IdentityMembers';

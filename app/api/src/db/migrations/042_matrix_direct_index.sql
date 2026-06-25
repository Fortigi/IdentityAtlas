-- Identity Atlas — partial index on the matrix matview for Direct memberships
--
-- The roll-up and scope endpoints scan the matrix matview filtered to
-- membershipType='Direct' and group with count(DISTINCT "principalId") per
-- resource. The existing single-column "resourceId" index gives resourceId
-- order only, so the planner adds an Incremental Sort to reach
-- (resourceId, principalId) order for the distinct count. A composite,
-- Direct-only index provides that order directly, letting the GroupAggregate
-- stream without the sort.
--
-- Measured on a real 367k-row matview (298k Direct): the broad/unscoped roll-up
-- drops from ~126 ms to ~51 ms (~2.5x) with identical results. Scoped queries
-- are unaffected (already index-only via the primary key). Index size ~14 MB.
--
-- Partial (WHERE membershipType='Direct') so it only covers the rows the matrix
-- reads, keeping the index small and the REFRESH MATERIALIZED VIEW cost low.

CREATE INDEX IF NOT EXISTS "ix_vw_ResUserPerm_direct"
  ON "vw_ResourceUserPermissionAssignments" ("resourceId", "principalId")
  WHERE "membershipType" = 'Direct';

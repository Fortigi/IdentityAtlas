# SQL Views

Identity Atlas creates SQL views automatically via the migration system. These views handle the heavy lifting — recursive membership resolution and permission assignment aggregation — so your queries stay simple.

Views are created by migration files in `app/api/src/db/migrations/` and applied automatically when the web container starts.

---

## Resource Permission Views

Created by migration `005_views.sql`; the two matrix views were promoted to
**materialized** views in `013_matrix_matviews_and_indexes.sql` and last
rebuilt by `049_governed_intent_rows.sql`.

| View | Kind | Output columns | Purpose |
|------|------|----------------|---------|
| `vw_ResourceMembersRecursive` | Standard view | `resourceId`, `principalId`, `principalType`, `membershipType`, `depth`, `path` | All memberships (direct + indirect via nested groups) using a recursive CTE. Cycle-safe, max 10 levels deep. `membershipType` is `Direct` at depth 1 and `Indirect` deeper; `path` is the resolved chain of ids. |
| `vw_ResourceUserPermissionAssignments` | **Materialized view** | `resourceId`, `principalId`, `principalType`, `membershipType`, `managedByAccessPackage` | The matrix surface — one row per effective (subject, resource, `membershipType`) cell. `managedByAccessPackage` flags cells covered by a governance resource, for IST vs SOLL analysis. |
| `vw_UserPermissionAssignments` | Standard view (compat alias) | `groupId`, `memberId`, `principalType`, `membershipType`, `managedByAccessPackage` | Backward-compatible alias over `vw_ResourceUserPermissionAssignments` with the older `groupId`/`memberId` column names. |

!!! warning "`vw_ResourceUserPermissionAssignments` is materialized — refresh it"
    This view holds a stored snapshot. After ingesting or changing assignment
    data you must run `REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments";`
    (or the concurrent variant, see [Materialized Views](#materialized-views))
    before it reflects the new data. `vw_UserPermissionAssignments` reads from
    it, so it follows the same refresh.

`membershipType` is one of `Direct`, `Indirect`, `Eligible` — the three
universal "how does the subject have this" values. (`Owner` was retired in
`046_owner_as_resource.sql`: ownership is now a `Direct` assignment on a
separate `GroupOwnership` resource.)

```sql
-- Who has access to a specific resource, including indirect memberships?
SELECT rmr."principalId", p."displayName", rmr."membershipType", rmr."depth", rmr."path"
FROM "vw_ResourceMembersRecursive" rmr
JOIN "Principals" p ON p."id" = rmr."principalId"
WHERE rmr."resourceId" = 'your-resource-guid'
ORDER BY rmr."depth";

-- A user's complete permission picture across all resources
SELECT v."resourceId", r."displayName", v."membershipType", v."managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments" v
JOIN "Resources" r ON r."id" = v."resourceId"
WHERE v."principalId" = 'user-guid-here';

-- How many permissions does each user hold?
SELECT v."principalId", p."displayName", COUNT(*) AS "permissionCount"
FROM "vw_ResourceUserPermissionAssignments" v
JOIN "Principals" p ON p."id" = v."principalId"
GROUP BY v."principalId", p."displayName"
ORDER BY "permissionCount" DESC;
```

---

## Governance View

Created by migration `005_views.sql`; promoted to a **materialized** view in
`013_matrix_matviews_and_indexes.sql` and last rebuilt by
`049_governed_intent_rows.sql`.

| View | Kind | Output columns | Purpose |
|------|------|----------------|---------|
| `vw_UserPermissionAssignmentViaBusinessRole` | **Materialized view** | `userId`, `groupId`, `resourceId`, `businessRoleId` | Maps users through governance resources (business roles / access packages) to the resources those roles `Contains`. `groupId` and `resourceId` are the same contained-resource id, exposed under both names. |

!!! warning "Materialized — refresh required"
    Like the matrix view, this is a materialized view. Run
    `REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole";`
    after changing governance data before querying it.

```sql
-- Which resources does a user reach via business role governance?
SELECT v."userId", v."resourceId", r."displayName" AS "resourceName",
       v."businessRoleId", br."displayName" AS "businessRoleName"
FROM "vw_UserPermissionAssignmentViaBusinessRole" v
JOIN "Resources" r  ON r."id"  = v."resourceId"
JOIN "Resources" br ON br."id" = v."businessRoleId"
WHERE v."userId" = 'user-guid-here';
```

---

## Materialized Views

Two of the views above are PostgreSQL **materialized** views —
`vw_ResourceUserPermissionAssignments` and
`vw_UserPermissionAssignmentViaBusinessRole`. They were promoted from standard
views in `013_matrix_matviews_and_indexes.sql` because recomputing the matrix
from scratch on every `/api/permissions` request was taking 100+ seconds on
large (2M+ row) datasets.

Because they store a snapshot, they must be **refreshed** after the underlying
`ResourceAssignments` / `ResourceRelationships` data changes:

```sql
-- Standard refresh (locks the matview for the duration)
REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments";
REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole";

-- Concurrent refresh (no read lock; requires the unique index the migrations create)
REFRESH MATERIALIZED VIEW CONCURRENTLY "vw_ResourceUserPermissionAssignments";
```

You normally don't run these by hand: the migrations create the matviews empty
(`WITH NO DATA`) and the web container refreshes them at the end of bootstrap,
and the ingest endpoint `/api/ingest/refresh-views` runs
`REFRESH MATERIALIZED VIEW CONCURRENTLY` so the crawlers refresh automatically
at end-of-sync. Reach for a manual refresh only when querying the matviews
directly (e.g. from `psql` or a contract test) after loading data.

---

## Historical Queries

All core tables (`Principals`, `Resources`, `ResourceAssignments`, etc.) are tracked by the `_history` audit table via PostgreSQL triggers. Every insert, update, and delete is recorded as a JSONB snapshot, enabling full change history queries.

```sql
-- Current data (standard query, no change needed)
SELECT * FROM "Principals" WHERE department = 'Finance';

-- Full change history for a specific principal
SELECT "changedAt", operation, "rowData", "prevData"
FROM "_history"
WHERE "tableName" = 'Principals'
  AND "rowId" = 'principal-guid-here'
ORDER BY "changedAt" DESC;

-- All assignment changes in the last 30 days
SELECT "rowId", operation, "changedAt", "rowData"
FROM "_history"
WHERE "tableName" = 'ResourceAssignments'
  AND "changedAt" >= now() - interval '30 days'
ORDER BY "changedAt" DESC;

-- Deleted resources (no longer in the current table)
SELECT "rowId", "changedAt", "rowData"->>'displayName' AS name
FROM "_history"
WHERE "tableName" = 'Resources'
  AND operation = 'D'
ORDER BY "changedAt" DESC;
```

For more on audit history usage and query patterns, see [Audit History](../architecture/audit-history.md).

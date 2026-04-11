# SQL Views

Identity Atlas creates SQL views automatically via the migration system. These views handle the heavy lifting — recursive membership resolution and permission assignment aggregation — so your queries stay simple.

Views are created by migration files in `app/api/src/db/migrations/` and applied automatically when the web container starts.

---

## Resource Permission Views

Created by migrations `005_views.sql` and `011_governed_in_matrix_view.sql`.

| View | Purpose |
|------|---------|
| `vw_ResourceMembersRecursive` | All memberships (direct + indirect via nested groups) using a recursive CTE. Cycle-safe, max 10 levels deep. Includes the full membership path. |
| `vw_ResourceUserPermissionAssignments` | All assignment types (Direct, Indirect, Owner, Eligible, CrossResourceIndirect) in a single queryable surface. Includes the `managedByAccessPackage` flag for IST vs SOLL analysis. |
| `vw_UserPermissionAssignments` | Simplified permission view used by the matrix UI — one row per user-resource-type combination. |

```sql
-- Who has access to a specific resource, including indirect memberships?
SELECT principalId, displayName, assignmentType, depth, membershipPath
FROM vw_ResourceMembersRecursive
WHERE resourceId = 'your-resource-guid'
ORDER BY depth;

-- A user's complete permission picture across all resources
SELECT resourceId, resourceName, assignmentType, managedByAccessPackage
FROM vw_ResourceUserPermissionAssignments
WHERE principalId = 'user-guid-here';

-- How many permissions does each user hold?
SELECT principalId, displayName, COUNT(*) AS permissionCount
FROM vw_ResourceUserPermissionAssignments
GROUP BY principalId, displayName
ORDER BY permissionCount DESC;
```

---

## Governance View

Created by migration `005_views.sql`.

| View | Purpose |
|------|---------|
| `vw_UserPermissionAssignmentViaBusinessRole` | Maps users through business roles to the resources those roles grant |

```sql
-- Which resources does a user reach via business role governance?
SELECT principalId, displayName, resourceId, resourceName, businessRoleName
FROM "vw_UserPermissionAssignmentViaBusinessRole"
WHERE principalId = 'user-guid-here';
```

!!! note "Planned governance views"
    Additional governance analysis views (IST/SOLL gap analysis, approval timelines, request metrics) are planned for a future release. The current v5 migration focused on core permission views.

---

## Materialized Views

!!! note "v5 status"
    Materialized views are planned for a future release to improve query performance in large environments. The current v5 views are standard PostgreSQL views. For large deployments, consider adding PostgreSQL materialized views manually if needed.

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

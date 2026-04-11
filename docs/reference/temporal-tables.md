# Audit History & Historical Queries

Identity Atlas v5 uses a shared `_history` audit table populated by PostgreSQL triggers. Every insert, update, and delete on tracked tables is recorded as a JSONB snapshot — giving you a complete, queryable change history without any application-level code.

!!! note "v4 to v5 change"
    v4 used SQL Server system-versioned temporal tables (`FOR SYSTEM_TIME` syntax). v5 replaced these with a single `_history` table and trigger-based recording after the migration to PostgreSQL. The concept is the same — automatic change tracking — but the query syntax is different.

---

## How It Works

A generic PostgreSQL trigger function (`fg_record_history`) fires on INSERT, UPDATE, and DELETE. It writes one row to `_history` per actual change:

| Column | Type | Description |
|--------|------|-------------|
| `id` | `bigserial` | Auto-incrementing primary key |
| `tableName` | `text` | Name of the source table (e.g. `Principals`, `Resources`) |
| `rowId` | `text` | The `id` value of the changed row |
| `operation` | `char(1)` | `I` = insert, `U` = update, `D` = delete |
| `changedAt` | `timestamptz` | Timestamp of the change |
| `rowData` | `jsonb` | Full row snapshot after the change (or the deleted row for `D`) |
| `prevData` | `jsonb` | Previous row state (NULL for inserts) |

### Tracked Tables

| Table | Tracked |
|-------|---------|
| `Principals` | Yes |
| `Resources` | Yes |
| `ResourceAssignments` | Yes |
| `ResourceRelationships` | Yes |
| `AssignmentPolicies` | Yes |
| `GovernanceCatalogs` | Yes |
| `Systems` | Yes |
| `PrincipalActivity` | **No** — upsert-based; daily sign-in timestamps would generate excessive audit noise |
| `RiskScores` | **No** — recalculated on each scoring run |

### No-op Filtering

The UPDATE trigger uses a `WHEN (OLD IS DISTINCT FROM NEW)` clause, so re-ingesting unchanged rows during a sync does not generate audit entries. This is critical because the crawler upserts every row on every run.

---

## Query Patterns

### Full change history for a single entity

```sql
-- All versions of a principal, newest first
SELECT "changedAt", operation, "rowData", "prevData"
FROM "_history"
WHERE "tableName" = 'Principals'
  AND "rowId" = 'principal-guid-here'
ORDER BY "changedAt" DESC;
```

### Changes within a time range

```sql
-- All resource assignment changes in the last 30 days
SELECT "rowId", operation, "changedAt", "rowData"
FROM "_history"
WHERE "tableName" = 'ResourceAssignments'
  AND "changedAt" >= now() - interval '30 days'
ORDER BY "changedAt" DESC;
```

### Detecting what changed in an update

```sql
-- Compare rowData vs prevData to see what fields changed
SELECT
  "changedAt",
  "prevData"->>'department' AS old_department,
  "rowData"->>'department'  AS new_department
FROM "_history"
WHERE "tableName" = 'Principals'
  AND "rowId" = 'principal-guid-here'
  AND operation = 'U'
  AND "prevData"->>'department' IS DISTINCT FROM "rowData"->>'department'
ORDER BY "changedAt" DESC;
```

### Deleted entities

```sql
-- Resources that were deleted (no longer in the current table)
SELECT "rowId", "changedAt", "rowData"->>'displayName' AS name
FROM "_history"
WHERE "tableName" = 'Resources'
  AND operation = 'D'
ORDER BY "changedAt" DESC;
```

### Point-in-time reconstruction

To reconstruct the state of an entity at a specific point in time, find the most recent history row at or before that timestamp:

```sql
-- What did this principal look like on January 15, 2026?
SELECT "rowData"
FROM "_history"
WHERE "tableName" = 'Principals'
  AND "rowId" = 'principal-guid-here'
  AND "changedAt" <= '2026-01-15 23:59:59+00'
ORDER BY "changedAt" DESC
LIMIT 1;
```

---

## How the UI Uses History

The entity detail pages (User Detail, Resource Detail, Business Role Detail) query `_history` to build a **Version History** section that shows diffs between sync runs. The API endpoint compares consecutive `rowData` / `prevData` snapshots and highlights changed fields.

---

## Retention

By default, history is retained indefinitely. For environments with high churn, add a periodic cleanup job:

```sql
-- Delete history older than 2 years
DELETE FROM "_history"
WHERE "changedAt" < now() - interval '2 years';
```

The Admin page provides a **History Retention** setting (`Admin > History Retention`) to configure automatic cleanup.

---

## Adding History to a New Table

To track a new table, create triggers that call the existing `fg_record_history` function:

```sql
-- INSERT and DELETE: always record
CREATE TRIGGER trg_history_ins_del
AFTER INSERT OR DELETE ON "MyNewTable"
FOR EACH ROW EXECUTE FUNCTION fg_record_history();

-- UPDATE: only when something actually changed
CREATE TRIGGER trg_history_upd
AFTER UPDATE ON "MyNewTable"
FOR EACH ROW
WHEN (OLD IS DISTINCT FROM NEW)
EXECUTE FUNCTION fg_record_history();
```

The trigger function is generic — it works with any table that has an `id` column.

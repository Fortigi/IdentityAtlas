# Soft-Delete & Tombstone Lifecycle

When an entity disappears from a source system, Identity Atlas does **not** immediately hard-delete it. Instead the ingest engine *tombstones* the row by stamping a `deletedAt` timestamp, keeps it for a retention window, and only finally removes it with a purge job. This keeps leavers and removed resources auditable, prevents cross-system references from dangling, and lets a re-appearing entity come back to life automatically.

Introduced in migration `040_soft_delete.sql`; the matrix exclusion is migration `041_matrix_view_exclude_deleted.sql`.

## Why soft-delete

- **Auditability.** A user who left, or a group that was removed, stays queryable (with its history) instead of vanishing the moment a sync no longer sees it.
- **No dangling cross-system references.** An Azure RM role assignment can target a service principal that Entra ID later deletes. Hard-deleting the principal would orphan the assignment; tombstoning keeps the reference resolvable.
- **Cheap re-activation.** Source systems routinely drop and re-add objects (a disabled-then-re-enabled account, a delta blip). A tombstone that clears itself on the next sync avoids churn in history and identity links.

## Which tables

`deletedAt TIMESTAMPTZ` (nullable) was added to the three tables whose rows represent live source-system state:

| Table | Tombstoned on disappearance |
|---|---|
| `Principals` | ✅ |
| `Resources` | ✅ |
| `ResourceAssignments` | ✅ |

Every other table still hard-deletes on scoped-delete. A partial index (`WHERE "deletedAt" IS NOT NULL`) backs each column — it only indexes the small set of tombstoned rows, which is all the purge and "show deleted" queries need; the common `deletedAt IS NULL` (live) filter needs no index because almost every row is live.

## Lifecycle

```
 source removes entity                re-sync sees it again
        │                                     │
        ▼                                     ▼
   ┌─────────┐   deletedAt = now()      ┌──────────┐  deletedAt = NULL   ┌──────┐
   │  LIVE   │ ───────────────────────▶ │ TOMBSTONE│ ──────────────────▶ │ LIVE │
   └─────────┘                          └────┬─────┘                     └──────┘
                                             │ older than HISTORY_RETENTION_DAYS
                                             ▼
                                        ┌─────────┐
                                        │  PURGED │  (hard DELETE; final 'D' row in _history)
                                        └─────────┘
```

### 1. Tombstone (soft-delete)

The ingest engine stamps `deletedAt = now()` instead of deleting, in two situations:

- **Delta removal** — a Graph `/delta` payload marks an object `@removed` (`routes/ingest.js`).
- **Full-sync absence** — an entity present in the DB but missing from a full-sync batch, within the crawl's scope (`ingest/engine.js` scoped delete).

The update is guarded by `deletedAt IS NULL`, so the original deletion timestamp stays **stable** across subsequent syncs — re-running a crawl that still doesn't see the entity won't keep moving the clock forward.

### 2. Re-activation

On the next ingest that *does* include the entity, the upsert's `ON CONFLICT … DO UPDATE` sets `deletedAt = NULL` — the row is simply live again, with its history intact. No manual step is required.

### 3. Purge (retention)

`purgeExpiredTombstones()` (`ingest/tombstonePurge.js`) hard-deletes tombstones older than the retention window:

- **Retention** is the single `WorkerConfig` value `HISTORY_RETENTION_DAYS` (default **180**) — the same window that prunes the `_history` audit log, so a tombstone and its history age out together. Setting it to `0` (or an invalid value) **disables** the purge (tombstones are kept indefinitely).
- **Order** is `ResourceAssignments` → `Principals` → `Resources`, so a hard-deleted holder or target never briefly leaves a dangling assignment.
- **When** it runs: at API startup (`bootstrap.js`) and on demand via the admin endpoint below.

## Where deleted entities appear

| Surface | Behaviour |
|---|---|
| **List endpoints** (`/api/resources`, principals/users, tags) | Soft-deleted rows are hidden by default. Pass `?includeDeleted=true` to include them. |
| **Role-mining UI lists** | A **"Include deleted"** toggle (`useEntityPage` → `includeDeleted`); deleted rows show a `DeletedBadge`. |
| **Detail pages** | Always shown, with a **"Deleted in source"** badge — including the entity's deleted assignments. |
| **Matrix** (`vw_ResourceUserPermissionAssignments`) | **Excluded.** The matview filters out any cell whose assignment, holder, or target is tombstoned (`deletedAt IS NULL` + `NOT EXISTS` a deleted principal/resource), so the live access picture never shows access via a deleted entity. `NOT EXISTS` (not a join) is used so a row whose endpoint is merely missing is kept — only explicit tombstones are excluded. |

## Relationship to `_history`

The `_history` audit table remains the deep trail:

- The soft-delete is recorded as an **`U`** (update) row (deletedAt going from NULL to a timestamp).
- The eventual purge is recorded as the final **`D`** (delete) row.

So even after a tombstone is purged from the live tables, the fact that the entity existed — and when it was removed — survives in `_history` until that, too, ages past `HISTORY_RETENTION_DAYS`.

## Admin API

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/history-retention` | Read the current `retentionDays` + total `_history` row count. |
| `POST /api/admin/history-retention/prune` | Prune `_history` **and** purge expired tombstones now, using the configured retention. |

See also [Audit History](audit-history.md) for the `_history` model the retention window is shared with.

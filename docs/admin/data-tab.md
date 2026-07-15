# Admin → Data

The **Data** tab (Admin → Data) is where operators move curated data in and out
of a deployment, keep the audit history trimmed, and — when they really mean it —
wipe the database back to a clean slate. Everything here is gated by permission,
so which sections you see depends on the roles mapped to your account (see
[Permissions & Role Mapping](../reference/permissions.md)).

The tab groups four things:

| Section | What it does | Permission |
|---|---|---|
| **Curated Data** | Export/import tags and business-role categories as JSON | `data.export.ui` (export), `admin.csv-import` (import) |
| **Excel Power Query Workbook** | Generate a read-only workbook + token for BI/Excel | `data.export.ui` |
| **Deleted Data & History Retention** | Control how long soft-deleted rows and audit history are kept | `admin.systems` |
| **Danger Zone → Clean Database** | Wipe all identity data, keep your setup | `admin.systems` |

!!! note "The tab appears if you hold *any* of its permissions"
    Admin → Data is visible to anyone with `data.export.ui`, `admin.csv-import`,
    `admin.systems`, `admin.read-tokens`, or `data.export.apikey`. Individual
    sections are still gated on their own permission, so a user who can export
    but not clean the database sees the export controls without the Danger Zone.

---

## Curated Data (export / import)

Tags and business-role categories are curated by analysts inside the UI — they
are not produced by a crawler, so a full re-sync or a fresh environment does not
recreate them. This section exports that curated layer to a JSON file and imports
it back.

- **Export tags & categories** — `GET /api/admin/export/curated` (permission
  `data.export.ui`). Streams a `FGCuratedData_<date>.json` file containing every
  user/group/resource tag with its assignments, and every business-role category
  with its access-package assignments. The format is compatible with the
  PowerShell `Export-FGCuratedData` / `Import-FGCuratedData` cmdlets.
- **Import from file** — `POST /api/admin/import/curated` (permission
  `admin.csv-import`). Reads a JSON file in the same format and re-attaches the
  tags and categories.

**How import resolves entities.** Each assignment is matched to a live entity in
two passes: first by GUID (the exact `entityId` / `accessPackageId`), then — if
that GUID is no longer present — by display name (plus resource type for
groups/resources). Anything that still can't be resolved is reported as "not
found" rather than silently dropped.

!!! tip "Import after a sync, not before"
    Import matches against records already in the database. If you import curated
    data into an empty environment, most assignments land as "entity not found".
    Run a full crawler sync first so the principals, resources, and business roles
    exist, then import — the GUID pass will match them cleanly.

Analyst score overrides are **not** part of this export — they are handled
separately by the PowerShell `Export-FGCuratedData` cmdlet.

---

## Excel Power Query Workbook

The same tab hosts the **Excel Power Query Workbook** export: it generates a
pre-configured `.xlsx` that pulls live data from the API through Power Query,
with a freshly-minted read-only token embedded so refreshing is one click. This
is the analyst/BI on-ramp — full walkthrough, sheet list, and token management
in **[Excel Power Query workbook export](excel-powerquery-export.md)**.

---

## Deleted Data & History Retention

Identity Atlas keeps a row-level change history in the `_history` audit table and
soft-deletes entities that vanish from a source system (they stay queryable for
audit). This section controls how long both are kept before being permanently
purged.

- **Retention (days)** — the age at which soft-deleted rows are hard-deleted and
  audit-history entries are pruned. The default is **180 days**. Setting it to
  **`0` disables purging entirely** — everything is kept forever.
- **Save** — persists the value (`PUT /api/admin/history-retention`).
- **Prune now** — runs the purge immediately (`POST
  /api/admin/history-retention/prune`) instead of waiting for the scheduled run.

The prune job runs automatically every 6 hours. The same retention window governs
both the history table and the tombstone finalisation, so one setting covers both.
Valid values are `0`–`3650` days.

Reading the current setting is open to any signed-in user; saving, and pruning
are gated by `admin.systems`.

!!! note "Related architecture"
    For how the audit history itself works — the trigger function, tracked tables,
    and query patterns — see
    [Audit History & Historical Queries](../architecture/audit-history.md).

---

## Danger Zone → Clean Database

**Clean Database** (`POST /api/admin/clean-database`, permission `admin.systems`)
wipes all identity data so you can re-sync from a clean slate without rebuilding
your setup.

**What it wipes:** every data table — Principals, Resources, ResourceAssignments,
ResourceRelationships, Identities, IdentityMembers, Contexts, governance catalogs,
risk scores, systems, and the crawler runtime artifacts (jobs and sync logs). The
matching `_history` audit rows for those tables go too, and crawler configs are
reset to "never run".

**What it preserves:**

- **Crawler configurations** — your crawler connection entries and their credentials stay put (these are the Crawlers admin records, distinct from the `Systems` data table above, which *is* wiped).
- **Risk profiles and classifiers.**
- **Account-linking / correlation rules.**
- **The audit log** for anything not tied to a wiped table.

After a clean, the sequences are reset and the tables are re-analyzed so the
dashboard immediately reports zero rows. You then re-run your crawlers to
repopulate.

!!! warning "This is irreversible"
    The UI requires two confirmations — a "Yes, continue" step and typing
    `DELETE ALL DATA` — before the wipe runs. The endpoint is also rate-limited to
    **5 requests per minute** to guard against runaway automation. There is no undo;
    the data comes back only by re-syncing.

# Admin → Data

The **Data** tab (Admin → Data) is where operators hand out the Excel Power Query
workbook, keep the audit history trimmed, and — when they really mean it — wipe
the database back to a clean slate. Everything here is gated by permission,
so which sections you see depends on the roles mapped to your account (see
[Permissions & Role Mapping](../reference/permissions.md)).

The tab groups three things:

| Section | What it does | Permission |
|---|---|---|
| **Excel Power Query Workbook** | Generate a read-only workbook + token for BI/Excel | `data.export.ui` |
| **Deleted Data & History Retention** | Control how long soft-deleted rows and audit history are kept | `admin.systems` |
| **Danger Zone → Clean Database** | Wipe all identity data, keep your setup | `admin.systems` |

!!! note "The tab appears if you hold *any* of its permissions"
    Admin → Data is visible to anyone with `data.export.ui`, `admin.systems`,
    `admin.read-tokens`, or `data.export.apikey`. Individual
    sections are still gated on their own permission, so a user who can export
    but not clean the database sees the export controls without the Danger Zone.

---

## Moving to a new instance

The tab also carries a short note: to move Identity Atlas to a new instance, back
up the database and restore it there. A database backup carries everything,
including what people made in the app: tags, contexts built by hand, risk-score
overrides and settings. The steps for Docker, Azure and the portable version are in
[Move Identity Atlas to a new instance](backup-restore-upgrade.md#move-identity-atlas-to-a-new-instance).

Earlier versions had a **Curated Data** export and import on this tab. It covered
only tags and business-role categories, so it has been removed.

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
    `DELETE ALL DATA` — before the wipe runs. The API enforces the same phrase: a
    call must send the JSON body `{"confirm": "DELETE ALL DATA"}`, otherwise it is
    refused with `400`. The endpoint is also rate-limited to **5 requests per minute
    per admin** to guard against runaway automation. There is no undo; the data comes
    back only by re-syncing.

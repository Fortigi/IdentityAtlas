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
| **Danger Zone → Clean Database** | Remove everything a crawler or plugin can recreate, keep what people made | `admin.systems` |

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
removes everything a crawler or a plugin can recreate, and nothing a person
made. Use it to re-sync from a clean slate without losing your setup or your
curated work.

!!! tip "Make a backup first"
    There is no undo. [Make a backup first](backup-restore-upgrade.md) if you
    might want any of the removed data back.

The confirmation dialog shows the same lists as below. It reads them from the
API (`GET /api/admin/clean-database/plan`), which takes them from the table
classification the clean itself runs on, so the dialog cannot promise something
the clean does not do.

**What it removes:**

- Systems, accounts, resources and access loaded by your crawlers
- Governance data from your sources: catalogs, business roles, policies, requests and review decisions
- Identities and the accounts linked to them
- Synced and generated contexts (org charts, departments, clusters and other plugin trees) with their members
- Crawler job history, the sync log and saved delta tokens, so the next crawl is a full one
- Computed results: risk scores, dashboard trend snapshots, and the run history of plugins, risk scoring and account linking
- The change history of everything removed

**What it keeps:**

- Manual contexts and tags, with the members you added
- Uploaded lists, with their contexts, members and the owners you assigned to them
- Analyst risk-score overrides
- Settings: crawler configurations and registrations, feature flags, role mapping, LLM, history retention and personal preferences
- Risk profiles, risk classifiers and account-linking rules
- Stored secrets and read-API keys
- Saved matrix views, matrix shares, saved reports and report views
- Business-role categories and their assignments
- Interviews, claims, decisions, change requests, tree adjustments, workbench investigations and role proposals on contexts that are kept
- Audit logs: role changes, crawler audit, MCP tool calls, share access, update checks and bot conversations
- The change history of everything kept

**Work of yours that is removed anyway**, because it cannot exist without the
data it hangs on:

- Owners you assigned to a crawled system — the system is removed.
- Manager overrides in the org chart — the account they move is removed.
- Accountable and Responsible people on contexts, including the ones you set, and rejected suggestions — every holder is an account or an identity, and those are removed.
- Accountable and Responsible people on business roles, including the ones you set, and rejected suggestions — the business roles and their holders are removed.
- Composition reviews of business roles, with their verdicts, remarks and notes — the business roles are removed.
- What review campaigns asked: their scope and the requests of their rounds. The campaigns themselves stay, with an empty scope — the business roles and role portfolios are removed.
- Your confirm, reject and move decisions on identity accounts, and analyst verification and notes on identities — the identities they belong to are removed.
- Members and links you added to a synced or generated context — that context is removed.
- Interviews, claims, decisions and workbench investigations (with their role proposals) on a synced or generated context — that context is removed.
- Tree adjustments on a tree tied to a crawled system — that system is removed.

**Kept, but changed:**

- A manual context placed under a synced or generated context moves to the top level.
- Kept interviews, claims and change requests lose their link to a removed account, context or system; the names they recorded stay.
- A role proposal that extends a removed business role loses that link.
- Crawler configurations show as never run.

Members you added to a manual context or tag point at accounts and resources by
their id, without a hard link. Entra object ids, and the ids the ingest derives
for other sources, stay the same across a re-crawl, so those members come back
once the next crawl brings the accounts back.

**How it runs.** The clean runs in one database transaction. If any step fails,
nothing is removed and the call answers `500` with
`Clean database failed. Nothing was removed.` On success the tables are
re-analyzed, the matrix views are rebuilt in the background, and each table's id
sequence restarts after the highest id still in use (at 1 for an emptied table).
The response lists each table it cleaned with its row count (`wiped`), the rows
of kept tables that went with removed data (`alsoRemoved`), and how many history
rows were removed (`historyRowsRemoved`). You then re-run your crawlers to
repopulate.

!!! warning "This is irreversible"
    The UI requires two confirmations — a "Yes, continue" step and typing
    `DELETE ALL DATA` — before the clean runs. The API enforces the same phrase: a
    call must send the JSON body `{"confirm": "DELETE ALL DATA"}`, otherwise it is
    refused with `400`. The endpoint is also rate-limited to **5 requests per minute
    per admin** to guard against runaway automation. There is no undo; the removed
    data comes back only by re-syncing, or from a backup.

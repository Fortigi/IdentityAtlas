# Connect SQL Server

Identity Atlas reads authorization data from a **Microsoft SQL Server** database with
`SELECT` statements you write yourself. Each statement gets a **target** that says what
its rows become (accounts, resources, assignments, and so on), and the crawler maps the
statement's columns onto the data model by name. Nothing about the source schema is built
in.

**Use this when**

- the source is an IGA product, HR system or home-grown authorization database that
  lives in SQL Server and has no dedicated crawler;
- you run **SailPoint IdentityIQ** on SQL Server. Two example statement sets ship with
  the wizard, see [SailPoint IdentityIQ](#sailpoint-identityiq);
- the tables are large. Rows stream from the server in batches, so memory stays flat
  whatever the size of the result set.

For a source that is not SQL Server, use [CSV Import](csv-import.md) or the
[Custom Connector](custom-connector.md).

---

## What you get

| Target | Each row becomes |
|---|---|
| `systems` | One system per connector in the source. Later statements can send their rows to these systems instead of the crawler's own |
| `identities` | One identity (the person), one account with the same id, and the link between them |
| `principals` | One account; with an `identityId` column also the link to that identity |
| `identity-members` | A link between an existing identity and an existing account |
| `resources` | One resource of the statement's resource type (for example `Entitlement` or `BusinessRole`) |
| `assignments` | One assignment (Direct, Indirect or Eligible, governed or not, as set on the statement) |
| `relationships` | One resource-to-resource link, parent to child |
| `contexts` | One context, for example a logical application from the source's own catalogue |
| `context-members` | One membership of a context |

The source's own keys are kept as `externalId`, and the Identity Atlas ids are derived
from them, so a re-run updates the same rows. See
[Deterministic GUID generation](../architecture/ingest-api.md#deterministic-guid-generation).

---

## Before you start

- **A SQL Server login** with `SELECT` on the tables or views the statements read. The
  crawler only runs your `SELECT` statements and never writes to the database, so use a
  dedicated read-only login. Only SQL Server authentication (login and password) is
  supported.
- **Views, if you can.** A view that already returns the
  [contract column names](#how-statements-map-to-the-data-model) keeps the mapping with
  your DBA and lets a statement be as short as `SELECT * FROM dbo.ia_accounts`.
- **Network access** from the Identity Atlas worker to the server: TCP 1433 for a
  default instance, or the instance's own port. A named instance written
  `host\instance` is resolved through the SQL Browser service (UDP 1434); if that is
  firewalled, enter the port.
- **TLS.** The connection is encrypted by default. A server with a self-signed or
  internal-CA certificate needs **Trust server certificate** ticked.

There is no driver to install: the SQL Server client is part of the worker.

---

## Add the crawler

1. Go to **Admin → Crawlers**, click **Add Crawler** and pick **SQL Database**.
2. **Connection.** Fill in **Crawler Name**, **Server**, **Port** (optional) and
   **Database**. Under **Connection security** leave **Encrypt connection** on and tick
   **Trust server certificate** if needed. **Advanced (timeouts, batching, system
   name)** holds four run settings and the **System name** override.
3. **Credentials.** Enter the **Username** and **Password** of the SQL login. The
   password goes to the secrets vault, not into the stored configuration.
4. **Queries.** Click **+ Add query** for each statement, or choose a set under
   **Load example** and click **Load example queries**. Each query has a **Name**, a
   **Target**, an **Enabled** tick, the fields that target uses, the **SQL**, and an
   optional **Column mapping**. The step lists what is still wrong and only lets you
   continue when every query is valid.
5. **Schedule.** Click **+ Add Schedule** for each schedule and set its **Frequency** and **Mode**
   (**Delta (fast)** or **Full (authoritative)**), then click **Add Crawler**.
6. On the crawler's card, click **Run Full** for the first load.

The wizard has no connection test. The first run is the test: a wrong login, certificate
or firewall shows as the failure reason in the job log.

<!-- screenshot: the Queries step with the SailPoint IdentityIQ example loaded -->

### From the command line

```powershell
.\tools\crawlers\mssql\Start-SqlCrawler.ps1 `
    -ApiBaseUrl "http://localhost:3001/api" `
    -ApiKey "fgc_abc123..." `
    -JobId 0 `
    -ConfigPath ".\myconfig.json"
```

The config file holds the [settings](#settings) below as JSON, including `password`, so
keep it out of source control. A command-line run is a full run unless the file contains
`"_syncMode": "delta"`. The key is a
[crawler API key](../architecture/ingest-api.md#crawler-authentication).

---

## Settings

### Connection and run settings

| Setting | Default | In the wizard | What it does |
|---|---|---|---|
| `server` | required | **Server** | Host name or address. A named instance is written `host\instance` |
| `port` | empty | **Port** | TCP port, 1 to 65535. Empty means 1433, or SQL Browser for a named instance |
| `database` | required | **Database** | The database the statements run in |
| `username` | required | **Username** | The SQL Server login |
| `password` | required | **Password** | Its password. Stored in the vault. When you edit the crawler, leave it blank to keep the stored value |
| `encrypt` | `true` | **Encrypt connection** | TLS between the worker and SQL Server. Turn it off only for a server that cannot do TLS |
| `trustServerCertificate` | `false` | **Trust server certificate** | Accept a certificate that is not signed by a trusted CA |
| `connectTimeoutSeconds` | `30` | **Connect timeout (seconds)** | How long to wait for the connection to open (1 to 3600) |
| `commandTimeoutSeconds` | `600` | **Command timeout (seconds)** | How long the server may go without sending a row before the statement fails (0 to 86400, `0` = no limit). It is not a cap on the whole statement, so a long read that keeps flowing is not cut off |
| `batchSize` | `5000` | **Batch size** | Records per call to Identity Atlas (100 to 50000) |
| `pageSize` | `10000` | **Page size** | The value given to `@PageSize` in a statement that pages (100 to 1000000). See [Paging](#paging) |
| `systemName` | the crawler's name | **System name** | Names the system something other than the crawler. See [System naming on the SCIM page](scim.md#system-naming); it works the same way here |
| `stagedFullLoad` | `true` | no | Collects each run's assignments and applies them in one step near the end of the job, so unchanged rows are not rewritten. `false` writes every batch straight away, which is slower on large tables |
| `ingestConcurrency` | `3` | no | How many assignment and relationship batches may be on their way to Identity Atlas at once (1 to 8). `1` sends one at a time |
| `watermarkOverlapSeconds` | `900` | no | How far back of its stored position a watermarked statement re-reads (0 to 604800). It covers clock differences between the servers that write the source and transactions that commit late. Too large only costs time; too small can miss rows |
| `sweepIntervalHours` | `24` | no | The shortest time between two key sweeps of the same statement (0 to 8760). A removal at the source shows within one interval. `0` turns sweeps off |
| `sweepMaxDeleteShare` | `0.05` | no | The largest share of an assignment scope one key sweep may remove, above 0 and at most 1. Past it the job fails and the sweep removes nothing. It exists because a source read while it is rebuilding its data looks exactly like a mass revocation |
| `sweepOverride` | `false` | no | Lifts the `sweepMaxDeleteShare` limit. Set it for the one run where a large removal is real, then set it back |
| `queries` | required | **Queries** step | The statements, at least one. See below |

The six settings marked *no* are not in the wizard. Set them in the stored configuration
through the API, for example `PATCH /api/admin/crawler-configs/{id}` with
`{ "config": { "sweepIntervalHours": 12 } }`, or in the config file of a command-line
run. The wizard leaves them alone when you later edit the crawler. A configuration that
is exported and imported again goes through the wizard and loses them.

### Query settings

| Setting | Wizard label | Applies to | What it does |
|---|---|---|---|
| `name` | **Name** | all | The label in the job log |
| `target` | **Target** | all | What the rows become, see [What you get](#what-you-get) |
| `sql` | **SQL** | all | One `SELECT` statement. It may reference `@Since` and `@Offset` / `@PageSize` |
| `enabled` | **Enabled** | all | Untick to keep a query without running it. Default on |
| `columnMap` | **Column mapping** | all | Maps a column your statement returns to a contract column, so a query you already have runs unedited |
| `resourceType` | **Resource type** | `resources`, `assignments` | Required. The resource type of every row, for example `Entitlement` |
| `ownership` | **Owners from ownerId** | `resources` | Turns the `ownerId` column into an owner you can click. Default off. See [Owners](#owners) |
| `assignmentType` | **Assignment type** | `assignments` | `Direct` (default), `Indirect` or `Eligible` |
| `governed` | **Governed** | `assignments` | Marks the assignments as governed, for example business-role memberships. Default off |
| `relationshipType` | **Relationship type** | `relationships` | `Contains` (default) or `GrantsAccessTo` |
| `principalType` | **Default principal type** | `identities`, `principals` | Used when a row has no `principalType` column. Default `User` |
| `systemType` | **Default system type** | `systems` | Used when a row has no `systemType` column. Default `SQL` |
| `contextType` | **Context type** | `contexts` | Required. For example `LogicalApplication` |
| `rootDisplayName` | **Root name** | `contexts` | The name of the single root all contexts of the statement hang under. Default: the context type, pluralised |
| `targetType` | **Groups** | `contexts` | What the contexts group: `Resource` (default), `Identity`, `Principal` or `System` |
| `memberType` | **Member type** | `context-members` | What the members are, same values |
| `watermarkColumn` | **Watermark column** | all except `systems`, `contexts`, `context-members` | The returned column the crawler remembers a position in. See [Schedule and refresh](#schedule-and-refresh) |
| `sweep` | **Key sweep** | `assignments` | Periodically removes assignments the source no longer has. Only for a statement that uses `@Since`. Default off |

---

## How statements map to the data model

**Columns are matched by name.** Alias your columns to the names below. Matching ignores
case and underscores, so `display_name` satisfies `displayName`. Every other column is
kept in `extendedAttributes` under its own name; binary columns are skipped.

| Target | Required columns | Optional columns |
|---|---|---|
| `systems` | `displayName` (or `name`) | `id`, `description`, `systemType`, `tenantId`, `enabled` |
| `identities` | `id`, `displayName` (or `name`, `userId`) | `email`, `givenName`, `surname`, `department`, `jobTitle`, `companyName`, `employeeId`, `city`, `country`, `officeLocation`, `managerId`, `principalType`, `enabled` |
| `principals` | `id`, `displayName` (or `name`, `userId`) | as `identities` without `city`, `country`, `officeLocation`; plus `identityId`, `systemId` / `systemName` |
| `identity-members` | `identityId`, `principalId` | `isPrimary`, `accountType` |
| `resources` | `id`, `displayName` (or `name`) | `description`, `enabled`, `ownerId`, `systemId` / `systemName` |
| `assignments` | `resourceId`, `principalId` (or `identityId`) | `systemId` / `systemName` |
| `relationships` | `parentId`, `childId` | `systemId` / `systemName` |
| `contexts` | `displayName` (or `name`) | `id`, `description`, `ownerUserId` |
| `context-members` | `memberId`, and `contextId` or `contextName` | |

Wherever `enabled` is accepted, so are `active` and the inverses `inactive` and
`disabled`, as `bit`, `int`, `'Y'`/`'N'` or `'true'`/`'false'`. `managerId` (or
`managerExternalId`) holds the manager's key in the source, the value that is another
row's `id`.

**A query you cannot change.** Add rows under **Column mapping** (**Source column**,
**Maps to**) instead of aliasing. In JSON:
`"columnMap": { "IdentityID": "principalId", "EntitlementID": "resourceId" }`. A mapped
column is not also copied to `extendedAttributes`.

**Order does not matter.** Statements run by target in a fixed order: `systems`,
`identities`, `principals`, `resources`, `contexts`, `identity-members`,
`context-members`, `assignments`, `relationships`. An assignment or relationship can
only name ids that an earlier statement *in the same run* produced. One that names
anything else is held back and counted as **dangling** in the job log.

**Types are set per statement, not per row.** The resource type, assignment type,
governed flag and relationship type also decide which rows a refresh may remove (see
[What a refresh removes](#what-a-refresh-removes)). When one table mixes entitlements
and business roles, write two statements with a `WHERE`, not one with a type column.

**One system per connector.** Some sources aggregate other systems. Add a `systems`
statement and return a `systemId` column (the source's own key for the connector,
matching the `id` of a `systems` row) or a `systemName` column from the `principals`,
`resources`, `assignments` or `relationships` statements. Each row then lands in that
system. An assignment without one follows its resource, a relationship its parent, so
the largest statement needs no extra join. Three rules come with it:

- Ids must be unique across the whole run, not per system. Two systems using the same
  id for different things fails the run and names them.
- A row naming a system that no `systems` row created stays in the crawler's own
  system and is counted. Above 5% of a statement the run fails.
- The run needs an API key that is not limited to a fixed list of systems. A crawler
  started from the UI has one.

**Contexts.** Use at most one enabled `contexts` statement and one `context-members`
statement; the second needs the first. All contexts of the statement hang under one
root. A member names its context by id or by name (case and surrounding spaces are
ignored). A member that names no context is counted and is not an error. `ownerUserId`
may hold an account key or an employee number; the crawler resolves it to an account
from the same run, and the owner becomes the context's Accountable.

### Owners

Alias the owner column `ownerId` and tick **Owners from ownerId**. The owner then
appears as a clickable account on the resource and as an ownership row in the matrix.
The value may be an account key or an employee number of an account read in the same
run. An owner that matches no account creates nothing and is listed in the job log.

It adds three rows for every resource that has an owner, one of them a resource that
shows on the matrix's resource axis. Count before you switch it on for a large table:

```sql
SELECT COUNT_BIG(*) AS total,
       SUM(CASE WHEN owner IS NOT NULL THEN 1 ELSE 0 END) AS with_owner
FROM spt_managed_attribute;
```

### Paging

A statement runs once and streams to the end, which is the fastest way to read a large
table. If your server cuts long statements off, add
`ORDER BY <unique key> OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY`. The
crawler then reads page by page. A paged statement cannot be counted at the source, so
the [end-of-run check](#how-a-run-is-checked) reports it as not verified, and it cannot
be key swept.

---

## Schedule and refresh

**Run Full** (or a schedule in **Full** mode) reads every statement completely.

**Run Delta** (or a **Delta** schedule) also reads every statement completely, unless
the statement has a watermark. So with no watermarks the two modes do the same work.

**A watermark makes a large statement cheap to refresh.** Return a column that changes
whenever the row changes, name it in **Watermark column**, and filter on `@Since`:

```sql
SELECT ie.identity_id AS principalId, ma.id AS resourceId,
       COALESCE(ie.modified, ie.created) AS modified
FROM spt_identity_entitlement ie
JOIN spt_managed_attribute ma ON ma.application = ie.application
                             AND ma.attribute = ie.name AND ma.value = ie.value
WHERE ie.type = 'Entitlement'
  AND COALESCE(ie.modified, ie.created) >= @Since
```

- `@Since` is a whole number (`bigint`) and the column must hold **epoch milliseconds**,
  as IdentityIQ writes them. Convert a `datetime` column in the statement, for example
  with `DATEDIFF_BIG(millisecond, '1970-01-01', modified_at)`.
- The crawler stores the largest value it read, minus `watermarkOverlapSeconds`, and
  only after a run has passed its end-of-run check.
- A first run, a **Full** run and a statement whose SQL you edited all read everything.
- Both halves are required: the wizard refuses a watermark column without `@Since` and
  the other way round.
- The watermark column is not stored as an attribute. Return it a second time under
  another name if you want to keep it.

**A watermark cannot see a removal**, because a deleted row is simply no longer
returned. On an `assignments` statement, tick **Key sweep**: at most once per
`sweepIntervalHours` the crawler reads only the two id columns of the whole statement
and removes the assignments the source no longer has. Schedule the runs that sweep
outside the hours in which the source rebuilds its own data.

A workable shape: no watermark on the small statements (systems, accounts, resources,
role assignments), a watermark and key sweep on the large assignment statements, a
**Delta** schedule as often as you like, and an occasional **Full** run.

---

## What a refresh removes

A run removes rows the source no longer returns, one **scope** at a time. A scope is one
system plus a target plus the statement's types: accounts of a principal type, resources
of a resource type, assignments of one assignment type, resource type and governed flag,
or relationships of a relationship type.

| What the run read | What is removed |
|---|---|
| Every statement of the scope in full (no watermark, a first read, or a **Full** run) | Rows in the scope the run did not see. This happens in **Delta** runs too |
| A watermarked window, `assignments` with **Key sweep** | Nothing in that run, until a sweep is due. The sweep then removes what is gone, up to `sweepMaxDeleteShare` |
| A watermarked window, any other case | Nothing, until the next **Full** run |

- Removal never reaches another system's data, or another scope: an `Entitlement`
  statement cannot remove `BusinessRole` assignments.
- A scope the run wrote nothing to is left alone. Unticking **Enabled** keeps that
  query's earlier rows.
- A run that fails while reading removes nothing.
- **Identities and their account links are never removed** by this crawler. Accounts are.
- **Systems** created by a `systems` statement are never removed.
- **Contexts** and their memberships are only removed by a **Full** run, when they have
  left the catalogue. A **Delta** run adds and updates them. A membership an analyst
  added by hand is always kept.

Removed rows follow the normal lifecycle and come back if the source returns them again.
See [Soft delete](../architecture/soft-delete.md).

---

## How a run is checked

Every run ends with a table in the job log, and any `FAIL` fails the job:

```
[14:02:11] Verifying: source against database...
  ok   read: Entitlements          expected   12,000  read      12,000
  FAIL read: Accounts              expected    9,400  read       1,175
```

- **Read.** The crawler counts each statement at the source before and after reading it.
  The rows read must match, with room only for what the source itself changed meanwhile.
- **Placed.** At most 5% of a statement's rows may be dangling or lack a required column.
- **Stored.** What was read is compared with what the database now holds, per scope. For
  accounts and resources a repeated `id` fails the run: make the id column unique.

When a check fails, the rows that were loaded stay loaded and the matrix is refreshed,
but watermark positions are not stored, so the next run reads the same window again. The
rules in full are in [SQL connector internals](../architecture/sql-connector-internals.md#verification).

---

## SailPoint IdentityIQ

IdentityIQ has no crawler of its own. What ships is two example statement sets under
**Load example**, written against the standard `spt_*` tables of an IdentityIQ database
on SQL Server. They are a starting point: review every statement against your schema.

- **SailPoint IdentityIQ** uses only columns every IdentityIQ database has.
- **SailPoint IdentityIQ with organisation extensions** adds typical identity extension
  columns and loads logical applications kept in an XML catalogue record as contexts.
  The extension column names, the catalogue record name and its keys differ per
  deployment; rename them to yours.

| Query | Target | Settings | Reads |
|---|---|---|---|
| Technical applications | `systems` | | `spt_application`, one system each |
| Identities | `principals` | principal type `User` | `spt_identity`, one account each |
| Entitlements | `resources` | `Entitlement`, owners off | `spt_managed_attribute`, routed by application |
| Business roles | `resources` | `BusinessRole`, owners on | `spt_bundle` |
| Entitlement grants | `assignments` | `Direct`, watermark `modified`, key sweep | `spt_identity_entitlement` not granted by a role |
| Entitlement grants via a role | `assignments` | `Indirect`, watermark `modified`, key sweep | the same table, granted by a role |
| Role assignments | `assignments` | `Direct`, governed | `spt_identity_assigned_roles` |
| Role composition | `relationships` | `Contains` | `spt_bundle_profile_relation` |
| Logical applications, Logical application members | `contexts`, `context-members` | extensions set only | `spt_custom`, `spt_managed_attribute` |

!!! warning "Do not filter entitlements on `ma.type`"
    `spt_managed_attribute.type` is the kind of schema object an entitlement came from
    (often `group`), not a flag that says "this is an entitlement". Every row in the
    table is one. A statement ending `WHERE ma.type = 'Entitlement'` loads a small
    fraction of them, and every assignment for the rest is held back as dangling. The
    examples keep the value as the `entitlementType` attribute instead.

Things to keep when you edit the examples:

- Role assignments select only the two keys. `idx` is a position in a list and changes
  for rows nobody touched.
- Role composition uses a `LEFT JOIN`, so a relation that matches no entitlement is
  counted as skipped instead of silently disappearing.
- The logical-application statement keeps its `TOP 1` derived table and stays one
  `SELECT`, so that it can be counted at the source.

Not loaded by the examples: certifications, policies and access requests.

---

## Limitations

- **Microsoft SQL Server only**, with a SQL login. No Windows or Entra ID authentication.
- **Read-only.** Nothing is written back to the source.
- **No connection test** in the wizard; the first run is the test.
- **Types are per statement**, never per row.
- **Statements only see their own run.** An assignment cannot name a resource or account
  that another crawler imported.
- **Ids must be unique across the run**, also when rows are routed to several systems.
- **Watermarks need an epoch-millisecond column** and are not available on `systems`,
  `contexts` and `context-members`.
- **Key sweep is for `assignments` only.** A watermarked statement of another target
  loses removed rows only on a **Full** run.
- **No certifications, policies or access requests.** There is no target for them.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| *Login failed for user* | Wrong login or password, no access to the database you entered, or the server allows Windows authentication only. Enable **SQL Server and Windows Authentication mode** on the instance and map the login to a user with `SELECT` rights. |
| *The certificate chain was issued by an authority that is not trusted* | The server's certificate is self-signed or from an internal CA. Tick **Trust server certificate**. |
| *A network-related or instance-specific error* | The worker cannot reach the server, or a named instance cannot be resolved because UDP 1434 is blocked. Enter the instance's TCP port in **Port**. |
| A statement times out | The server sent no row for `commandTimeoutSeconds` (default 600): a lock wait or a slow join. Raise it, set it to `0`, or index the join columns. |
| The connection fails after a wait | `connectTimeoutSeconds` (default 30) expired. Check name resolution and routing from the worker. |
| The log reports **dangling** rows | The rows name a resource, account, parent or child that no statement in this run returned. A `WHERE` is too narrow, a query is disabled, or one side uses the id and the other the name. |
| *every row was skipped* | The statement returns no column under a required contract name. Alias the columns or add a **Column mapping**. |
| *columnMap entry '…' must map to a column name* | A mapping value in the JSON is not text. Both sides must be column names. |
| An attribute is missing from `extendedAttributes` | The column is binary, is the watermark column, or its name matches a contract column and was stored as that field. Select it a second time under another name. |
| Rows *naming an unknown system* | The row's `systemId` / `systemName` matches no `systems` row. The two statements are filtered differently, or one uses the id and the other the name. |
| *external id(s) were claimed by more than one system* | Two connectors use the same key for different things. Make the id unique, for example by prefixing the application id in the `SELECT`. |
| *Registered N system(s) but the API returned M id(s)* | Check that every `systems` row has a non-empty `displayName`. |
| *sweep skipped* | The log gives the reason: the run already read the statement in full, the statement pages, `sweepIntervalHours` is 0, or rows are routed to several systems while a `resources` statement read only a window. |
| The key sweep fails on the share limit | The sweep wanted to remove more than `sweepMaxDeleteShare`. Usually the source was rebuilding its data; run again later. If the removal is real, set `sweepOverride` for one run. |
| Rows removed at the source are still shown | The statement has a watermark. Assignments go at the next key sweep, other targets at the next **Run Full**. Also check that the last run succeeded. |
| *watermark … NOT stored* | The watermark column is missing from the result or does not hold whole numbers. The statement keeps reading in full until that is fixed. |
| A run is slow | Each statement logs a `time:` line that splits its time over the source, the crawler and Identity Atlas. See [Where the time goes](../architecture/sql-connector-internals.md#where-the-time-goes). |
| **SQL Database** is missing from **Add Crawler** | `CRAWLER_MANIFESTS_DIR` on the web container does not point at the crawler folder. |

# Syncing from a SQL database

Identity Atlas can pull authorization data out of any **Microsoft SQL Server** database
with `SELECT` statements you write yourself. There is nothing vendor-specific baked in:
you decide what each statement's rows *become* (identities, accounts, entitlements, role
memberships, role composition) by giving it a **target**, and the crawler maps the
statement's columns onto the universal data model through a fixed column contract. Any
IGA product, HR system or home-grown authorization table that lives in SQL Server can be
synced this way. SailPoint IdentityIQ ships as a worked example you can load with one
click, not as special-case code.

The crawler connects with **SQL Server authentication** (a SQL login and password) and
is built for very large tables: rows stream straight from the server into Identity Atlas
without ever being held in memory, so an entitlement-assignment table of tens of millions
of rows is a normal workload.

---

## What Gets Imported

Every statement has a **target**. The target decides which Identity Atlas objects a row
turns into:

| Target | Identity Atlas |
|---|---|
| `identities` | One **Identity** (the person), one **Principal** with the same id (the person's account in this system) and the **IdentityMember** link between them |
| `principals` | One **Principal**; with an `identityId` column, also the **IdentityMember** link to that identity |
| `identity-members` | One **IdentityMember** (links an existing identity to an existing principal) |
| `resources` | One **Resource**; `resourceType` comes from the statement (e.g. `Entitlement`, `BusinessRole`); `governanceResource` is set when it is `BusinessRole` |
| `assignments` | One **ResourceAssignment**; `assignmentType`, `governed` and `resourceType` come from the statement |
| `relationships` | One **ResourceRelationship** (parent → child); `relationshipType` comes from the statement |
| `contexts` | One **Context** (a grouping such as a logical application); `contextType` and `targetType` come from the statement. See [Contexts from a catalogue](#contexts-from-a-catalogue) |
| `context-members` | One **ContextMember**, placing a resource (or identity, principal, system) in a context named by id or by name |

Ids are the source's own keys. Every record carries them as `externalId`, and the Identity
Atlas primary key is derived from them deterministically inside a namespace private to this
system — so re-running a sync updates the same rows instead of creating new ones, and an
assignment can reference a resource by the source's key without you ever knowing an Identity
Atlas UUID. See [Deterministic GUID generation](../architecture/ingest-api.md#deterministic-guid-generation).

### The column contract

The crawler reads a statement's columns by **name**. Alias your columns to the contract
names below (`SELECT i.display_name AS displayName …`) — or, if you would rather leave the
SQL untouched, map them in the slot's [`columnMap`](#using-a-query-you-already-have) — and
the rest of the columns come along for free.

| Target | Required columns | Recognised optional columns |
|---|---|---|
| `identities` | `id`, `displayName` (falls back to `name`, then `userId`, then `id`) | `email`, `givenName`, `surname`, `department`, `jobTitle`, `companyName`, `employeeId`, `principalType`, `enabled` / `active` (or the inverse `inactive` / `disabled`) |
| `principals` | `id`, `displayName` (same fallbacks) | as above, plus `identityId` (also emits an IdentityMember link) |
| `identity-members` | `identityId`, `principalId` | `isPrimary`, `accountType` |
| `resources` | `id`, `displayName` (falls back to `name`) | `description`, `enabled` |
| `assignments` | `resourceId`, `principalId` (alias `identityId`, because an `identities` row's account shares its id) | — |
| `relationships` | `parentId`, `childId` | — |
| `contexts` | `displayName` (falls back to `name`) | `id` (a stable key; without it the normalised name is the key), `description`, `ownerUserId` |
| `context-members` | `memberId`, and `contextId` or `contextName` | — |

How columns are matched and converted:

- **Matching is case-insensitive and ignores underscores.** `display_name`, `DisplayName`
  and `displayname` all satisfy `displayName`, so a table that already uses snake_case
  column names often needs no aliasing at all.
- **Every other column lands in `extendedAttributes`** under its original name. This is
  how source-specific detail (an entitlement's application, a role's owner, a
  `created` / `modified` timestamp) is preserved and shown on the detail pages.
- `NULL` becomes `null`.
- Date and datetime columns become ISO-8601 strings.
- Wherever a boolean is expected (`enabled`, `active`, `inactive`, `disabled`, `isPrimary`),
  `bit`, `int`, `'Y'` / `'N'` and `'true'` / `'false'` are all accepted.
- **Binary columns are skipped** (`varbinary`, `image`, …) — they are never sent.

A row that is missing a required column is skipped and counted; the job log tells you how
many rows a statement dropped and why (see [Troubleshooting](#troubleshooting)). If *every*
row of a statement is skipped, the log warns and names the required columns for that
statement's target.

### Contexts from a catalogue

A source often keeps groupings in a catalogue of its own. IdentityIQ deployments, for
example, keep "logical applications" in an XML record and name each entitlement's
application inside the entitlement's own XML. The `contexts` and `context-members` targets
load such a catalogue as Contexts and place each member in its context.

- **At most one enabled statement of each.** Contexts and their memberships have no system
  column, so each is sent as one full sync; a second statement would remove the first
  one's rows. A `context-members` statement needs a `contexts` statement to resolve
  against.
- **The key.** A context's key is its `id` column when the statement returns one (prefer
  a configuration-management reference: it survives a rename), otherwise its name,
  trimmed and case-folded. The display name is always the catalogue's own spelling.
- **Matching members by name** ignores case and surrounding spaces, and is done by the
  crawler, not in SQL. A case-insensitive SQL Server collation calls "Finance" and
  "finance " equal while PostgreSQL calls them different, and the two would disagree.
- **Nothing is folded silently.** The job log reports how many source spellings differ
  from the catalogue's own and were matched anyway (with examples), how many memberships
  name a context the catalogue does not have (with the most frequent names), any name two
  catalogue entries share, and any repeated key. A member whose context is unknown keeps
  its resource and loses only the membership: the crawler never creates a context the
  catalogue lacks.

The **SailPoint IdentityIQ with organisation extensions** preset shows the pattern end to
end, including the `CROSS APPLY … nodes()` that turns one catalogue record into one row
per application.

### Using a query you already have

A statement whose columns already carry the contract names needs nothing further. When they
do not — a query your DBA has already approved that selects `IdentityID` and
`EntitlementID`, say — you do not have to rewrite it. Give the slot a **`columnMap`**: a
mapping of **source column → contract column**, and the SQL runs exactly as it is.

```json
{
  "name": "Entitlement assignments",
  "target": "assignments",
  "resourceType": "Entitlement",
  "assignmentType": "Direct",
  "sql": "SELECT ie.identity_id AS IdentityID, ma.id AS EntitlementID FROM spt_identity_entitlement ie INNER JOIN spt_managed_attribute ma ON ma.application = ie.application AND ma.attribute = ie.name AND ma.value = ie.value WHERE ie.type = 'Entitlement'",
  "columnMap": { "IdentityID": "principalId", "EntitlementID": "resourceId" }
}
```

It works for the optional columns just as well, so a column only your source knows the name
of can still drive a contract field — here the account state:

```json
"columnMap": { "SuspendedFlag": "disabled" }
```

How a mapping behaves:

- **Matching is case-insensitive and ignores underscores on both sides**, exactly like
  normal contract matching: `{ "suspended_flag": "Disabled" }` does the same thing.
- **An override wins** over a same-named column the result set already carries — you said
  explicitly which column means what.
- **A mapped column counts as consumed**, so it is *not* also copied into
  `extendedAttributes`.
- **A mapping that names a column the statement does not return is ignored**, not an error,
  so one mapping can be kept across statements that select slightly different column sets.
- **An entry whose value is not a column name** (anything other than a string) fails the
  run with `columnMap entry '<name>' must map to a column name`.

!!! tip "Aliasing and mapping are equivalent"
    `SELECT ma.id AS resourceId` and `"columnMap": { "EntitlementID": "resourceId" }` produce
    exactly the same record. The mapping exists so that a query someone else owns and has
    already signed off can be pasted in unedited; pick whichever keeps the statement
    readable for the people who maintain it.

---

## Very large tables

An entitlement-assignment table can hold **tens of millions of rows** — 40 M is a real
number in an IdentityIQ estate. The crawler is designed so that this is a normal run, not
a special case:

1. Rows stream out of a forward-only reader and are shaped one at a time. Nothing is
   collected into a list first, so memory stays flat however large the result set.
2. Every `batchSize` records (default 5 000) are sent to Identity Atlas as one
   **independent upsert**. Each batch commits on its own; if the same key turns up again
   in a later batch it is simply updated, never rejected.
3. When every statement has run cleanly and the job is a **full** sync, the crawler
   reconciles: for every target and scope it wrote to, rows in this system that the run did
   not touch — judged by their update timestamp against the API's own clock reading taken
   at job start — are soft-deleted. See [What a full sync deletes](#what-a-full-sync-deletes).

A run that fails part-way never reaches step 3, so a partial read can never delete anything.

### Paging with `@Offset` / `@PageSize`

By default a statement runs **once** and streams to the end. That is usually the fastest
option for a very large set, because `OFFSET … FETCH` makes SQL Server re-scan the skipped
rows on every page.

If your server cuts long-running statements off, or your DBA wants each statement to read
a bounded, ordered page at a time, reference the parameters `@Offset` and `@PageSize` in
the statement. The crawler binds them (`@PageSize` from the `pageSize` setting, default
10 000), runs the statement, and re-runs it with a growing offset until a page comes back
short. The rows of every page still stream.

```sql
SELECT
    ie.identity_id AS principalId,
    ma.id          AS resourceId
FROM spt_identity_entitlement ie
INNER JOIN spt_managed_attribute ma
    ON  ma.application = ie.application
    AND ma.attribute   = ie.name
    AND ma.value       = ie.value
WHERE ie.type = 'Entitlement'
ORDER BY ie.identity_id, ma.id
OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY
```

The `ORDER BY` is mandatory for `OFFSET … FETCH` and must be **stable** (a unique key or
combination), otherwise rows can be skipped or repeated between pages. Prefer plain
streaming (no `@Offset`) unless you have one of the two reasons above.

!!! tip "`commandTimeoutSeconds` will not cut a streaming read off"
    The command timeout is applied per network read, not to the whole statement, so a
    slow-but-flowing 40 M-row read is not interrupted by it. It only fires when the server
    stops sending rows for that long — a blocked query, a lock wait, a stalled join.

---

## Prerequisites

- **A SQL Server login** (SQL Server authentication; Windows / Entra ID authentication is
  not supported in this version) with `SELECT` on the tables or views the statements read.
  Use a dedicated **read-only** login — the crawler never writes to the database — and,
  ideally, point it at **views that already alias the contract columns**. A view keeps the
  Identity Atlas mapping in one place your DBA owns, hides internal tables, and lets the
  crawler's statements stay as short as `SELECT * FROM dbo.ia_identities`. Where a view is
  not on the table, an existing query can run unchanged with a per-slot
  [`columnMap`](#using-a-query-you-already-have) instead.
- **Network reachability** from the Identity Atlas worker container to the SQL Server:
  TCP 1433 for a default instance, or the instance's own port for a named instance. A named
  instance written as `host\instance` is resolved through the SQL Browser service (UDP 1434);
  if that port is firewalled, set `port` explicitly instead.
- **TLS.** Connections are encrypted by default (`encrypt: true`). An on-premises server
  with a self-signed or internal-CA certificate fails the chain check unless you tick
  **Trust server certificate** (`trustServerCertificate: true`) — or, better, install a
  certificate the worker trusts. Only turn encryption off for a server that cannot do TLS at
  all.
- The worker's PowerShell 7 already contains the SQL Server client library; there is no
  driver to install on either the Docker image or a standalone worker.

---

## Running a Sync

### Via the UI (recommended)

1. Navigate to **Admin → Crawlers**
2. Click **Add Crawler** and select **SQL Database**
3. Work through the four steps:
    - **Connection** — server, port, database, encryption and timeouts
    - **Credentials** — the SQL login and password (the password goes to the secrets
      vault, never into the stored config)
    - **Queries** — one slot per statement: a name, its target, the per-target constants
      (`resourceType`, `assignmentType`, `governed`, `relationshipType`, `principalType`)
      and the SQL. Click **Load example** and pick **SailPoint IdentityIQ** to start from
      the [worked example](#worked-example-sailpoint-identityiq) and edit from there.
    - **Schedule** — run now, or on a schedule
4. Click **Add Crawler**, then **Run now**

There is no **Test connection** button: the first job run is the connection test, and a
login, certificate or network problem shows up as the failure reason in the job log.

### Via the command line

```powershell
.\tools\crawlers\sql\Start-SqlCrawler.ps1 `
    -ApiBaseUrl "http://localhost:3001/api" `
    -ApiKey "fgc_abc123..." `
    -JobId 0 `
    -ConfigPath ".\myconfig.json"
```

The `ApiKey` is the worker API key shown on the **Admin → Settings** page. The config
file has the shape shown under [Configuration](#configuration); on the command line the
`password` is read from the file, so keep it out of source control.

---

## Configuration

### Connection and run settings

| Field | Required | Default | Description |
|---|---|---|---|
| `server` | Yes | — | SQL Server host name or address. A named instance is written `host\instance` |
| `port` | No | `1433` / instance port | TCP port. Leave empty for the default (1433) or to let a named instance resolve through SQL Browser |
| `database` | Yes | — | Database to run the queries in |
| `username` | Yes | — | SQL Server login (SQL authentication) |
| `password` | Yes | — | Password for the SQL Server login. Vaulted; never stored in the config |
| `encrypt` | No | `true` | Encrypt the connection (TLS) |
| `trustServerCertificate` | No | `false` | Accept a server certificate that is not signed by a trusted CA (self-signed on-premises servers) |
| `connectTimeoutSeconds` | No | `30` | Seconds to wait for the connection to open (1–3600) |
| `commandTimeoutSeconds` | No | `600` | Seconds to wait for each query, `0` = no limit (0–86400). Applies per network read, so a streaming query is not cut off as a whole |
| `systemName` | No | the crawler's name | Override for the Identity Atlas system name — see [System naming](#system-naming) |
| `batchSize` | No | `5000` | Records per ingest call (100–50 000). Rows stream from SQL Server and are flushed every batch, so memory stays flat however large the result set |
| `pageSize` | No | `10000` | Value bound to `@PageSize` for a query that pages with `@Offset` / `@PageSize` (100–1 000 000) |
| `queries` | Yes | — | The statements to run, one per object type (at least one) — see below |

### Query slots (`queries[]`)

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | — | Label shown in the job log |
| `target` | Yes | — | Which Identity Atlas object type the rows become: `identities`, `principals`, `identity-members`, `resources`, `assignments`, `relationships`, `contexts` or `context-members` |
| `sql` | Yes | — | A `SELECT` statement. Reference `@Offset` and `@PageSize` to have the crawler page through it |
| `columnMap` | No | — | Object of `{ "<source column>": "<contract column>" }` mapping the names this statement's `SELECT` actually returns onto the contract names, so an existing query can run unedited — see [Using a query you already have](#using-a-query-you-already-have) |
| `enabled` | No | `true` | Set to `false` to keep a slot in the config without running it |
| `resourceType` | `resources`, `assignments` | — | The `resourceType` every row gets, e.g. `Entitlement`, `BusinessRole` |
| `assignmentType` | `assignments` | `Direct` | How the principal holds the resource: `Direct`, `Indirect` or `Eligible` |
| `governed` | `assignments` | `false` | The assignment is governed (a business-role membership rather than a raw entitlement) |
| `relationshipType` | `relationships` | `Contains` | Parent → child link type: `Contains` or `GrantsAccessTo` |
| `contextType` | `contexts` | — | The `contextType` every context gets, e.g. `LogicalApplication`. Required on a `contexts` statement |
| `targetType` | `contexts` | `Resource` | What the contexts group: `Resource`, `Identity`, `Principal` or `System` |
| `memberType` | `context-members` | the `targetType` | What the members are, same values |
| `principalType` | `identities`, `principals` | `User` | Default `principalType` when the row has no `principalType` column. One of `User`, `ServicePrincipal`, `ManagedIdentity`, `WorkloadIdentity`, `AIAgent`, `ExternalUser`, `SharedMailbox` |

#### Why the type fields are per statement, not per row

`resourceType`, `assignmentType`, `governed` and `relationshipType` are **constants for
the whole statement** on purpose. Together with the target they form the **reconcile
scope** of a full sync: when the run is over, the crawler deletes the rows in *this*
statement's scope that the run did not touch. If a row could override its own type, one
statement's reconcile would delete rows that belong to another. So when a source mixes
entitlements and business roles in one table, write two statements with a `WHERE` on the
type column rather than one statement with a type column in the `SELECT`.

Two statements with the **same** target and scope are fine — the reconcile runs once per
scope after both have streamed, so a source split over two tables (or two databases on the
same server) can still be one scope.

#### Slot ordering and dangling references

Slots run grouped by target in dependency order, **regardless of the order you configure
them in**:

`identities` → `principals` → `resources` → `identity-members` → `assignments` → `relationships`

The crawler remembers every resource id and principal id it emitted during the run. An
assignment or relationship that names an id it has not seen is **skipped and counted** —
logged as `dangling` — and never sent. So an assignment statement can only join to
resources and principals that an earlier slot in the *same run* produced; if the log
reports a large dangling count, the resource or principal statement is missing rows (or
the keys do not match — see [Troubleshooting](#troubleshooting)).

### System naming

The Identity Atlas **system** this crawler registers is named after the crawler itself:
name the crawler *IdentityIQ production* and that is what the Systems list shows, so
several SQL crawlers side by side stay distinguishable. Fill in the optional **System
name** field (`systemName`) only to label the system as something other than the crawler;
it is an override and always wins. This works the same way as for the other pull crawlers —
see [System naming on the SCIM page](scim.md#system-naming) for the full explanation.

### Example

```json
{
  "server": "sql-iiq.corp.example.com",
  "port": 1433,
  "database": "identityiq",
  "username": "ia_reader",
  "password": "...",
  "encrypt": true,
  "trustServerCertificate": true,
  "connectTimeoutSeconds": 30,
  "commandTimeoutSeconds": 600,
  "systemName": "IdentityIQ",
  "batchSize": 5000,
  "pageSize": 10000,
  "queries": [
    {
      "name": "Identities",
      "target": "identities",
      "principalType": "User",
      "sql": "SELECT i.id, i.display_name AS displayName, i.name AS userId, i.email, i.inactive FROM spt_identity i WHERE i.is_workgroup = 0"
    },
    {
      "name": "Entitlements",
      "target": "resources",
      "resourceType": "Entitlement",
      "sql": "SELECT ma.id, COALESCE(NULLIF(ma.displayable_name, ''), ma.value) AS displayName, ma.attribute AS attributeName FROM spt_managed_attribute ma WHERE ma.type = 'Entitlement'"
    },
    {
      "name": "Entitlement assignments",
      "target": "assignments",
      "resourceType": "Entitlement",
      "assignmentType": "Direct",
      "governed": false,
      "sql": "SELECT ie.identity_id AS principalId, ma.id AS resourceId FROM spt_identity_entitlement ie INNER JOIN spt_managed_attribute ma ON ma.application = ie.application AND ma.attribute = ie.name AND ma.value = ie.value WHERE ie.type = 'Entitlement'"
    },
    {
      "name": "Role hierarchy",
      "target": "relationships",
      "relationshipType": "Contains",
      "enabled": false,
      "sql": "SELECT bc.bundle AS parentId, bc.child AS childId FROM spt_bundle_children bc"
    }
  ]
}
```

---

## Worked example: SailPoint IdentityIQ

The **Load example → SailPoint IdentityIQ** action in the Queries step fills in the seven
statements below, written against the standard `spt_*` tables. They are a starting point,
not a schema guarantee: IdentityIQ stores **extended identity attributes in
customer-specific columns** on `spt_identity` (and on `spt_managed_attribute` /
`spt_bundle`), so the comments in the SQL show where to add yours. Anything you add lands
in `extendedAttributes` under its own name.

Every statement below **aliases its columns to the contract names** (`ie.identity_id AS
principalId`). If you already have your own version of one of these queries and would
rather not touch it, paste it as it is and add the equivalent
[`columnMap`](#using-a-query-you-already-have) instead — for an entitlement-assignments
query that selects `IdentityID` and `EntitlementID`, that is
`"columnMap": { "IdentityID": "principalId", "EntitlementID": "resourceId" }`.

### Identities

Target `identities`, default `principalType` `User`. Every non-workgroup identity becomes
an Identity plus its IdentityIQ account; `inactive` drives the enabled flag, `managerId`,
`created` and `modified` land in `extendedAttributes`.

```sql
SELECT
    i.id,
    i.display_name AS displayName,
    i.name         AS userId,
    i.firstname    AS givenName,
    i.lastname     AS surname,
    i.email,
    i.manager      AS managerId,
    i.inactive,
    i.created,
    i.modified
    -- Extended identity attributes are customer-specific columns on spt_identity.
    -- Add them here; they are stored under their own name, e.g.
    --   , i.jobtitle AS jobTitle, i.departmentnumber AS department, i.companyname AS companyName
FROM spt_identity i
WHERE i.is_workgroup = 0
```

### Entitlements

Target `resources`, `resourceType` `Entitlement`. Each managed attribute of type
`Entitlement` (an AD group, an application role, a permission value) becomes a Resource;
the owning application and owner identity ride along as extended attributes.

```sql
SELECT
    ma.id,
    COALESCE(NULLIF(ma.displayable_name, ''), ma.value) AS displayName,
    ma.value             AS entitlementValue,
    ma.attribute         AS attributeName,
    ma.type              AS entitlementType,
    app.id               AS applicationId,
    app.name             AS applicationName,
    owner.id             AS ownerId,
    owner.display_name   AS ownerName,
    ma.requestable,
    ma.aggregated,
    ma.uncorrelated,
    ma.created,
    ma.modified
FROM spt_managed_attribute ma
LEFT JOIN spt_application app ON app.id = ma.application
LEFT JOIN spt_identity owner  ON owner.id = ma.owner
WHERE ma.type = 'Entitlement'
```

### Business roles

Target `resources`, `resourceType` `BusinessRole`. Every bundle (business, IT and
organizational roles alike — filter on `b.type` if you want only some) becomes a
governance resource.

```sql
SELECT
    b.id,
    COALESCE(NULLIF(b.display_name, ''), b.name) AS displayName,
    b.name          AS roleName,
    b.type          AS roleType,
    b.disabled,
    b.owner         AS ownerId,
    i.display_name  AS ownerName,
    b.created,
    b.modified
FROM spt_bundle b
LEFT JOIN spt_identity i ON i.id = b.owner
```

### Entitlement assignments

Target `assignments`, `resourceType` `Entitlement`, `assignmentType` `Direct`,
`governed` `false`. This is the identity ↔ entitlement table and usually the largest one
in the database; it streams without paging.

```sql
-- This is usually the largest table (tens of millions of rows). The rows stream
-- straight through, so no paging is needed; add
--   ORDER BY ie.identity_id, ma.id OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY
-- only if your server cuts long-running statements off.
SELECT
    ie.identity_id AS principalId,
    ma.id          AS resourceId
FROM spt_identity_entitlement ie
INNER JOIN spt_managed_attribute ma
    ON  ma.application = ie.application
    AND ma.attribute   = ie.name
    AND ma.value       = ie.value
WHERE ie.type = 'Entitlement'
```

### Role assignments

Target `assignments`, `resourceType` `BusinessRole`, `assignmentType` `Direct`,
`governed` `true`. The identity's assigned roles become governed memberships of the
business-role resources.

```sql
SELECT
    identity_id AS principalId,
    bundle      AS resourceId,
    idx
FROM spt_identity_assigned_roles
```

### Role composition

Target `relationships`, `relationshipType` `Contains`. Links a bundle to the entitlement
profile it grants, so a business role shows which entitlements it contains.

```sql
SELECT
    bpr.bundle_id         AS parentId,
    bpr.source_profile_id AS childId,
    bpr.attribute         AS entitlementAttribute,
    bpr.value             AS entitlementValue,
    bpr.display_value     AS entitlementName
FROM spt_bundle_profile_relation bpr
```

### Role hierarchy

Target `relationships`, `relationshipType` `Contains`. Parent bundle → child bundle, so
nested roles keep their hierarchy.

```sql
SELECT
    bc.bundle AS parentId,
    bc.child  AS childId,
    bc.idx
FROM spt_bundle_children bc
```

---

## Scheduling and sync mode

Schedules work exactly as they do for every pull crawler. A **full** sync streams every
statement and then reconciles (below). A **delta** sync streams every statement and
upserts what it finds, but skips the reconcile, so nothing is ever deleted by a delta run.
There is no change feed to read — a delta run re-reads the statements in full — so the
difference is purely whether removed rows are cleaned up. A common pattern is a nightly
full sync; use delta runs only when you want to refresh attributes between full syncs
without paying for the reconcile.

After each run the `buildContexts` post-sync hook rebuilds the generated contexts
(departments, org chart, clusters) so the imported data is visible in the matrix straight
away.

---

## What a full sync deletes

A full sync reconciles **per scope**: for every combination of target and the statement's
constants (`resourceType`, `assignmentType`, `governed`, `relationshipType`) that the run
wrote to, rows in this crawler's own system whose last update is older than the moment the
job started are soft-deleted. Those are exactly the rows this run did not touch. The
reference time is the Identity Atlas API's own clock, read at job start, so clock skew
between the worker and the web container cannot cause false deletes.

What this means in practice:

- The delete is scoped to **this crawler's system** — data from Entra ID, Omada, midPoint,
  CSV or another SQL crawler is never touched.
- It is further scoped to the statement's **type constants**: an `Entitlement`
  assignment statement can never delete `BusinessRole` assignments, a `Direct` statement
  never deletes `Eligible` rows.
- **Identities and IdentityMembers are never deleted** by this crawler. They have no owning
  system, so — as for midPoint and CSV — they are upsert-only. Accounts (Principals) *are*
  reconciled.
- A scope that this run did not write to at all (a disabled slot, for instance) is not
  reconciled either, so disabling a statement keeps its earlier rows rather than deleting
  them; delete the crawler's data from **Admin → Data** if you want them gone.
- A run that fails part-way never reconciles, so a half-read never deletes anything.

Soft-deleted rows follow the normal lifecycle — tombstoned, revived on the next run that
sees them again, purged after the retention window. See
[Soft delete](../architecture/soft-delete.md).

---

## Limitations (v1)

- **Microsoft SQL Server only.** PostgreSQL, Oracle, MySQL and other engines are not
  supported in this version, and neither is Windows / Entra ID authentication to SQL
  Server — use a SQL login.
- **No Test connection button** in the wizard. The web container carries no SQL Server
  driver, so the first job run is the connectivity check.
- **Type fields are per statement.** `resourceType`, `assignmentType`, `governed` and
  `relationshipType` cannot vary per row (see [why](#why-the-type-fields-are-per-statement-not-per-row)); split the statement instead.
- **Binary columns are skipped** — they are never stored in `extendedAttributes`.
- **Read-only.** The crawler only ever runs your `SELECT` statements; nothing is written
  back to the database.
- **No org units, certifications or policies.** Those governance objects have no target
  in this version; identities, accounts, resources, assignments and relationships do.
- **Cross-statement references only.** An assignment or relationship must name ids that
  another statement in the same run produced — it cannot point at a resource imported by a
  different crawler.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The job fails with *Login failed for user* | Wrong login or password, the login has no access to the `database` you entered, or the server only allows Windows authentication. Check that **SQL Server and Windows authentication mode** is enabled on the instance and that the login is mapped to a user in that database with `SELECT` rights. |
| The job fails with *The certificate chain was issued by an authority that is not trusted* (or a similar TLS error) | The server's certificate is self-signed or from an internal CA the worker does not trust. Tick **Trust server certificate** (`trustServerCertificate: true`), or install the CA certificate in the worker. |
| The job fails with *A network-related or instance-specific error* / cannot connect to a named instance | The worker cannot reach the server, or the named instance is resolved through the SQL Browser service (UDP 1434) and that port is firewalled. Set `port` to the instance's TCP port explicitly, and check the worker container can reach it (`Test-NetConnection` from a shell in the worker). |
| A statement times out | `commandTimeoutSeconds` (default 600) fires when the server stops sending rows for that long — a lock wait, a blocked or badly-planned join. Raise it, set it to `0` to disable, or fix the query plan (an index on the join columns is usually the answer for the assignment table). A slow-but-streaming read is *not* affected. |
| Connection opens slowly and then fails | `connectTimeoutSeconds` (default 30) expired. Check name resolution and routing from the worker; raise it only if the server really is that slow to accept connections. |
| The log reports a `dangling` count on an assignments or relationships slot | Rows named a `resourceId`, `principalId`, `parentId` or `childId` that no earlier slot in the same run emitted. Either the resource / principal statement is missing those rows (a `WHERE` too narrow, a slot disabled), or the keys do not match (one side uses the id, the other the name). Compare the values in the two statements. |
| A slot logs that all its rows were skipped (the log warns and names the target's required columns) | The statement has no `id` or `displayName` column under a name the contract recognises (for `identities` / `principals` / `resources`), or no `resourceId` / `principalId` (`assignments`), `parentId` / `childId` (`relationships`), `identityId` / `principalId` (`identity-members`). Either alias the columns to the contract names — matching ignores case and underscores, but the name must otherwise be exact — or, to leave the SQL alone, add a [`columnMap`](#using-a-query-you-already-have) to the slot pointing the columns it does return at the contract names. |
| The job fails with *columnMap entry '…' must map to a column name* | That `columnMap` entry's value is not a column name (it is a number, a boolean, an object or `null`). Every entry must read `"<source column>": "<contract column>"`, with both sides plain strings. |
| Attributes I expected are missing from `extendedAttributes` | Binary columns are skipped, and a column whose name matches a contract column — or that a `columnMap` entry points at one — is stored as that field instead. Rename the column in the `SELECT` (or select it twice under two names) if you want both. |
| The system shows up under the wrong name | The system is named after the crawler unless `systemName` is set — see [System naming](#system-naming). |
| Rows I removed from the source are still in Identity Atlas | Only a **full** sync reconciles; a delta run never deletes. Also check that the run completed cleanly — a failed run skips the reconcile. |
| **SQL Database** is not visible in **Add Crawler** | The `CRAWLER_MANIFESTS_DIR` environment variable on the web container must point to the folder containing the crawler manifests. See [Docker setup](../architecture/docker-setup.md). |

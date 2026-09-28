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
| `systems` | One **System** per technical connector in the source. Later statements send their rows to these instead of to the crawler's own system. See [One system per connector](#one-system-per-connector) |
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
| `systems` | `displayName` (falls back to `name`) | `id` (the key later statements route by; without it the normalised name is the key), `description`, `systemType`, `tenantId`, `enabled` / `active` (or the inverse) |
| `identities` | `id`, `displayName` (falls back to `name`, then `userId`, then `id`) | `email`, `givenName`, `surname`, `department`, `jobTitle`, `companyName`, `employeeId`, `principalType`, `enabled` / `active` (or the inverse `inactive` / `disabled`) |
| `principals` | `id`, `displayName` (same fallbacks) | as above, plus `identityId` (also emits an IdentityMember link), `systemId` / `systemName` |
| `identity-members` | `identityId`, `principalId` | `isPrimary`, `accountType` |
| `resources` | `id`, `displayName` (falls back to `name`) | `description`, `enabled`, `ownerId` (only turned into an owner link when the slot sets [`ownership`](#owners-who-controls-this-resource)), `systemId` / `systemName` |
| `assignments` | `resourceId`, `principalId` (alias `identityId`, because an `identities` row's account shares its id) | `systemId` / `systemName` |
| `relationships` | `parentId`, `childId` | `systemId` / `systemName` |
| `contexts` | `displayName` (falls back to `name`) | `id` (a stable key; without it the normalised name is the key), `description`, `ownerUserId` (an account key or an employee number — the crawler resolves either) |
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

### One system per connector

Some sources are themselves aggregators. A SailPoint IdentityIQ database has one
`spt_application` row per connected system, and every entitlement in it belongs to one of
them. Loaded as a single flat Identity Atlas system, the first question an analyst asks —
*which application is this entitlement in?* — has no answer.

A `systems` statement creates one Identity Atlas system per connector, and the other
statements say which one each row belongs to:

```json
{ "name": "Technical applications", "target": "systems",
  "sql": "SELECT a.id, a.name AS displayName, a.type AS applicationType, a.connector FROM spt_application a" }

{ "name": "Entitlements", "target": "resources", "resourceType": "Entitlement",
  "sql": "SELECT ma.id, ma.displayable_name AS displayName, ma.application AS systemId FROM spt_managed_attribute ma" }
```

**Routing columns.** On `principals`, `resources`, `assignments` and `relationships`:

| Column | What it holds |
|---|---|
| `systemId` | The **source's own key** for the connector — the value that matches a `systems` row's `id`. Not an Identity Atlas id, which a query cannot know. |
| `systemName` | The connector's name, matched to a `systems` row's `displayName` ignoring case and surrounding spaces. |

`systemId` wins when a row carries both. A row carrying neither stays in the crawler's own
system — which is how a directory statement keeps its accounts where they belong. Both
columns are *also* kept in `extendedAttributes`, so nothing that used to be visible on the
detail page disappears when you start routing.

**An assignment follows its resource, and a relationship its parent.** Neither needs a
routing column of its own: a grant belongs to whatever grants it. This matters because the
grant table is usually the largest in the source — tens of millions of rows — and adding a
join to it to carry a column the crawler can already work out would be the most expensive
change in the run.

**Identities, identity members and contexts are never routed.** Those tables have no
`systemId` column at all: an identity is a person, not an account in a system, and a
context (a logical application) deliberately spans connectors.

#### Ids are unique per run, not per system

Identity Atlas keys are derived from the source's own ids inside one namespace **per
crawler run**. That is what lets a grant join a principal in the directory system to an
entitlement in a connector system: both halves are derived the same way, whichever system
each row was stored in.

The consequence is that **an external id must identify one thing across the whole run**. If
two connectors both used the entitlement id `GRP-1`, the two rows would derive the same
Identity Atlas id and one would silently replace the other. IdentityIQ ids are globally
unique, so this holds there. The crawler does not assume it: it records every id that two
systems claim and **fails the run** naming them, in the same verification table as the
other count checks.

#### What routing does not change

Nothing about an existing configuration. Without a `systems` statement there is no routing:
a `systemId` column is just another attribute, every row goes to the crawler's own system,
and the ids a run generates are exactly the ones it generated before. Adding a `systems`
statement to a configuration that has been running does **not** rewrite the ids of anything
already loaded either — it moves rows to their new systems and leaves their ids alone.

#### When a row names a system that does not exist

The row is kept, loaded into the crawler's own system, and counted. The job log names the
system references it could not place and how many rows named each. Above 5% of a
statement's rows the job **fails**: at that point the `systems` statement and that one
plainly disagree about which connectors exist — usually because one is filtered more
narrowly than the other.

#### Full syncs with routing

A full sync reconciles **per system**: one pass per system a statement actually wrote to.
A system that was registered but received no rows this run is left alone rather than
emptied, and a routed system's stale rows are removed rather than being left behind
forever. A connector that disappears from the source keeps its (now empty) system; systems
are never deleted by a sync.

**The crawler's API key must not be restricted to a fixed list of systems.** Such a key
cannot write to a system it has just created, and the ingest refuses the batch. The
built-in worker key is unrestricted, so a crawler run from the UI is fine.

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
- **One root, so a catalogue is a tree.** Every context a `contexts` statement produces
  hangs under a single root context, named by the statement's **Root name**
  (`rootDisplayName`, defaulting to the context type, pluralised). Without it a catalogue
  of 1,500 logical applications loads as 1,500 top-level rows. The root is a synced
  context of the *same* `contextType`, owned by the same system and sent in the same
  batch as its children — that is what keeps a re-run from removing it, because the full
  sync's reconcile is bounded by (variant, `contextType`, system). An empty catalogue
  gets no root.
- **The owner is resolved to an account.** A catalogue usually names its owner the way a
  person is named on paper — IdentityIQ's names it by employee number (`spt_identity.name`)
  while every account is keyed on the identity id (`spt_identity.id`). The crawler
  translates one into the other against the accounts the same run has already read, so
  `ownerUserId` holds something the UI can turn into a person. An owner that matches no
  account is **kept exactly as the source spells it** and counted in the job log — never
  dropped, never invented.
- **Nothing is folded silently.** The job log reports how many source spellings differ
  from the catalogue's own and were matched anyway (with examples), how many memberships
  name a context the catalogue does not have (with the most frequent names), any name two
  catalogue entries share, and any repeated key. A member whose context is unknown keeps
  its resource and loses only the membership: the crawler never creates a context the
  catalogue lacks.

The **SailPoint IdentityIQ with organisation extensions** preset shows the pattern end to
end, including the `CROSS APPLY … nodes()` that turns one catalogue record into one row
per application.

### Owners: who controls this resource

Most sources record an owner on an entitlement, a role or an application, as a column
holding an identifier. Selected as an ordinary column it lands in `extendedAttributes`,
which means the resource's page shows a string like `0ae16562ed5bff…` where a person
belongs.

Alias that column **`ownerId`** and tick **Owners from ownerId** on the statement
(`"ownership": true`) and the crawler makes it a real link instead:

```
Resources(<your resourceType>)          the resource the statement loaded
  └─ ResourceRelationships(HasOwnership)
       └─ Resources(ResourceOwnership)  named after the resource it belongs to
            └─ ResourceAssignments(Direct)   ← the owner
```

That is the same shape Identity Atlas already uses for the owners of an Entra group, so
everything that reads ownership reads this for free: the owner appears as a clickable
account on the resource, the matrix gets an ownership **row** for the resource (a normal
**D** badge — [Owner rows are their own resource](../architecture/matrix.md#owner-rows-are-their-own-resource)),
the risk engine counts the owner as control rather than as access, and a report can ask
"which entitlements have no owner".

A few things worth knowing:

- **The owner value may be an account key or an employee number.** The crawler tries the
  account's own key first, then the employee number, against the accounts *this run* has
  already read — never in SQL, so one statement works for both. (IdentityIQ's entitlements
  name the owner by identity id; its logical-application catalogue names the same people by
  employee number.)
- **An owner matching no account produces nothing, and says so.** The job log names the
  values and how many resources carry each. No owner is invented, and no ownership row is
  created with nobody on it. The raw `ownerId` — and whatever `ownerName` your statement
  selected next to it — stay in `extendedAttributes` either way, so nothing is lost.
- **An owner statement needs an accounts statement.** Without a `principals` or
  `identities` statement in the same run there is nothing to match against; the log says
  so rather than reporting every owner as wrong.
- **It is a resources-statement flag.** The owner of an *assignment* is not a concept;
  ownership belongs to the thing owned.
- **A repeat run changes nothing.** The ownership resource's id is derived from the owned
  resource's, so a second run upserts the same rows. The reconcile of the owner rows is
  its own scope (`ResourceOwnership` / `HasOwnership`), so it can never touch the resources
  themselves, the grants, or another statement's rows.

#### What owners cost

Three rows per resource that has an owner: an ownership resource, a relationship and an
assignment. That is small per resource and large in aggregate, which is why it is off
unless the statement asks.

Measured on the IdentityIQ-shaped fixture at 10% scale (`tools/iiq-fixture/`), counted in
PostgreSQL after the run:

| | Entitlements | Business roles |
|---|---:|---:|
| Resources loaded | 80,000 | 1,000 |
| …of which carry an owner | 48,033 (60%) | 1,000 (100%) |
| Extra rows (resource + link + assignment) | **144,099** | **3,000** |

Scaled to a production catalogue of **805,497** entitlements at the same 60% share, that is
roughly **1.45 million extra rows**. In a load that already carries 40 million assignment
rows it is about 3.5% more rows overall — but it is **+60% on the `Resources` table**, and
those rows appear on the matrix's resource axis and in the resource list. Neither number is
a reason not to do it; both are reasons to decide it rather than inherit it.

The shipped IdentityIQ presets therefore turn owners **on for business roles** (thousands
of rows, every one with an owner) and leave them **off for entitlements**, with the
`ownerId` column already selected so switching them on is one checkbox.

> The 60% share is the fixture's parameter (`ownedShare`), chosen to be realistic rather
> than measured against a production catalogue. Run the statement below against your own
> source before you switch it on:
>
> ```sql
> SELECT COUNT_BIG(*) AS total,
>        SUM(CASE WHEN owner IS NOT NULL THEN 1 ELSE 0 END) AS with_owner
> FROM spt_managed_attribute;
> ```

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

## Verification: source against database

Every run ends with two checks, and each one catches a failure the other cannot see.

**Did the crawler read everything?** After each statement the crawler asks SQL Server
how many rows the statement returns, and compares that with the rows it read. A read
that stops early looks exactly like one that finished: every row that did arrive is
distinct, lands, and agrees with the database. Only the source's own count shows the
gap. This check found a defect in which a worker job read 22,087 of 176,703
identities and reported success. For an assignment statement the same query also
returns the distinct (resource, principal) pairs, so the largest table is scanned once
more, not twice.

**Did everything read reach the database?** Then, one reconcile scope at a time
(principals of a type, resources of a type, assignments of a type, relationships of a
type), what was read is compared with what Identity Atlas now holds. The counts come
from the database, not from the ingest's own inserted/updated totals: rows that share a
key collapse into one row but would still be counted as sent.

| Check | Expected |
|---|---|
| Read, per statement | The rows `SELECT COUNT_BIG(*)` over the statement returns, asked right after the read. A source that changes during the run can also make these differ; re-run to tell the two apart |
| Placed, per statement | At most **5%** of the rows read may be held back: as dangling (they name a resource or principal the run did not load) or skipped (a required column is empty). More means the statements disagree about what exists, for example an entitlement statement that filters out most entitlements while the grant statement does not. A little is normal, e.g. grants held by workgroups that the principals statement leaves out. This bound is also what makes an assignment count with dangling rows an assertion rather than an open range |
| Principals, resources, relationships | The number of **distinct** keys the statement returned. If it returned more rows than distinct keys, the run fails: rows sharing an id overwrite each other, so all but one of them are lost. Make the id column unique |
| Assignments | The source's distinct (resource, principal) pairs. Rows held back as dangling make this a range rather than an exact number |

A statement that pages with `@Offset` cannot be wrapped in a count, so its read and its
assignment scope are reported as not verified rather than guessed at.

The job log ends with a table like this, and **any `FAIL` fails the job**:

```
Verifying: source against database...
  FAIL read: Identities                               expected      176,703  read           22,087
       the crawler read 22,087 rows but the source returns 176,703. Either the read
       stopped early or the source changed during the run; ...
  ok   read: Entitlements                             expected       80,000  read           80,000
  ok   resources (resourceType=Entitlement)           expected       80,000  database       80,000
  ok   principals (principalType=User)                expected       22,087  database       22,087
```

The data that did load stays loaded; the failure tells you the load is incomplete. A
delta run is verified the same way, against the rows it touched. Identities and Contexts
have no system column and are not counted per system; the context report (see
[Contexts from a catalogue](#contexts-from-a-catalogue)) covers the catalogue.

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
| `watermarkOverlapSeconds` | No | `900` | How far back of its last position each incremental read goes, to cover clock drift between the source's application servers and transactions that commit late (0–604 800) — see [Reading only what changed](#reading-only-what-changed) |
| `sweepIntervalHours` | No | `24` | How often a query with **Key sweep** on reads its complete key set to find what the source no longer has. A removal shows within one interval. `0` disables the sweep (0–8760) |
| `sweepMaxDeleteShare` | No | `0.05` | The largest share of a scope a sweep may remove before it refuses and writes nothing |
| `sweepOverride` | No | `false` | Let a sweep remove any share of a scope, for the one run where a large removal is known to be real |
| `queries` | Yes | — | The statements to run, one per object type (at least one) — see below |

### Query slots (`queries[]`)

| Field | Required | Default | Description |
|---|---|---|---|
| `name` | Yes | — | Label shown in the job log |
| `target` | Yes | — | Which Identity Atlas object type the rows become: `identities`, `principals`, `identity-members`, `resources`, `assignments`, `relationships`, `contexts` or `context-members` |
| `sql` | Yes | — | A `SELECT` statement. Reference `@Offset` and `@PageSize` to have the crawler page through it; reference `@Since` (with `watermarkColumn`) to have it read only what changed |
| `watermarkColumn` | No | — | The returned column whose largest value this run remembers, so the next run binds `@Since` to it, e.g. `modified`. The statement must reference `@Since`. Empty means read in full every run — see [Reading only what changed](#reading-only-what-changed) |
| `sweep` | `assignments` | `false` | Periodically read this statement's complete key set and remove the assignments the source no longer has. A windowed assignments query needs this, because a watermark cannot see a removal |
| `columnMap` | No | — | Object of `{ "<source column>": "<contract column>" }` mapping the names this statement's `SELECT` actually returns onto the contract names, so an existing query can run unedited — see [Using a query you already have](#using-a-query-you-already-have) |
| `enabled` | No | `true` | Set to `false` to keep a slot in the config without running it |
| `resourceType` | `resources`, `assignments` | — | The `resourceType` every row gets, e.g. `Entitlement`, `BusinessRole` |
| `ownership` | `resources` | `false` | Turn the statement's `ownerId` column into a real owner you can click, instead of leaving it as an attribute. Costs three extra rows per resource that has an owner — see [Owners](#owners-who-controls-this-resource) |
| `assignmentType` | `assignments` | `Direct` | How the principal holds the resource: `Direct`, `Indirect` or `Eligible` |
| `governed` | `assignments` | `false` | The assignment is governed (a business-role membership rather than a raw entitlement) |
| `relationshipType` | `relationships` | `Contains` | Parent → child link type: `Contains` or `GrantsAccessTo` |
| `contextType` | `contexts` | — | The `contextType` every context gets, e.g. `LogicalApplication`. Required on a `contexts` statement |
| `targetType` | `contexts` | `Resource` | What the contexts group: `Resource`, `Identity`, `Principal` or `System` |
| `rootDisplayName` | `contexts` | the `contextType`, pluralised | What the single root every context hangs under is called, e.g. `Logical Applications` |
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

`systems` → `identities` → `principals` → `resources` → `contexts` → `identity-members` →
`context-members` → `assignments` → `relationships`

`systems` runs first because everything after it may name one of the systems it creates.
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

A `systems` statement adds further systems beside this one, named by the source (see
[One system per connector](#one-system-per-connector)). The crawler's own system is still
registered and still holds everything that is not routed elsewhere — the identities, and
anything a row does not place.

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
      "sql": "SELECT ma.id, COALESCE(NULLIF(ma.displayable_name, ''), ma.value) AS displayName, ma.attribute AS attributeName FROM spt_managed_attribute ma"
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
an Identity plus its IdentityIQ account; `inactive` drives the enabled flag, and `created`
and `modified` land in `extendedAttributes`.

`spt_identity.manager` holds another identity's `id`, which is exactly what the rows are
keyed on, so aliasing it `managerId` (or `managerExternalId`) fills the manager
relationship on both halves of the row — the account's manager and the person's manager.
Order does not matter: a manager further down the result set links just the same. A row
naming itself is dropped; a manager your `WHERE` clause excluded (a workgroup, a leaver)
leaves the field empty and is counted in the job's warnings rather than stored as a link
to nobody.

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
```

!!! warning "Do not filter on `ma.type`"
    `spt_managed_attribute.type` is the schema object type an entitlement came from, not
    "is this an entitlement". In a real instance most rows are `group`, then `role`,
    `workgroup` and site-specific types, and `Entitlement` can be a tiny minority. A
    statement ending `WHERE ma.type = 'Entitlement'` loaded 454 of 805,497 entitlements in
    production, and every grant for the rest was held back as dangling. The type is kept as
    the `entitlementType` column instead. The run now fails when most of a statement's rows
    cannot be placed (see [Verification](#verification-source-against-database)).

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

The preset ships this statement with **Owners from ownerId** ticked
(`"ownership": true`), so `b.owner` becomes an owner you can click rather than a hex
string — see [Owners](#owners-who-controls-this-resource). The entitlements statement
above selects `ma.owner AS ownerId` in the same way but leaves the box unticked, because
there are two to three orders of magnitude more entitlements than roles; tick it when you
want entitlement owners and have read [what it costs](#what-owners-cost).

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

Target `relationships`, `relationshipType` `Contains`. Links a bundle to each entitlement
it grants, so a business role shows which entitlements it contains. Each relation row names
the entitlement by `source_application` + `attribute` + `value`, the same three columns a
grant joins on. `source_profile_id` is a *profile* id and `display_value` a name, so neither
resolves to an entitlement.

```sql
SELECT
    bpr.bundle_id         AS parentId,
    ma.id                 AS childId,
    bpr.attribute         AS entitlementAttribute,
    bpr.value             AS entitlementValue,
    bpr.display_value     AS entitlementName
FROM spt_bundle_profile_relation bpr
LEFT JOIN spt_managed_attribute ma
    ON  ma.application = bpr.source_application
    AND ma.attribute   = bpr.attribute
    AND ma.value       = bpr.value
```

The `LEFT JOIN` is deliberate. A relation that matches no entitlement arrives without a
`childId` and is counted as skipped, instead of disappearing inside an inner join.

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

Schedules work exactly as they do for every pull crawler. By default every statement is
read in full on every run, and every scope the run wrote to is then reconciled (below) —
whether the run is labelled full or delta. **What decides whether stale rows are removed
is not the run's label but whether the statement read the source's complete set.**

A **full** run always reads everything: it ignores any stored position, which is what
"Force full sync next run" is for.

To make routine refreshes cheap, give the large statements a position to read from —
[Reading only what changed](#reading-only-what-changed), below.

After each run the `buildContexts` post-sync hook rebuilds the generated contexts
(departments, org chart, clusters) so the imported data is visible in the matrix straight
away.

---

## Reading only what changed

A full read of an identity-governance database at production size — 180 000 identities,
800 000 entitlements, 40 million grants — takes hours and tens of gigabytes of scratch
space. That is fine for a first load and wrong for a refresh you want to run hourly.

A refresh has two halves, and they need different mechanisms.

### Additions and changes: a watermark

Give the statement a **watermark column** and reference `@Since` in its SQL. The crawler
remembers the largest value that column returned, and binds it to `@Since` next run:

```sql
SELECT
    ie.identity_id AS principalId,
    ma.id          AS resourceId,
    COALESCE(ie.modified, ie.created) AS modified   -- the watermark column
FROM spt_identity_entitlement ie
INNER JOIN spt_managed_attribute ma
    ON  ma.application = ie.application
    AND ma.attribute   = ie.name
    AND ma.value       = ie.value
WHERE ie.type = 'Entitlement'
  AND COALESCE(ie.modified, ie.created) >= @Since
```

with `"watermarkColumn": "modified"` on the slot (the **Watermark column** field in the
wizard). Both halves are required: a watermark column without `@Since`, or `@Since`
without a watermark column, is refused when the configuration is saved.

Four things worth knowing:

- **`@Since` is a `bigint` holding epoch milliseconds**, because that is how IdentityIQ's
  `created` / `modified` are stored (`numeric(19,0)`, written by the application). A first
  run, an edited statement and a forced full sync all bind **zero**, which reads
  everything.
- **Editing the statement resets it.** The stored position is keyed on a hash of the SQL
  text, so a changed query starts from zero instead of silently skipping the rows its new
  shape would have returned.
- **It is stored only after the run has been verified** end to end. A failed or unverified
  run re-reads the same window; every ingest is an upsert, so a re-read costs time, never
  correctness.
- **Each run goes back a little further than the last one reached** —
  `watermarkOverlapSeconds`, 15 minutes by default. Several application servers write an
  IdentityIQ database, their clocks drift, and a long transaction can commit rows stamped
  earlier than rows a previous run already read. Re-reading a few minutes is cheap;
  stepping over a row is silent.

A statement **without** a watermark column reads in full every run. That is the right
answer for anything small — the catalogue, the roles, the role assignments — and it is
what keeps their scopes exact without any of the machinery below.

### Removals: a key sweep

A watermark can never find a removal: a row deleted at the source does not bump its own
timestamp on the way out. Neither can the reconcile, which removes what a run did not
touch — and a windowed run touches almost nothing, so **the scope of a windowed statement
is never reconciled**.

Turn on **Key sweep** on the assignment slot instead. Periodically — at most once every
`sweepIntervalHours`, a day by default — the crawler re-runs that statement with `@Since`
bound to zero, asks only for the pair of ids, and removes every assignment in that scope
that the source no longer has. A removal therefore shows within one sweep interval while
the hourly refreshes stay small.

!!! warning "A sweep refuses to remove more than 5% of a scope"
    A source read while it is being re-aggregated — rows deleted and about to be
    re-inserted — looks exactly like a mass revocation, and a delete has no undo. Past
    `sweepMaxDeleteShare` (0.05) the job fails with the counts and **nothing is written**.
    If the removal is real, set `sweepOverride` for that one run.

    Schedule sweeps **outside** your aggregation window.

### Putting it together

A workable shape for an IdentityIQ estate:

| Statement | Watermark | Sweep | Why |
|---|---|---|---|
| Technical applications, identities, entitlements, business roles, role assignments, role composition | — | — | Small enough to read in full; their scopes stay exact through the ordinary reconcile |
| Entitlement grants (direct and via a role) | `modified` | on | Tens of millions of rows; the one place a full read is an overnight job |

Run it as often as you like; the sweep paces itself.

### What it does not do

- There is **no change feed**. The crawler asks your statement for a window; if your
  source does not stamp every update, the window misses those rows. Drop the watermark
  column for that statement and it reads in full again.
- A **buffered** target — `systems`, `contexts`, `context-members` — is sent whole as one
  full sync and cannot read a window. The configuration refuses the combination.
- Reading from an **Azure SQL read-only replica** (`ApplicationIntent=ReadOnly`) is
  attractive for the sweep, but a replica lags the primary and a position taken there can
  move past rows the primary already committed. If you use one, widen
  `watermarkOverlapSeconds` beyond the worst replica lag — or point the delta at the
  primary. Decide it deliberately.

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
- **Contexts** (a catalogue such as logical applications) are this system's only: a full
  sync removes a catalogue entry that left the source, and never another source's contexts,
  a manual tag or a generated context. **A membership an analyst added by hand is never
  removed**, even on one of this crawler's own contexts: a sync removes only memberships it
  added. See [Ingest API: contexts and context members](../architecture/ingest-api.md#contexts-and-context-members-owned-not-system-scoped).
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
  different crawler. Across the systems *this* crawler creates, references work normally.
- **External ids must be unique across the whole run**, not merely within a system — see
  [Ids are unique per run](#ids-are-unique-per-run-not-per-system). Two systems claiming
  one id fails the run.

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
| The log reports rows that *name a system no `systems` statement created* | The value in the row's `systemId` / `systemName` column matches no row the `systems` statement returned. Usually the two statements are filtered differently (the systems statement excludes inactive applications, say) or one names the connector by id and the other by name. The rows are kept in the crawler's own system; past 5% of a statement the job fails. |
| The job fails with *external id(s) were claimed by more than one system* | Two connectors use the same key for different objects. Ids are unique per run (see [why](#ids-are-unique-per-run-not-per-system)), so the two rows would collapse into one. Make the id unique — prefix it with the application id in the `SELECT`, for instance — or do not route those statements. |
| The job fails with *Registered N system(s) but the API returned M id(s)* | A registration record could not be found again after the upsert. Check that every `systems` row has a non-empty `displayName`. |
| Assignments vanish after routing | Almost certainly not this crawler: it derives ids in one namespace per run precisely so that a grant can span two systems. Check the `dangling` count first — a grant naming an entitlement no statement loaded is held back, whatever system it would have gone to. |
| Rows I removed from the source are still in Identity Atlas | Only a **full** sync reconciles; a delta run never deletes. Also check that the run completed cleanly — a failed run skips the reconcile. |
| **SQL Database** is not visible in **Add Crawler** | The `CRAWLER_MANIFESTS_DIR` environment variable on the web container must point to the folder containing the crawler manifests. See [Docker setup](../architecture/docker-setup.md). |

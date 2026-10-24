# SQL Database Crawler — Developer Guide

Pulls authorization data out of any **Microsoft SQL Server** database with operator-written
`SELECT` statements and pushes the rows through the Ingest API. The operator decides what a
row *is* (an identity, an entitlement, a role membership, a role composition edge) by
assigning each statement a **target**; the crawler maps the statement's columns onto the
universal data model by a fixed, documented column contract. Nothing about the source schema
is baked in — SailPoint IdentityIQ ships as a worked example, not as special-case code.

## Files

| File | Role |
|---|---|
| `crawler.json` | Manifest: type `sql`, `configSchema` (connection + `queries[]`), `postSyncHooks: ["buildContexts"]` |
| `Start-SqlCrawler.ps1` | Entry point (thin orchestration): resolve config → register system → run the query slots in dependency order → reconcile → refresh views |
| `SqlCrawler.Functions.ps1` | Config resolution, connection-string builder, the streaming query runner (`Invoke-SqlQueryStream`) with `@Offset`/`@PageSize` paging, value conversion |
| `SqlCrawler.Transform.ps1` | **Pure** row → ingest-record shapers, one per target, plus the column-contract resolver (`Resolve-SqlColumnMap`) |
| `SqlCrawler.Verify.ps1` | End-of-run verification. Per statement: rows read against the source's own `COUNT_BIG(*)`, taken **before and after** the read, with the rows read required to fall in the band between them plus the observed drift as slack (catches a read that stopped early without failing every run against a source that is aggregated while it is read — see `Get-SqlReadBand`). Per reconcile scope: the distinct keys read (principals, resources, relationships) or the source's distinct pairs (assignments, from the same query, with the same drift as slack) against `POST /ingest/count`. Throws on any mismatch, and — only for a scope keyed on one record's id (principals, resources) — on more rows than distinct keys. A scope keyed on a PAIR (relationships, owner assignments; `Test-SqlPairKeyedEndpoint`) compares distinct against distinct instead: a repeated pair is the same edge, not a lost record |
| `SqlCrawler.Systems.ps1` | The `systems` target and per-row routing: the system catalogue, the registration record (and the `(systemType, tenantId)` key that makes a re-run find the same row), the per-statement route mode, and the cross-system id-collision check |
| `SqlCrawler.Ownership.ps1` | The `ownership` flag on a `resources` slot: the shared owner resolver (account key, then employee number), the ownership resource / `HasOwnership` link / `Direct` owner assignment it emits, their three reconcile scopes, and the per-statement owner tally |
| `SqlCrawler.Contexts.ps1` | The `contexts` / `context-members` targets: the catalogue, name → key resolution (through the crawler's one name fold, `ConvertTo-SqlNameKey` in the Transform file), and the fold / unresolved report |
| `SqlCrawler.Phases.ps1` | Per-slot sync phases: open the ingest streams, run the query, shape + stream every row, then the per-scope reconcile |
| `SqlCrawler.Batch.ps1` | The `assignments` hot path: the reader hands over 5,000 raw rows at a time (`Invoke-SqlReaderPage -OnBatch`) and each function makes one pass over the batch — same records, counters and watermark as the per-row handler, ~10× cheaper. Read its header before touching a loop there: in PowerShell a generic-collection method call costs ~10 µs and an indexer well under 1, so the loops use operators only |
| `SqlCrawler.Staging.ps1` | The staged load, in a full sync and a delta run alike: every `resource-assignments` scope streams into one stage per (system, scope), shared by every statement feeding it. A scope read in full is finalized with `deleteMissing` (its reconcile) and verified by its whole live count against the `distinct` keys the finalize reports; a scope any statement read a window of is finalized without it, before the key sweep, and verified by the `present` count. `Complete-SqlStagedLoads` applies each kind in its own call. A staged scope registers no timestamp reconcile |
| `SqlCrawler.Timing.ps1` | Where a statement's time went — source read (`Invoke-SqlReaderPage -Timing`), JSON and API wait (`Invoke-IngestAPI -Timing`, per stream), source counts, and shaping as the remainder — printed per statement and as one table at the end of the run |
| `SqlCrawler.Delta.ps1` | The per-statement **watermark**: the token key (slot name + hash of the SQL), what `@Since` binds to, following the column while rows stream, and where the mark lands (largest value read − overlap, never backwards) |
| `SqlCrawler.Sweep.ps1` | The **key sweep**: read a statement's complete key set, stage it, and remove what the source no longer has. Due-based, staged per system, finalized with the share ceiling |
| `../shared/Invoke-CrawlerIngestStream.ps1` | Shared streaming ingest: chunked delta upserts + end-of-run `POST /ingest/reconcile`. Written for this crawler; any large-set crawler can use it |
| `../shared/Invoke-CrawlerIngestStage.ps1` | Shared staged-load client (`POST /ingest/stages`): open, stream, finalize. The sweep's anti-join delete is one finalize on it |
| `../shared/Invoke-CrawlerDeltaToken.ps1` | The one client for `/crawlers/delta-tokens`. Graph's delta tokens and this crawler's watermarks share the table, so they share the endpoint-key rules |
| `CrawlerMeta.js`, `ConfigWizard.jsx`, `Summary.jsx`, `sqlPresets.js`, `wizardLogic.js` | UI: type-picker entry, 4-step wizard (Connection → Credentials → Queries → Schedule), config card, the IdentityIQ example query set, pure wizard logic |
| `Test-SqlCrawler.ps1` | CI integration test: runs the phases against the live Ingest API with the SQL boundary stubbed (no SQL Server in CI) |
| `test/unit/SqlCrawler*.Tests.ps1`, `test/unit/CrawlerIngestStream.Tests.ps1` | Pester unit tests |

## Why streaming + reconcile instead of sync sessions

An entitlement-assignment table can hold **tens of millions of rows** (40 M is a real number).
The chunked sync-session protocol (`syncSession: start/continue/end`) cannot carry that: a
session is capped at 30 minutes wall-clock, keeps one pooled connection pinned, applies the
whole payload in one upsert at `end`, and fails that upsert on any duplicate key across chunks.

So this crawler never holds a result set in memory and never opens a session:

1. Rows stream out of a forward-only `SqlDataReader` and are shaped one at a time — or, for
   the `assignments` target, 5,000 at a time (`SqlCrawler.Batch.ps1`); still one batch of
   memory, never the result set.
2. Every `batchSize` records are POSTed as an independent **delta** upsert (`syncMode: 'delta'`,
   deterministic ids). Each chunk commits on its own; a cross-chunk duplicate is just an update.
3. When every slot has run cleanly and the job is a **full** sync, the crawler calls
   `POST /ingest/reconcile` once per distinct `(endpoint, scope)` with `before` = the API's own
   clock reading taken at job start (`GET /crawlers/whoami` → `serverTime`, so clock skew between
   worker and web container cannot matter). The API soft-deletes every row in that system + scope
   whose `updatedAt` is older — exactly the rows this run did not touch.

A run that fails part-way never reaches step 3, so a partial read can never delete anything
(same fail-safe as `Test-PhaseInputsComplete` in midPoint).

**Completeness, not run mode, decides whether a scope is reconciled.** The reconcile removes
what a run did not touch, which is only a *removal* when everything still in the source WAS
touched — true of any statement that read its whole table, whatever the run calls itself. So a
delta run keeps the small scopes exact, and the scope of a **windowed** statement (one that
binds `@Since`) is never reconciled: there, an untouched row is simply one that did not change.
`_syncMode: 'full'` means "ignore every stored watermark", which makes every slot complete
again.

## Reading only what changed

`SqlCrawler.Delta.ps1` + `SqlCrawler.Sweep.ps1`; the design and what it rests on are in
[docs/architecture/sql-connector-delta.md](../../../docs/architecture/sql-connector-delta.md).
A refresh has two halves and they need different mechanisms:

| Half | Mechanism | Slot field |
|---|---|---|
| Additions and changes | a per-statement **watermark** on a `modified`-like column | `watermarkColumn` + `@Since` in the SQL |
| Removals | a periodic **key sweep**: the complete key set, anti-joined in PostgreSQL | `sweep` (assignments only) |

Three properties are the point, and each is load-bearing:

- The token key is `sql:<slot name>:<hash of the SQL text>` (`Get-SqlWatermarkKey`). **Editing a
  statement changes its key**, so the edited query starts from zero instead of silently
  skipping the rows its new shape would have returned.
- The mark is written **only after the run verified** (`Save-SqlWatermarks`, called from
  `Start-SqlCrawler.ps1` after `Test-SqlRunCounts`). An unverified run re-reads its window;
  upserts are idempotent, so that costs time, never correctness.
- The stored value is the largest value READ minus `watermarkOverlapSeconds` (default 900), and
  never moves backwards. Several application servers write the source and their clocks drift.

`@Since` binds as `SqlDbType.BigInt`: the source's `created`/`modified` are `numeric(19,0)`
epoch **milliseconds** written by the application (assumption A1, confirmed against
production). A watermark column whose value does not parse as a `long` is reported and its
token is NOT stored, so the statement keeps reading in full rather than advancing a mark it
cannot compare.

The sweep runs after every slot has streamed (so the only difference left between source and
database is what is gone), at most every `sweepIntervalHours`, and its finalize carries
`maxDeleteShare` — past 5% of a scope the API writes nothing and answers 409. Deleting is the
one operation here with no undo, and a source read mid-aggregation is indistinguishable from a
mass revocation.

`Get-SqlSweepEligibility` refuses a sweep when the run routes into several systems but did not
read its resources in full: a swept pair follows its resource's system, and without every
resource id it would be staged into the crawler's own system — after which the finalize would
remove the routed systems' entire scope.

Identities and IdentityMembers have no `systemId` column, so — like midPoint and CSV — they are
upsert-only and never reconciled.

## Paging

If a statement's text contains `@Offset`, the crawler binds `@Offset` and `@PageSize`
(`pageSize` from the config) and re-runs the statement with a growing offset until a page comes
back short. The rows of every page still stream. Without `@Offset` the statement runs once and
streams to the end — usually the faster option for a very large set, because `OFFSET … FETCH`
re-scans the skipped rows on every page. Paging is there for sources that cut long-running
statements off, or when an ordered, bounded page per statement is what the DBA wants to see.

## Column contract

Column names are matched **case-insensitively with underscores ignored**, so `display_name`,
`DisplayName` and `displayname` all satisfy `displayName`. Every column that is *not* a contract
column lands in `extendedAttributes` under its original name. `NULL` becomes `null`, dates become
ISO-8601 strings, `bit`/`int`/`'Y'`/`'true'` are accepted wherever a boolean is expected, and
binary columns are skipped.

| Target | Required columns | Recognised optional columns | Emits |
|---|---|---|---|
| `systems` | `displayName` (falls back to `name`) | `id` (the key later statements route by; else the folded name), `description`, `systemType`, `tenantId`, `enabled` | one **System** per technical connector in the source, registered as a delta. See "One system per connector" |
| `identities` | `id`, `displayName` (falls back to `name`, `userId`, then `id`) | `email`, `givenName`, `surname`, `department`, `jobTitle`, `companyName`, `employeeId`, `city`, `country`, `officeLocation`, `managerExternalId` (or `managerId`), `principalType`, `enabled` / `active` (or the inverse `inactive` / `disabled`) | one **Identity**, one **Principal** with the same id (the person's account in this system), and the **IdentityMember** link between them |
| `principals` | `id`, `displayName` (same fallbacks) | as above, plus `identityId` (also emits an IdentityMember link) | one **Principal** |
| `identity-members` | `identityId`, `principalId` | `isPrimary`, `accountType` | one **IdentityMember** |
| `resources` | `id`, `displayName` (falls back to `name`) | `description`, `enabled`, `ownerId` (aux) | one **Resource**; `resourceType` comes from the slot; `governanceResource` is set when it is `BusinessRole`. With `ownership: true` also one **ResourceOwnership** resource, a **HasOwnership** relationship and a **Direct** assignment per resolved owner — see "Owners" |
| `assignments` | `resourceId`, `principalId` (alias `identityId`, because an `identities` row's account shares its id) | — | one **ResourceAssignment**; `assignmentType`, `governed`, `resourceType` come from the slot |
| `relationships` | `parentId`, `childId` | — | one **ResourceRelationship**; `relationshipType` from the slot |
| `contexts` | `displayName` (falls back to `name`) | `id` (the key; else the normalised name), `description`, `ownerUserId` | one **Context**, buffered and sent as one full sync; `contextType` / `targetType` from the slot |
| `context-members` | `memberId`, `contextId` or `contextName` | — | one **ContextMember**, resolved against the catalogue in `SqlCrawler.Contexts.ps1`; an unknown context drops the membership only, and is reported |

**The manager column.** Select the manager's key *in the source* — the value that
matches another row's `id`, never an Identity Atlas id, which a query cannot know. Alias
it `managerExternalId`, or `managerId`, which is what the shipped IdentityIQ presets use
(`i.manager AS managerId`); both are accepted and `managerExternalId` wins if a statement
carries both. The ingest resolves it to the row the manager's own `id` produced, so the
two rows may come back in any order. A row naming itself is dropped, and a manager the
statement never returned leaves the column empty and is counted in the job's warnings —
it is never stored as a link that points at nobody. An **unaliased** `manager` column is
left as an ordinary attribute: it holds a display name as often as a key, so it must be
aliased or mapped before it is treated as one.

On an `identities` slot, both halves of the row are filled from the same value: the
Principal gets `managerExternalId` (their manager's **account**) and the Identity gets
`managerIdentityExternalId` (their manager as a **person**). These are different columns
pointing at different tables, which is why the crawler does not send one name for both.

### Using an existing SELECT unchanged — `columnMap`

A statement whose columns are already named for the contract needs nothing. When they
are not — an IdentityIQ export selecting `IdentityID` and `EntitlementID`, say — the slot
carries a `columnMap` of **source column → contract column** and the SQL is used verbatim:

```json
{ "name": "Entitlement assignments", "target": "assignments", "resourceType": "Entitlement",
  "sql": "SELECT ie.identity_id AS IdentityID, ma.id AS EntitlementID FROM ...",
  "columnMap": { "IdentityID": "principalId", "EntitlementID": "resourceId" } }
```

The mapping is matched by the same case- and underscore-insensitive rule as everything
else, applies to optional columns too (`"SuspendedFlag": "disabled"`), and wins over a
same-named column the result set happens to carry. A mapped column counts as consumed,
so it is not also copied into `extendedAttributes`; a mapping naming a column the result
set does not return is ignored rather than failing the run. Aliasing in the SQL and
mapping here are equivalent — the mapping exists so an operator does not have to edit a
query their DBA already signed off.

Without it, a row missing a required contract column is skipped, and a statement whose
every row is skipped logs a warning naming the target's required columns.

Ids are the source's own keys: every record carries them as `externalId`, and the Ingest API
derives the UUID primary key deterministically in the `sql-<the crawler's own systemId>`
namespace, so re-runs update the same rows and cross-references (`resourceExternalId`,
`principalExternalId`, …) resolve without the crawler ever knowing a UUID.

## One system per connector

`SqlCrawler.Systems.ps1`. A `systems` statement creates one Identity Atlas system per
technical connector in the source (`spt_application` in IdentityIQ); `principals`,
`resources`, `assignments` and `relationships` then carry `systemId` (the source's own key
for the connector) or `systemName`, and each row is sent in a batch addressed to that
system. The route mode is decided **once per statement** — at 40 M rows a per-row decision
is minutes of re-deriving a constant — and an assignment with no routing column follows
its resource, a relationship its parent, so the largest statement in the source needs no
extra join. Both routing columns are `aux` in the contract: consumed AND kept in
`extendedAttributes`.

### One namespace per run — the part that is easy to get wrong

**The id namespace is the run's, not the system's.** `IdPrefix` is `sql-<the crawler's own
system id>` for every batch, whatever system the batch is addressed to.

Deterministic ids are `MD5("<namespace>:<externalId>")`, and the API resolves a
cross-entity reference in the namespace of the **batch carrying it**
(`recoverSystemPrefix` in `app/api/src/routes/ingest/helpers.js`). The customer's people
live in the directory system and their entitlements in the connector systems, so every
grant spans two. Namespaced per system, the grant's `principalExternalId` would hash in
the assignment batch's namespace and match no principal — and nothing would say so:
`ResourceAssignments` has no foreign key on `principalId` or `resourceId`, so the row
inserts happily, points at nothing, and never appears in the matrix.

Two paired tests pin this. `test/unit/SqlCrawlerSystems.Tests.ps1` → *"joins a principal in
one system to an entitlement in another"* asserts the three batches share one namespace;
`app/api/src/ingest/normalization.test.js` → *"cross-system references"* asserts what that
buys and what a per-system namespace would cost. Both were checked against the mutation
(`-IdPrefix "sql-$SystemId"`); the first fails, so it is a real assertion.

Because the namespace is the run's, `sql-<own system id>` is byte-for-byte the value a
single-system run has always used: **no existing installation's ids move.**

The price is that external ids must be unique across every system of a run. `Add-SqlKnownKey`
records every id two systems claim and `Get-SqlIdCollisionVerdict` fails the run naming
them — the same treatment the existing "more rows than distinct ids" check gives the same
defect one level up.

### Reconcile and verification with routing

- The **reconcile** is per `(system, endpoint, scope)` and is registered when a stream for
  that system actually opens, so a run never reconciles a system it did not write to.
- An **expectation** is per `(endpoint, scope)` and holds the set of systems it was written
  to; `Measure-SqlScopeRows` sums `POST /ingest/count` over exactly those. The source's own
  counts are per statement, never per system, so summing is the only honest comparison.
- A row naming a system no statement created is kept in the crawler's own system, counted
  as `Misrouted`, reported by name, and fails the run past the same 5% share
  `Get-SqlReadVerdict` already uses for unplaced rows.

Slot values are **constants per statement** on purpose: `resourceType`, `assignmentType`,
`governed` and `relationshipType` are also the full-sync reconcile scope, so a per-row override
would make one statement's reconcile delete another's rows. Two statements with the same target
and scope are fine — the reconcile runs once per scope after both have streamed.

## Owners

`SqlCrawler.Ownership.ps1`. A `resources` slot with `ownership: true` turns its `ownerId`
column into the model's existing ownership shape — a `ResourceOwnership` resource named
after the owned one, a `HasOwnership` relationship to it, and a `Direct` assignment for the
owner — instead of leaving an identifier in `extendedAttributes` (`ownerId` is `aux`, so it
stays there as well). Three decisions worth knowing before changing anything here:

- **One ownership resourceType, not one per owned kind.** The Entra crawler can afford
  `GroupOwnership` / `ServicePrincipalOwnership` / `ApplicationOwnership` because it knows
  all three at compile time. Here the owned type is whatever the operator's slot says, so a
  `<that>Ownership` family would be unbounded and the consumers that filter on ownership
  (`app/api/src/lib/ownershipTypes.js`, read by the risk engine and the report catalogue)
  could not enumerate it. The owned type travels on
  `extendedAttributes.ownedResourceType` instead.
- **Opt-in per statement.** Three rows per owned resource is ~1.45 M rows on a production
  IdentityIQ catalogue (measured: `docs/sync/mssql.md` → "What owners cost"). The shipped
  presets turn it on for business roles and leave it off — with the column already
  selected — for entitlements.
- **An unresolvable owner is counted, never charged to the unplaced bound.** The owner
  counters are separate from `Skipped` / `Dangling` on purpose: those feed
  `Get-SqlReadVerdict`'s 5% rule, which fails a job. An entitlement whose owner cannot be
  found is a perfectly placed entitlement, so an owner column that resolves for nothing
  must report loudly and load everything.

`Resolve-SqlPrincipalRef` is the one owner resolver — account key first, then employee
number — shared with `Resolve-SqlContextOwner`, so a context's owner and a resource's owner
can never disagree about how a source names a person. They differ only in what failure
means: a Context keeps the raw string in its `ownerUserId` column, while a resource emits
nothing (an ownership row with no owner assignment would be an empty matrix row).

## Slot ordering

Slots run grouped by target in dependency order regardless of the order they are configured in:
`systems` → `identities` → `principals` → `resources` → `contexts` → `identity-members` → `context-members` → `assignments` → `relationships`.
`systems` is first because everything after it may name one of the systems it creates.
The crawler remembers every resource and principal id it emitted; an assignment or relationship
that names an id it has not seen is skipped and counted (logged as `dangling`), never sent.

## Known gotchas

- **Never pass a `SqlDataReader` to a PowerShell function or cmdlet.** It is `IEnumerable`, and
  while a transcript runs (the worker runs every job under one) binding it to *any* parameter
  enumerates it for the log, which consumes 7 rows per call. `Invoke-SqlReaderPage` once kept
  1 row in 8 this way, and the read still looked complete. Use the reader's own methods
  (`GetName`, `GetValues`) and pass the plain value array. Runs by hand have no transcript, so
  only a worker job shows this. Test it under `Start-Transcript`, with a double that is
  enumerable the way `DbDataReader` is (see `SqlCrawlerFunctions.Tests.ps1`).
- **`System.Data.SqlClient` ships inside PowerShell 7** on both Windows and the Linux worker
  image (`/opt/microsoft/powershell/7/System.Data.SqlClient.dll`), so there is no driver to
  install. `Microsoft.Data.SqlClient` is *not* available and must not be referenced.
- `commandTimeoutSeconds` is a per-network-read timeout in SqlClient, not a wall-clock cap on the
  statement, so a slow-but-streaming 40 M-row read is not cut off by it. `0` disables it.
- A named instance (`host\instance`) resolves through the SQL Browser service (UDP 1434); set
  `port` explicitly when that port is firewalled.
- There is no `discover.js` / "Test connection" in the wizard: the API container has no SQL
  Server driver and adding one for a connectivity check was judged not worth the supply-chain
  surface. The first job run is the connection test.

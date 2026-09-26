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
| `SqlCrawler.Contexts.ps1` | The `contexts` / `context-members` targets: the catalogue, the ONE normalisation of a context reference (`ConvertTo-SqlContextName`, invariant culture), name → key resolution, and the fold / unresolved report |
| `SqlCrawler.Phases.ps1` | Per-slot sync phases: open the ingest streams, run the query, shape + stream every row, then the per-scope reconcile |
| `../shared/Invoke-CrawlerIngestStream.ps1` | Shared streaming ingest: chunked delta upserts + end-of-run `POST /ingest/reconcile`. Written for this crawler; any large-set crawler can use it |
| `CrawlerMeta.js`, `ConfigWizard.jsx`, `Summary.jsx`, `sqlPresets.js`, `wizardLogic.js` | UI: type-picker entry, 4-step wizard (Connection → Credentials → Queries → Schedule), config card, the IdentityIQ example query set, pure wizard logic |
| `Test-SqlCrawler.ps1` | CI integration test: runs the phases against the live Ingest API with the SQL boundary stubbed (no SQL Server in CI) |
| `test/unit/SqlCrawler*.Tests.ps1`, `test/unit/CrawlerIngestStream.Tests.ps1` | Pester unit tests |

## Why streaming + reconcile instead of sync sessions

An entitlement-assignment table can hold **tens of millions of rows** (40 M is a real number).
The chunked sync-session protocol (`syncSession: start/continue/end`) cannot carry that: a
session is capped at 30 minutes wall-clock, keeps one pooled connection pinned, applies the
whole payload in one upsert at `end`, and fails that upsert on any duplicate key across chunks.

So this crawler never holds a result set in memory and never opens a session:

1. Rows stream out of a forward-only `SqlDataReader` and are shaped one at a time.
2. Every `batchSize` records are POSTed as an independent **delta** upsert (`syncMode: 'delta'`,
   deterministic ids). Each chunk commits on its own; a cross-chunk duplicate is just an update.
3. When every slot has run cleanly and the job is a **full** sync, the crawler calls
   `POST /ingest/reconcile` once per distinct `(endpoint, scope)` with `before` = the API's own
   clock reading taken at job start (`GET /crawlers/whoami` → `serverTime`, so clock skew between
   worker and web container cannot matter). The API soft-deletes every row in that system + scope
   whose `updatedAt` is older — exactly the rows this run did not touch.

A delta run (`_syncMode: 'delta'`) does steps 1–2 only. A run that fails part-way never reaches
step 3, so a partial read can never delete anything (same fail-safe as `Test-PhaseInputsComplete`
in midPoint).

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
| `identities` | `id`, `displayName` (falls back to `name`, `userId`, then `id`) | `email`, `givenName`, `surname`, `department`, `jobTitle`, `companyName`, `employeeId`, `principalType`, `enabled` / `active` (or the inverse `inactive` / `disabled`) | one **Identity**, one **Principal** with the same id (the person's account in this system), and the **IdentityMember** link between them |
| `principals` | `id`, `displayName` (same fallbacks) | as above, plus `identityId` (also emits an IdentityMember link) | one **Principal** |
| `identity-members` | `identityId`, `principalId` | `isPrimary`, `accountType` | one **IdentityMember** |
| `resources` | `id`, `displayName` (falls back to `name`) | `description`, `enabled` | one **Resource**; `resourceType` comes from the slot; `governanceResource` is set when it is `BusinessRole` |
| `assignments` | `resourceId`, `principalId` (alias `identityId`, because an `identities` row's account shares its id) | — | one **ResourceAssignment**; `assignmentType`, `governed`, `resourceType` come from the slot |
| `relationships` | `parentId`, `childId` | — | one **ResourceRelationship**; `relationshipType` from the slot |
| `contexts` | `displayName` (falls back to `name`) | `id` (the key; else the normalised name), `description`, `ownerUserId` | one **Context**, buffered and sent as one full sync; `contextType` / `targetType` from the slot |
| `context-members` | `memberId`, `contextId` or `contextName` | — | one **ContextMember**, resolved against the catalogue in `SqlCrawler.Contexts.ps1`; an unknown context drops the membership only, and is reported |

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
derives the UUID primary key deterministically in the `sql-<systemId>` namespace, so re-runs
update the same rows and cross-references (`resourceExternalId`, `principalExternalId`, …)
resolve without the crawler ever knowing a UUID.

Slot values are **constants per statement** on purpose: `resourceType`, `assignmentType`,
`governed` and `relationshipType` are also the full-sync reconcile scope, so a per-row override
would make one statement's reconcile delete another's rows. Two statements with the same target
and scope are fine — the reconcile runs once per scope after both have streamed.

## Slot ordering

Slots run grouped by target in dependency order regardless of the order they are configured in:
`identities` → `principals` → `resources` → `contexts` → `identity-members` → `context-members` → `assignments` → `relationships`.
The crawler remembers every resource and principal id it emitted; an assignment or relationship
that names an id it has not seen is skipped and counted (logged as `dangling`), never sent.

## Known gotchas

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

# SQL Connector Internals

How the SQL Server crawler (`tools/crawlers/mssql/`) loads, refreshes, removes and
verifies data. This page is for people who change the crawler or need to explain a job
log in detail. To set the crawler up, read [Connect SQL Server](../sync/mssql.md).

## One run, start to finish

`Start-SqlCrawler.ps1` is a thin sequence; each step lives in its own file.

| # | Step | File |
|---|---|---|
| 1 | Read the configuration and refuse combinations that cannot work | `SqlCrawler.Functions.ps1` |
| 2 | Register the crawler's own system and read the API's clock | `SqlCrawler.Phases.ps1` |
| 3 | Open the SQL Server connection | `SqlCrawler.Functions.ps1` |
| 4 | Run every enabled statement, grouped by target in dependency order | `SqlCrawler.Phases.ps1`, `SqlCrawler.Batch.ps1` |
| 5 | Apply the staged assignment **windows** (no removal) | `SqlCrawler.Staging.ps1` |
| 6 | Run the key sweeps that are due, then close the source connection | `SqlCrawler.Sweep.ps1` |
| 7 | Apply the staged assignment scopes that were **read in full** (with removal) | `SqlCrawler.Staging.ps1` |
| 8 | Timestamp reconcile of every other scope that was read in full | `SqlCrawler.Phases.ps1` |
| 9 | Verification: source against database. A failure throws | `SqlCrawler.Verify.ps1` |
| 10 | Store watermarks and sweep marks | `SqlCrawler.Delta.ps1`, `SqlCrawler.Sweep.ps1` |
| 11 | Refresh the matrix views. This runs in a `finally`, whatever happened before | `SqlCrawler.Phases.ps1` |

Two orderings are deliberate. Windows are applied before the sweep, because the sweep
compares a scope's total with the key set it read, and that only holds once the run's
additions are in the table. The scopes read in full are applied after the connection is
closed, so a long apply never holds an idle connection to the source.

The manifest declares the `buildContexts` post-sync hook, so the context plugins run
after the crawl.

## Streaming

A statement's rows come out of a forward-only `SqlDataReader` and are never collected.
Rows are shaped one at a time, except for the `assignments` target, where the reader
hands over 5,000 raw rows at once and each shaping function makes one pass over them
(`SqlCrawler.Batch.ps1`). Memory is one batch, whatever the size of the result set.

Every `batchSize` records are sent as an independent upsert with deterministic ids. Each
batch commits on its own, and a key that appears again in a later batch is an update.
The chunked sync-session protocol other crawlers use is not used here: it applies the
whole payload in one step at the end and is bounded in time, which does not fit a table
of tens of millions of rows.

Assignment and relationship batches may be in flight several at a time
(`ingestConcurrency`). Neither table has a foreign key, so their batches can commit in
any order. Everything else is sent in order, and a statement's streams are flushed in
dependency order, because `IdentityMembers.identityId` does have a foreign key.

Three targets are **buffered** instead of streamed: `systems`, `contexts` and
`context-members`. Their rows are collected and sent when the statement ends. That is
why they cannot take a watermark.

`commandTimeoutSeconds` is SqlClient's per-network-read timeout, not a limit on the
whole statement.

## Ids and systems

Every record carries the source's key as `externalId`. The Ingest API derives the primary
key from it inside a namespace (see
[Deterministic GUID generation](ingest-api.md#deterministic-guid-generation)).

**The namespace belongs to the run, not to the system.** It is `sql-<id of the crawler's
own system>` for every batch, also for batches addressed to a system that a `systems`
statement created. A reference such as `principalExternalId` is resolved in the namespace
of the batch that carries it, and an assignment usually joins an account in the crawler's
own system to a resource in a routed system. With a namespace per system the two halves
would never match, and nothing would report it, because `ResourceAssignments` has no
foreign keys. Two consequences:

- A configuration without a `systems` statement produces exactly the ids it always did.
  Adding one later moves rows to their systems without changing their ids.
- External ids must be unique across every system of a run. The crawler records each id
  that two systems claim and fails the run in the verification table.

Routing is decided once per statement, not per row: by `systemId`, by `systemName`, or
"follow the resource" (assignments) and "follow the parent" (relationships). Systems from
a `systems` statement are registered with a delta upsert and are never deleted. A row
that names an unknown system is loaded into the crawler's own system and counted.

## Removal

What decides whether stale rows are removed is **whether the statement read the source's
complete set**, not whether the run is called full or delta. A statement is *complete*
when it has no watermark, or has one but `@Since` was bound to zero (a first read, an
edited statement, or a full run). Otherwise it read a *window*.

A scope is (system, endpoint, the statement's type constants). If several statements
feed one scope, the scope counts as complete only when all of them were.

| Data | Mechanism | When |
|---|---|---|
| Accounts, resources, relationships (including the ownership resources and their links) | Timestamp reconcile | The scope is complete |
| Assignments, owner assignments included, `stagedFullLoad` on | Staged apply with `deleteMissing` | The scope is complete |
| Assignments, `stagedFullLoad` off | Timestamp reconcile | The scope is complete |
| Assignments read as a window | Key sweep | The slot has `sweep` and the sweep is due |
| Contexts, context members | A full sync of the buffered set, bounded by ownership | The run is a full run; a delta run upserts |
| Identities, identity members | Never removed | They have no `systemId` |

**Timestamp reconcile.** One `POST /ingest/reconcile` per (system, endpoint, scope) the
run actually wrote to. It removes the rows whose `updatedAt` is older than the API's own
clock reading taken at job start, which are the rows this run did not touch. Using the
API's clock means a clock difference between worker and API cannot cause false removals.
A scope is registered when its first row arrives, so a system or scope the run never
wrote to is never reconciled. If any statement throws, the run never reaches this step.

**Staged apply.** With `stagedFullLoad` on, assignment batches go into a stage per
(system, scope) through the [staged load](ingest-api.md#staged-full-load) endpoints
instead of into the table. Statements that feed the same scope share one stage; two
stages of one scope applied with removal would each remove the other's rows. All stages
of a kind are finalized in one call:

- complete scopes with `deleteMissing`, which inserts what is new, updates only rows
  whose values changed, and removes what the stage does not hold. This replaces the
  timestamp reconcile for the scope, and an unchanged re-import writes nothing;
- windows without `deleteMissing`. A window says nothing about rows it did not return.
  It is staged all the same, because a stage writes only rows whose values changed and a
  source may re-stamp many unchanged rows.

Nothing reaches the table before the finalize. A failed finalize abandons the stages.

**Contexts.** The catalogue and the memberships are each sent as one batch in the run's
sync mode. The crawler stamps its own system as the owner (`scopeSystemId`) and sends
the scope `variant = synced`, `contextType`, so a full sync replaces only this crawler's
catalogue of that type. See
[Contexts and context members](ingest-api.md#contexts-and-context-members-owned-not-system-scoped).
The root context is sent in the same batch as its children. An empty catalogue sends
nothing, and gets no root.

Removed rows follow [Soft-Delete & Tombstones](soft-delete.md).

## Reading only what changed

A refresh has two halves that need different mechanisms.

### Watermark: additions and changes

A statement opts in by referencing `@Since` and naming a `watermarkColumn` it returns.
Both are required and the configuration is refused otherwise.

- **Where it is stored.** In the delta-token store shared with the other crawlers, under
  the key `sql:<slot name>:<first 16 hex of SHA-256 of the SQL text>`. Editing the
  statement changes the key, so the edited statement starts from zero.
- **What `@Since` binds to.** A `bigint`. In a delta run it is the stored value; with no
  stored value, and in every full run, it is zero. A full run still records how far it
  got, so the next delta run starts from there.
- **What is stored.** The largest value read, minus `watermarkOverlapSeconds` (in
  milliseconds), and never less than where the run started. It comes from the rows read,
  so no extra query is needed.
- **When it is stored.** After verification passed, for all statements together. A
  failed run reads the same window again; upserts make that safe.
- **An unusable column.** If the statement does not return the named column, or a value
  does not parse as a whole number, the log says so, the mark is not stored and the
  statement keeps reading in full.
- **Not an attribute.** The watermark column is left out of `extendedAttributes`. A
  source can re-stamp a row without changing it, and storing the stamp would make
  unchanged rows look changed on every import.

### Key sweep: removals

A watermark cannot find a removal, and the timestamp reconcile cannot help with a window,
because a window touches almost nothing. Removals in a windowed assignment scope are
found by set difference.

1. The statement's result columns are looked up without running it
   (`sys.dm_exec_describe_first_result_set`).
2. The statement runs with `@Since` zero, wrapped as
   `SELECT DISTINCT <resource column>, <principal column> FROM (<statement>) q`. If the
   columns could not be described, the statement runs as it is; that is slower, not wrong.
3. The pairs go into a **keys-only** stage per system.
4. The stages are finalized with `deleteMissing` and `maxDeleteShare`. A keys-only stage
   inserts and updates nothing; it only removes the scope's rows that are not in it.

Rules around it:

- **Due.** A separate mark, `sql:sweep:<slot name>:<hash>`, holds the time of the last
  verified sweep. The sweep runs when that is at least `sweepIntervalHours` ago.
- **Covered.** When the run already read the statement in full, the scope has been
  reconciled, so no sweep runs, and the interval restarts.
- **Refused up front** when the statement pages with `@Offset`, when
  `sweepIntervalHours` is 0, and when the run routes into several systems but a
  `resources` statement read a window. A swept pair follows its resource's system, and
  without every resource id it would be staged into the wrong one.
- **Share ceiling.** Above `sweepMaxDeleteShare` the API answers 409 and writes nothing;
  the job fails with the counts. `sweepOverride` sends a ceiling of 1.
- **No keys, no removal.** A key set that comes back empty opens no stage and removes
  nothing. An empty result is far more often a broken read than an empty source.

"Touch every row that is still there and let the reconcile find the rest" is not used:
it rewrites every surviving row and its index entries on each refresh.

### What the delta relies on in the source

| The crawler assumes | If your source differs |
|---|---|
| The watermark column holds epoch milliseconds | Convert it in the statement. A value that is not a whole number is reported and the statement reads in full |
| Every update to a row moves the watermark column | That statement cannot use a watermark. Remove it and the statement reads in full again |
| Writers' clocks may differ, and a transaction may commit late | Covered by `watermarkOverlapSeconds`. It must exceed the worst clock difference plus the longest write transaction |
| Nothing about how rows are updated | A source that deletes and re-inserts unchanged rows makes every such row look new: the window is larger, not wrong. A sweep during that rebuild sees rows that are about to return, which is what the share ceiling refuses |
| Nothing about how rows are removed | If the source flags removals instead of deleting rows, the watermark already finds them and `sweep` can be turned off |

A statement without `@Since` reads in full, which is always correct and only slower.
Every narrowing is opt-in per statement.

## Verification

`Test-SqlRunCounts` writes one table at the end of the run and throws when any line
fails.

**Read, per statement.** The statement is wrapped in `SELECT COUNT_BIG(*)` and counted
before and after the read. The rows read must land between the two counts, widened on
both sides by the difference between them. A source that did not move is held to exact
equality; a source that moved by N rows gets N rows of slack, and the movement is printed
on every run. A flat percentage is not used: it would also pass a read that lost rows,
and a passed run stores the watermark, so the loss would become permanent. If the first
count cannot be taken, the read is held to the second alone. A statement that cannot be
wrapped (it pages with `@Offset`, or it is a multi-statement batch) is reported as
`not verified`.

**Placed, per statement.** At most 5% of the rows read may be dangling or skipped for a
missing required column. Separately, at most 5% may name an unknown system. A context
member that names no context, and an owner that matches no account, are counted but not
held against this bound.

**Stored, per scope.** Counts come from `POST /ingest/count`, not from the ingest's
inserted and updated totals.

| Scope | Must equal |
|---|---|
| Accounts, resources | The distinct ids read. More rows than distinct ids fails: two records sharing an id overwrite each other |
| Relationships, owner assignments | The distinct pairs read. A repeated pair is the same edge, so it is reported and not failed |
| Assignments, staged, read in full | Exactly the distinct assignments the finalize says the stages held. Both numbers are Identity Atlas's own, so there is no slack. The source's pair count is printed beside it when it differs |
| Assignments, staged, window | Every distinct assignment in the window must be live in the table after the apply |
| Assignments, not staged | The source's distinct (resource, principal) pairs, with the same drift as slack; a range when rows were dangling or two statements overlap |
| A swept scope | After a distinct sweep, the scope's live rows must equal the keys staged |

Identities and contexts have no `systemId` and are not counted per system; the context
report in the job log covers the catalogue.

**After a failure.** Batches were committed as they were sent, so the data stays. The
matrix views are refreshed anyway, since a view that does not show committed rows is
worse than one that does. Watermarks and sweep marks are not stored.

## Performance

### Where the time goes

Each statement logs one line, and the run ends with the same split per statement and
rows per second:

```
  time: source read 5.2s · shaping 22.9s · JSON 10.3s · API 205.1s · source counts 8.9s
```

| Part | What it measures | If it dominates |
|---|---|---|
| source read | SQL Server running the statement and sending rows | The query plan, or the network to the server |
| shaping | Turning rows into records: column mapping, routing, dangling checks | The crawler's own per-row work |
| JSON | Serializing each batch | Normally small |
| API | Waiting for Identity Atlas to store batches, retries included. For assignments and relationships only the time the crawler had to stop and wait | The database behind Identity Atlas |
| source counts | The before and after counts of the verification | The statement is expensive to count |

### Notes

- **Streaming beats paging.** `OFFSET … FETCH` makes SQL Server skip the earlier rows
  again on every page. Paging exists for servers that cut long statements off.
- **Staged beats batched for assignments.** A batched upsert rewrites every row it is
  handed, and the timestamp reconcile needs every surviving row touched. A stage writes
  only what changed, and into an empty table the indexes are built once. Figures are in
  [Scale Rehearsal](scale-rehearsal.md).
- **A delta is much cheaper than a full load, and a sweep sits in between.** On the
  IdentityIQ-shaped fixture in `tools/iiq-fixture/` (4 million grants, a 2-vCPU host, so
  read the ratios): a full load took 2,915 s, a delta without a sweep 85 s, and a delta
  with the sweep due 575 s. That is why the sweep is paced by an interval.
- **Owner links cost three rows per owned resource.** On the same fixture, with 60% of
  entitlements owned, that is 1.8 extra rows per entitlement on average.
- **Routing costs nothing on the largest statement.** An assignment follows its
  resource's system from memory; no join is added to the source query.

The fixture's `sql/03-mutate.sql` changes the source the way a real one moves between
two refreshes, and logs every key it changed, so a delta can be rehearsed and checked
against what actually moved.

## Not implemented

- **A sweep narrowed to changed identities.** The sweep always reads the complete key
  set of the statement.
- **Read-only replicas.** The connection string sets no `ApplicationIntent`. A replica
  lags its primary, and a watermark taken there can move past rows the primary already
  committed. If `server` points at a replica, `watermarkOverlapSeconds` must exceed the
  worst replica lag.
- **Watermarks on `systems`, `contexts` and `context-members`**, and **key sweeps on
  anything but `assignments`**.
- **A sweep of a paged statement.**
- **`datetime` watermarks.** `@Since` is always a `bigint`.
- **Windows or Entra ID authentication**, and database engines other than SQL Server.
- **A connection test in the wizard.** The API container carries no SQL Server driver.

# Scale Rehearsal: 41 Million Assignments

This page records what happened when Identity Atlas was loaded with a synthetic
identity-governance export far larger than anything it had run on before —
180,000 principals, 810,000 resources and 41 million assignments — and where it
stops coping. It is a measurement, not a tuning exercise: where something was slow
it is characterised here, not fixed.

The dataset comes from the [scale test fixture generator](https://github.com/Fortigi/IdentityAtlas/tree/main/tools/scale-dataset).
The smaller, uniform load test on [Scaling & Load Testing](scaling.md) is unchanged.

!!! warning "Where the wall is"
    - **The full load does not fit on 40 GB of free disk.** It stopped at 62% of
      the assignments. The audit history trigger writes ~1 KB per new assignment,
      three times the row itself; a first load of 41 M rows needs **~70 GB free**,
      42 GB of it history.
    - **Throughput decays as the indexes grow**: 7,400 → 2,750 rows/s by 24 M rows.
      Index maintenance is 80–90% of the database-side insert cost, and the history
      trigger costs more than all 13 indexes together. With the history trigger off,
      all 41 M rows loaded in **93 minutes**.
    - **The post-load refresh outruns the crawler.** Classifying business-role
      assignments triggers a full matrix-view refresh (19.5 min on first
      population); the crawler times out after 300 s, retries four times and queues
      a refresh each time. Every refresh needs ~11 GB of scratch disk.
    - **The principal matrix cannot open.** Unfiltered — and even filtered to
      enabled accounts — it crashes the API process (JavaScript heap out of memory),
      because the 400,000-row limit is checked only after every row is loaded. The
      same happens at 10%. Because of the skew, even "enabled, Finance, smallest
      connector" is 519,000 assignments.
    - **The logical-application pages take 4 minutes** (243 s for the detail and
      for each page of members of the largest application), and a deep page never
      finishes — the query keeps running after the browser has given up.
    - What holds up: the dashboard (2 s), a resource with 171,000 holders (0.6 s),
      a small logical application in the matrix (1 s), the application list
      (0.2 s), and a principal-based report end to end (75 s for 29 MB).

## Setup

### The dataset

Generated with `node tools/scale-dataset/generate.mjs --scale <s>` at seed
`20260926`, tab-delimited. The same shape at three sizes:

| File | 1% | 10% | 100% |
|---|---:|---:|---:|
| Systems | 41 | 41 | 41 |
| Contexts (logical applications) | 15 | 150 | 1,500 |
| Resources (entitlements + roles) | 8,100 | 81,000 | 810,000 |
| Context members | 8,000 | 80,000 | 800,000 |
| Users (principals) | 1,800 | 18,000 | 180,000 |
| Assignments | 410,000 | 4,100,000 | 41,000,000 |
| Size on disk | 22 MB | 214 MB | 2.1 GB |

At 100% a quarter of the principals are enabled, 34 entitlements have six-figure
membership and the median entitlement has 8 holders; the largest connector holds
35% of the entitlements; most logical applications span several connectors; and
directory entitlement values are LDAP distinguished names. See the generator's
README for every shape parameter. Generating the full set takes ~15 s with a flat
~250 MB of memory.

### The machine

Deliberately modest — closer to an analyst's laptop than a server:

| | |
|---|---|
| CPU | 2 vCPU (Intel Core Ultra 5 125H), Proxmox VM |
| Memory | 7.9 GB at the start, **ballooned down to 4.3–5.8 GB during the runs** by the hypervisor |
| Disk | 61 GB, ~39 GB free for the test |
| PostgreSQL | 16, stock settings: `shared_buffers` 128 MB, `max_wal_size` 1 GB, `work_mem` 4 MB |
| Stack | the standard `docker-compose.yml` (web, worker, postgres), no tuning |

Absolute times on this box are pessimistic. The *shape* of each curve, the
storage per row and the failure modes are what carry over.

### The code

Commit `91a2bf3e9` on `feature/sql-crawler`, not `main`. When the runs started,
`main`'s CSV crawler read the whole assignments file into memory before sending anything,
which died before its first request at this size; that branch carried the
streaming rewrite of the assignments phase (read, shape, buffer, flush, then a
timestamp reconcile) that the measurements need. That rewrite has since landed on
`main` with the other CSV import fixes (#1263); the 10% load was repeated there as
a cross-check (below).

### Method

- A CSV crawler config per run, `"delimiter": "\t"`; the generated files are placed
  directly in the config's upload folder (the upload path has its own limits,
  measured separately), and a **full** sync is started through
  `POST /api/admin/crawler-jobs` — exactly what the Run button does.
- Every 5 s: peak RSS of the crawler's `pwsh` process, container memory of web,
  worker and postgres, `pg_database_size`, disk used, and the non-idle backends in
  `pg_stat_activity` (query and wait event).
- The job log is tailed live and every line stamped on arrival, so phases that
  print no timestamp of their own still get one (±5 s).
- The database is wiped (`docker compose down -v`) between runs.
- After a load, every screen below is driven with the exact request the UI sends,
  timed with `curl`, capped at 30 minutes.

## Ingest

### Per phase

Wall clock per crawler phase. Rows/s is file rows over phase wall time.

| Phase | 1% | 10% | 100% | 100% rows/s | peak pwsh | db after phase |
|---|---:|---:|---:|---:|---:|---:|
| Systems | <1 s | <1 s | <1 s | | 0.1 GB | 0.01 GB |
| Contexts | 2 s | 5 s | 4 s | | 1.2 GB | 0.01 GB |
| Context members | (with contexts) | 3 s | 67 s | 11,900 | **3.0 GB** | 0.25 GB |
| Resources | 2 s | 11 s | 104 s | 7,800 | **3.6 GB** | 1.2 GB |
| Users | <1 s | 3 s | 31 s | 5,800 | 2.2 GB | 1.5 GB |
| Assignments | 55 s | 576 s | **stopped at 25.25 M after 6,153 s** | 4,100 (avg) | 2.5 GB | 34.9 GB |
| Classify + refresh views | 7 s | 69 s | not reached | | | |
| **Total** | 67 s | 667 s | — | | | |

The 100% column is the unmodified product. It did not finish: see below.

### The wall: storage, then time

The 100% load was stopped by a disk guard (free space < 4 GB) at **25.25 M of 41 M
assignments, 62%**, 1 h 42 min into the assignments phase. At that point:

| Table | Rows | Size |
|---|---:|---:|
| `_history` | 26.2 M | **25.7 GB** |
| `ResourceAssignments` | 25.1 M | 8.6 GB (5.0 GB heap + 3.5 GB indexes) |
| `Resources` | 0.8 M | 0.35 GB |
| everything else | | < 0.3 GB |

**The audit history trigger is three quarters of the database.** Every inserted
assignment writes a ~1 KB JSON snapshot to `_history` (migration 009/022), three
times the size of the assignment row itself (~340 B including its 13 indexes).
Projected to the full load, before the matrix materialised view is even built:

| | per assignment | at 41 M |
|---|---:|---:|
| `ResourceAssignments` | ~340 B | ~14 GB |
| `_history` | ~1,020 B | ~42 GB |
| matrix view `vw_ResourceUserPermissionAssignments` (from the 10% run) | ~280 B | ~11.5 GB |
| **total** | | **~68 GB** |

A first load of this size needs roughly **70 GB free**, of which 42 GB is the
history of rows that were never changed — every one of them an `INSERT` of a new
row. There is no setting to turn it off.

Throughput also decays as the table grows. Assignment rows per second, per 2 M:

| Rows loaded | rows/s |
|---|---:|
| 0.25 → 2.25 M | 7,400 |
| 4.25 → 6.25 M | 5,700 |
| 8.25 → 10.25 M | 4,750 |
| 12.25 → 14.25 M | 4,700 |
| 16.25 → 18.25 M | 3,800 |
| 20.25 → 22.25 M | 3,000 |
| 22.25 → 24.25 M | 2,750 |

Extrapolating that decay, the remaining 16 M rows would have taken about two more
hours: **~3.7 h for the assignments phase alone**, had the disk been big enough.

### Where the insert time goes

Sampled `pg_stat_activity` over the 100% assignments phase (non-idle backends,
every 5 s, 862 samples of the ingest `INSERT … ON CONFLICT`): on CPU in 46%,
waiting on **`DataFileRead`** in 22% (index pages that no longer fit in 128 MB of
shared buffers), on the **`WALWrite`** lock in 22%, and on data-file writes and
`WALSync` in 4% each. Autovacuum of `_history` (mostly) and `ResourceAssignments`
made up 194 of the 1,230 sampled busy backends.

To separate index maintenance from the history trigger, the same 4.1 M assignment
rows were loaded into a copy of `ResourceAssignments` (same name, so the history
trigger keys it exactly as in production) in 10,000-row committed batches, on an
idle database:

| Variant | Time | rows/s |
|---|---:|---:|
| No indexes, no trigger, plain `INSERT` | 8–23 s | 180,000–540,000 |
| All 13 production indexes, `INSERT … ON CONFLICT DO UPDATE` (the ingest's shape) | 111 s | 37,000 |
| … plus the history trigger | 299 s | 13,700 |
| No indexes, then build the 13 indexes afterwards | 8 s + 17 s | ~170,000 overall |

- **Index maintenance is ~80–90% of the database-side cost** of an assignment
  insert without history, and it gets worse as the indexes outgrow memory — that
  is the decay in the table above.
- **The history trigger costs more than all 13 indexes together** (+188 s on top of
  111 s) and writes 3.6 GB for these 4.1 M rows.
- **Dropping and rebuilding the indexes around a bulk load is ~4.5× faster** than
  maintaining them (25 s vs 111 s), and ~12× faster than today's path with history.
  Building the indexes afterwards also produces them ~10% smaller.
- End to end, the crawler moved 7,100 rows/s at 10% while the database-side cost
  alone allowed ~13,700 rows/s: at that size roughly half the time is the database
  and half is PowerShell, HTTP, JSON and the per-batch temp table. As the table
  grows, the database share grows with it.

### The same load without the history trigger

To get a complete 41 M-row database for the measurements that follow — and to
see what the load costs without history — the 100% load was repeated with
`ALTER TABLE "ResourceAssignments" DISABLE TRIGGER` on both history triggers.
Nothing else changed; history on every other table stayed on.

| Phase | wall | rows/s | peak pwsh |
|---|---:|---:|---:|
| Context members | 72 s | 11,100 | 3.4 GB |
| Resources | 119 s | 6,800 | 3.4 GB |
| Users | 36 s | 5,000 | 2.2 GB |
| **Assignments** | **5,586 s (93 min)** | **7,340** | 2.3 GB |

Assignment throughput per 2 M rows went 10,500 → 9,000 (at 10 M) → 7,400 (at
24 M, where the standard run was at 2,750) → 5,300 rows/s (at 40 M). The database
after the assignments phase was 15.4 GB, and 26 GB once the matrix view was built:
`ResourceAssignments` 13 GB and `vw_ResourceUserPermissionAssignments` 11 GB. The
`INSERT` wait profile shifted from reading index pages towards the `WALWrite` lock
(25%) — with less written per row, WAL flushing becomes the next limit on stock
settings.

### Cross-check against `main`

After the runs above, `main` gained the CSV import fixes (#1263: quote-aware
parser, streamed resources and assignments, extra columns). The 10% load was
repeated on `main` (`b3bab23b6`):

| 10% | measured commit | `main` |
|---|---:|---:|
| Assignments | 576 s (7,100 rows/s) | 399 s (10,300 rows/s) |
| Classify + refresh views | 69 s | 120 s |
| Peak pwsh | 494 MB | 479 MB |
| Database after load | 7.3 GB | 7.5 GB |
| Unfiltered principal matrix | API crash | API crash |
| `buildContexts` hook | 404 | 404 |

`main` ingests ~45% faster at this size. Storage, the history trigger, the refresh
and every query finding are database- or API-side and are unchanged.

## After the load

All of this is on the complete 41 M-row database from the run without the
assignment history trigger, and at 10% for comparison.

### Post-sync work

The CSV crawler finishes with `classify-business-role-assignments`, then
`refresh-views`, then the post-sync hooks `buildContexts` and
`accountCorrelation`. Timed from the database side at 100%:

| Step | 10% | 100% |
|---|---:|---:|
| Classify endpoint, whole call (UPDATE + both refreshes), view already populated | 14–15 s | — |
| Classify: `UPDATE … SET governed = true` (1 M role assignments) | | 171 s |
| Classify: refresh of `vw_ResourceUserPermissionAssignments` — first population | | **1,166 s (19.5 min)** |
| Refresh of `vw_UserPermissionAssignmentViaBusinessRole` | | 23 s |
| `refresh-views`, standalone, view already populated | 13–14 s | 161 s |
| Transient disk during a refresh of the matrix view | | **~11–12 GB** |
| `buildContexts` hook | 404 | 404 |
| `accountCorrelation` hook | no-op | no-op |

**What goes wrong at 100%:**

- The classify endpoint refreshes both matrix views itself (by design — see
  `ingest.classify.test.js`). Its first call takes ~22 minutes. The crawler's HTTP
  client gives up after **300 s**, logs a transient failure and retries — four
  times. Every retry reruns the `UPDATE` (~50 s) and queues **another** full
  refresh behind the first. The crawler then gives up with "(non-critical)", calls
  `refresh-views` (another refresh; also times out) and reports success while the
  database keeps refreshing for up to an hour.
- A `REFRESH MATERIALIZED VIEW CONCURRENTLY` of the 11 GB view builds the new
  contents on disk before diffing them: free space fell from 18 GB to 5.9 GB during
  the first one. On this box a second refresh could not start while anything else
  was using temp space; two were cancelled by the test's disk guard.
- **The API refreshes the matrix view on every start** (`bootstrap.js`, "if the
  data is already populated, CONCURRENTLY makes this cheap"). At this size it is
  not cheap: 2–20 minutes and ~11 GB of scratch disk. Combined with the matrix
  crash below, one click on an unfiltered matrix restarts the API, which starts a
  refresh, which competes for disk with whatever the next user does.
- `buildContexts` posts to `/api/ingest/refresh-contexts`, which no longer exists;
  it 404s in 0.06 s at any size. Context member counts are recomputed inside
  `refresh-views` instead.

### Screens

Each is the exact request the UI sends. "Crash" means the API process died
(`FATAL ERROR: Reached heap limit … JavaScript heap out of memory`), Docker
restarted it, and every other user's request failed until it was back.

| Screen / request | 10% (4.1 M) | 100% (41 M) |
|---|---|---|
| Matrix, principal rows, unfiltered — `POST /matrix/data` | **crash** after 19 s | **crash** after 31 s |
| Matrix scope statistics — `POST /matrix/scope-stats` | 4.3 s | 48.8 s |
| Matrix, enabled accounts only | 413 after 12.6 s | **crash** after 123 s |
| Matrix, enabled + department Finance + a mid-size connector | 200 in 1.2 s, 65 MB | 413 after 24 s |
| Matrix, enabled + Finance + the smallest connector | — | 413 after 4.4 s (519,189 assignments) |
| Matrix, resources in the largest logical application | 200 in 5.2 s, **268 MB** | 413 after 82 s |
| Matrix, resources in an 80-entitlement application | — | 200 in 1.0 s, 2,775 rows |
| … same, plus enabled accounts only | — | **45.2 s** for 697 rows |
| Logical applications list — `GET /contexts?targetType=Resource&contextType=…` | 0.01 s | 0.18 s |
| Largest application's detail page — `GET /contexts/:id` (106 k members) | 3.7 s | **243.5 s** |
| … first page of its members — `GET /contexts/:id/members?limit=50` | 3.7 s | **243.2 s** |
| … members page at offset 50,000 | 249 s (empty page) | **did not finish in 30 min** |
| Resource detail, the top entitlement (17,100 / 171,000 holders) | 0.10 s | 0.58 s |
| … its assignments (fetched when the graph expands; not paged) | 0.09 s, 3.8 MB | 1.3 s, **38 MB** |
| … its members from the matrix view (not paged) | 1.0 s, 4.4 MB | 19.3 s, 44 MB |
| Report *Disabled accounts with access* — rows | 12.3 s, 2.9 MB | 75.4 s, 29.5 MB |
| … CSV export | 9.1 s, 1.1 MB | 76.4 s, 10.9 MB |
| Dashboard statistics | 0.54 s | 1.98 s |

Notes on the ones that matter:

- **The matrix row limit is checked too late.** `routes/matrix/data.js` loads the
  full result into the Node process and only then compares it to `MAX_FLAT_ROWS`
  (400,000) to return a 413. Past a few million rows the heap is exhausted first.
  There is no paging on this endpoint, so the only working views at this size are
  narrow ones — and because of the skew, a narrow subject filter does not make a
  narrow result: a handful of near-universal entitlements sit in every slice.
- **A subject filter can make a small matrix 45× slower.** The 80-entitlement
  application renders in 1 s; adding "enabled accounts only" takes 45 s for fewer
  rows. This is the filter the disabled majority makes most common.
- **Logical-application members are joined on text.** `loadMembers` in
  `routes/contexts/read.js` joins `ContextMembers` to `Resources` on
  `m.id::text = cm."memberId"::text`. The cast hides both indexes: the plan is a
  nested loop that compares every resource, in display-name order, against all
  106,000 materialised members (estimated 428 M rows) and stops when it has
  `OFFSET + LIMIT` matches. Page 1 costs 4 minutes; page 1,000 never ends.
- **An abandoned request keeps running.** When the client gave up on the deep page
  after 30 minutes, the query was still running in PostgreSQL 35 minutes in —
  there is no statement timeout and nothing cancels a query whose HTTP client has
  gone away.
- **"Pivot by logical application" does not exist as such.** The matrix can roll
  up the subject axis by an Identity/Principal context, but it cannot group
  resources by a Resource-targeted context. What the UI offers is the application
  list (fast), each application's page (slow, above) and a matrix filtered to one
  application (fine when small, 413 when large).
- The *Access outside roles* report returned no rows because this dataset links
  no roles to entitlements (no `ResourceRelationships.csv`); it is not a result.

## Weak points found along the way

- **`Sync-CsvContextMembers` survived 800 k rows, but at 3 GB** — at the measured
  commit, where it read through `Import-Csv` and built every record before sending.
  At 100% it completed in 67 s with the crawler's `pwsh` at ~3.0 GB RSS, and the
  next phase peaked at 3.6 GB, on a box with ~4.3 GB visible at the time. `main`
  now streams this file too (#1263); on the 10% cross-check the whole run peaked
  at 479 MB. Not re-measured at 100% on `main`.
- **An unknown `SystemName` was silently absorbed** at the measured commit: every
  phase fell back to the fallback system with no warning (8 call sites in
  `CSVCrawler.Phases.ps1`). `main` now warns with a count and the names (#1263).
- **Commas in values shifted columns under a comma delimiter** — at the measured
  commit. Its fast CSV path split on the delimiter with no quote handling, so a DN
  such as `"CN=GRP-…,OU=Application Groups,OU=East,DC=corp,DC=example,DC=com"`
  turned a 7-column row into 19 cells and `SystemName` into `DC=corp`, which then
  fell into the silent fallback above. That is why these runs used tabs. `main`
  now parses quoted values (#1263); the correctly quoted, comma-delimited case is
  kept as a regression fixture in
  [`tools/scale-dataset/fixtures/comma-shift/`](https://github.com/Fortigi/IdentityAtlas/tree/main/tools/scale-dataset/fixtures/comma-shift).
- **The `buildContexts` post-sync hook does nothing.** `Build-FGContexts.ps1` posts
  to `/api/ingest/refresh-contexts`, which no longer exists: every CSV run logs a
  404 and still reports success. The member counts it used to maintain are
  recomputed by `refresh-views` instead. `accountCorrelation` is a no-op ("not yet
  implemented in v5").

## What this means for the next piece of work

In the order a 41 M-row load hits them:

1. **Disk, because of `_history`.** 42 of ~68 GB. Whether a first load — or any
   bulk insert of brand-new rows — should be written to the audit history at all
   is a product decision; until it is made, a load this size needs ~70 GB free.
2. **Index maintenance during bulk load.** Measured at 80–90% of the database-side
   insert cost and the cause of the throughput decay. Dropping and rebuilding the
   13 `ResourceAssignments` indexes around a full load measured ~4.5× faster.
3. **Post-load refreshes.** The classify call refreshes the matrix views inside a
   request the crawler abandons after 300 s and then retries, stacking full
   refreshes; the API refreshes again on every start. Each refresh needs ~11 GB of
   scratch space at this size.
4. **The matrix endpoint.** Enforce the row limit before loading rows (a count, or
   a `LIMIT 400001`), so a large matrix returns 413 instead of taking the API down
   for everyone; then decide what the principal view should show at 41 M.
5. **Logical-application membership queries.** The text-cast join makes every
   application page proportional to (resources × members), and nothing stops a
   query its client has abandoned.

## Reproducing

Everything above can be rerun: the generator is deterministic from its seed, and a
full set takes 15 s to write. On a Docker host with at least 80 GB free:

```bash
node tools/scale-dataset/generate.mjs --out ./scale-10pct --scale 0.1
# create a CSV crawler config with "delimiter": "\t", put the six files in
# /data/uploads/csv-<configId>/ inside the web container, and start a full sync:
curl -X POST http://localhost:3001/api/admin/crawler-jobs \
  -H 'Content-Type: application/json' -d '{"jobType":"csv","configId":<id>,"syncMode":"full"}'
```

Start at 10%: in about ten minutes it reproduces the ingest profile and the matrix
crash. The disk wall, the refresh stacking and the four-minute application pages
only appear at full scale.

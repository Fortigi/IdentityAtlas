# Identity Atlas — API Benchmark

Benchmark against the 2.18M-row load-test dataset. The raw per-run numbers
live in [`results/BENCHMARK.md`](results/BENCHMARK.md) (overwritten on every
run); this document is the narrative summary plus what changed.

## Dataset

| Entity | Rows |
|---|---:|
| Systems | 126 |
| Contexts / OrgUnits | 70 229 |
| Resources (all) | 80 000 |
| Business roles (`resourceType='BusinessRole'`) | 13 225 |
| Principals (users) | 80 000 |
| ResourceAssignments | 1 500 221 |
| — of which Governed | 437 354 |
| ResourceRelationships | 99 998 |
| Identities | 25 000 |
| IdentityMembers | 76 000 |
| CertificationDecisions | 300 000 |

Generated via [`test/load-test/Generate-LoadTestData.ps1`](../load-test/Generate-LoadTestData.ps1).
Imported end-to-end in **37 minutes** by the CSV crawler.

## Benchmark configuration

- 5 runs per endpoint.
- `AUTH_ENABLED=false`, `PERF_METRICS_ENABLED=true`.
- Client: PowerShell 7.4 via `Invoke-WebRequest -UseBasicParsing`, which
  *does not parse the response body*. The earlier run used `Invoke-RestMethod`,
  which deserializes the JSON into PSCustomObjects — for an 80 MB matrix
  response that took **250 seconds in the client** even when the server
  delivered the response in 17 seconds. Switching to raw HTTP gave us
  honest server-side numbers.

## Before / after

Wall-clock p95 from the first benchmark run (pre-optimization) vs. the
current numbers after landing the whole batch of fixes below:

| Endpoint | Before (p95) | After (p95) | Speedup |
|---|---:|---:|---:|
| `matrix-benchmark-tag` | **334 131 ms** | **402 ms** | **831×** |
| `matrix-unfiltered` | 331 751 ms | 5 895 ms | **56×** |
| `systems` | 44 555 ms | 4 289 ms | **10×** |
| `access-packages` | 18 949 ms | 4 451 ms | **4.3×** |
| `resources-page1` | 1 278 ms | 161 ms | **8×** |
| `resources-business` | 364 ms | 89 ms | **4.1×** |
| `identities-page1` | 1 672 ms | 498 ms | **3.4×** |
| `users-page1` | 430 ms | 148 ms | **2.9×** |
| `sync-log` | 156 ms | 61 ms | **2.6×** |
| `users-search` | 950 ms | 400 ms | **2.4×** |
| `dashboard-stats` | 1 629 ms | 1 106 ms | **1.5×** |

Raw after-numbers (current run):

| Endpoint | avg | p50 | p95 | Response size |
|---|---:|---:|---:|---:|
| `sync-log` | 49 ms | 47 ms | 61 ms | 6.7 KB |
| `resources-business` | 71 ms | 75 ms | 89 ms | 10.5 KB |
| `users-page1` | 132 ms | 126 ms | 148 ms | 7.7 KB |
| `resources-page1` | 146 ms | 142 ms | 161 ms | 10.4 KB |
| `matrix-benchmark-tag` | 258 ms | 215 ms | 402 ms | 195 KB |
| `identities-page1` | 266 ms | 213 ms | 498 ms | 15.9 KB |
| `users-search` | 293 ms | 271 ms | 400 ms | 7.7 KB |
| `dashboard-stats` | 655 ms | 567 ms | 1 106 ms | 396 B |
| `systems` | 1 825 ms | 1 228 ms | 4 289 ms | 46.8 KB |
| `access-packages` | 3 493 ms | 3 212 ms | 4 451 ms | 7.4 MB |
| `matrix-unfiltered` | 3 630 ms | 2 638 ms | 5 895 ms | 584 KB |

## What changed

### 1. Materialized matrix views

Migration [`013_matrix_matviews_and_indexes.sql`](../../app/api/src/db/migrations/013_matrix_matviews_and_indexes.sql)
converts `vw_ResourceUserPermissionAssignments` and
`vw_UserPermissionAssignmentViaBusinessRole` to `MATERIALIZED VIEW`s and
adds unique + covering indexes. The old plain-view versions forced every
`/api/permissions` request to rebuild the 1.5 M-row join from scratch —
100+ seconds per call.

Refresh strategy:

- `refreshMatrixViews()` in [`app/api/src/routes/ingest.js`](../../app/api/src/routes/ingest.js)
  wraps `REFRESH MATERIALIZED VIEW CONCURRENTLY` (with a plain-refresh
  fallback for the first-run empty-matview case) plus `ANALYZE` of the
  big base tables so `pg_class.reltuples` stays accurate.
- Called from `/api/ingest/refresh-views` (the crawler hits it at
  end-of-sync), from `/api/ingest/classify-business-role-assignments`
  (after Direct → Governed promotion), and from [`bootstrap.js`](../../app/api/src/bootstrap.js)
  on web container startup.

### 2. Push `__userTag` filter down before the matrix join

[`permissions.js`](../../app/api/src/routes/permissions.js): when the
request carries `filters={"__userTag":"Benchmark"}`, the tag is resolved
up-front to a concrete principal-ID list which is then passed to the
main query as `WHERE p."principalId" = ANY(@principalIds)`. The old
implementation joined the full matrix view first and applied the tag
filter on top — for the 15-user benchmark case it was materializing
1.5 M rows and throwing 1 499 917 of them away. 334 s → 0.4 s.

### 3. Narrow `perm-ap-mapping` to the same user set

[`permissions.js`](../../app/api/src/routes/permissions.js): the AP
mapping query used to run `GROUP BY userId, resourceId` over the full
410 k-row business-role mapping matview. We now pass the same user-ID
list (or re-resolve the top-N subquery) as an IN-clause so the index
scan does the work instead of a full aggregation.

### 4. Systems list — CTEs instead of correlated subqueries

[`systems.js`](../../app/api/src/routes/systems.js): the old implementation
ran six correlated subqueries per system row — six scans of
`ResourceAssignments` × 126 systems × 1.5 M rows. Replaced with three
CTEs (one per child table) aggregated once and LEFT JOINed. Also drops
the `LEFT JOIN "Resources"` fallback path, because `ResourceAssignments`
has a denormalized `systemId` column in v5. 45 s → 4 s.

### 5. `access-package-resources` — let postgres build the JSON

[`permissions.js`](../../app/api/src/routes/permissions.js): rewrote the
endpoint to `json_agg` the resource list per business role at the
database, so postgres returns 13 k rows instead of ~100 k. The flat
shape is still computed in Node for backward compat with the frontend,
but the SQL side is now much faster. 19 s → 4.5 s.

### 6. Identities — Promise.all the independent queries

[`identities.js`](../../app/api/src/routes/identities.js): the `summary`,
`type-dist`, `count`, and `list` queries have no dependencies between
them. Running them in a single `Promise.all` lets postgres schedule
them on separate backends. 1.7 s → 0.5 s.

### 7. Dashboard stats — reltuples estimates for the big counts

[`admin.js`](../../app/api/src/routes/admin.js): the `/admin/dashboard-stats`
endpoint ran 15 unrelated `COUNT(*)` subqueries in one statement. On the
load-test dataset that was ~4 seconds of sequential scans of
`ResourceAssignments` etc. We now use `pg_class.reltuples` for the six
biggest tables (Resources, Principals, ResourceAssignments, Contexts,
Identities, ResourceRelationships, CertificationDecisions) and keep
exact counts only for the small tables and for filtered/indexed counts
(BusinessRole, Governed, active RiskProfiles, etc.). Accurate enough for
a home page, near-instant.

`refreshMatrixViews()` runs `ANALYZE` at the end so the reltuples
estimates stay within a few percent of reality. 1.6 s → 1.1 s; first
run after the matview refresh is faster still.

### 8. pg_trgm indexes for ILIKE search

Migration 013 installs `pg_trgm` and creates GIN indexes on
`Principals.displayName`, `Principals.email`, and `Resources.displayName`.
`ILIKE '%term%'` queries now hit index scans instead of sequential
scans. `users-search` went from 950 ms → 400 ms.

### 9. Partial indexes for filtered counts

Migration 013 adds:

- `ix_Resources_businessRole` — partial index on
  `Resources(id) WHERE resourceType = 'BusinessRole'`
- `ix_RA_governed` — partial index on
  `ResourceAssignments(resourceId, principalId) WHERE assignmentType = 'Governed'`

These back the filtered counts in dashboard-stats and the access-packages
assignment-count CTE without having to scan the parent table.

## Remaining work

### `access-packages` is still 3–4 seconds on the load-test dataset

The server-side SQL (`ap-groups`) is 2.5 s and the total response is
7.4 MB. At localhost speeds that's ~2 s of HTTP transfer, so the math
works. For a real deployment with 13 k business roles the response
should probably be paginated — the frontend shows at most ~50 business
roles at a time anyway. Kept flat for now to avoid breaking the current
consumer; split into `/api/access-packages?limit=N` + a detail endpoint
when the frontend is reshaped.

### `systems` p95 still has a ~4 s outlier

The CTE version runs in ~1.2 s warm but cold-cache it scans the 1.5 M-row
`ResourceAssignments` table once to build `ra_counts`. A parallel seq
scan that takes 3-4 s first time and stays hot afterwards. Fixable by
materializing the per-system counts (similar to the matrix views) but
the current numbers are acceptable for a tab that's not on the critical
path.

### First-request warmup is visible

Several endpoints show a p95 that's 2-10× the p50. Postgres has to
page-fault the relevant matview pages on the first query after startup
or refresh. Options:

- Add a tiny "touch the matview" query at the end of bootstrap's
  `refreshMatrixViews()` to prime the page cache.
- Accept the first-hit cost and keep the container warm in production.

## Load test timings

For reference, the CSV crawler import times on this machine:

| Step | Rows | Time |
|---|---:|---:|
| 1. Systems | 20 | 1 s |
| 2. Contexts | 15 000 | 25 s |
| 3. Resources | 80 000 | 2 min 1 s |
| 4. ResourceRelationships | 100 000 | 2 min 5 s |
| 5. Users / Principals | 80 000 | 2 min 29 s |
| 6. Assignments | 1 500 000 | 22 min 13 s |
| 7. Identities | 25 000 | 17 s |
| 8. IdentityMembers | 76 000 | 50 s |
| 9. Certifications | 300 000 | 7 min 9 s |
| **Total** | **~2.18 M** | **~37 min** |

## Running the benchmark yourself

```powershell
pwsh -File test/benchmark/Run-Benchmark.ps1              # 5 runs per endpoint
pwsh -File test/benchmark/Run-Benchmark.ps1 -Runs 3      # quick pass
```

The script uses `Invoke-WebRequest -UseBasicParsing` so the client
doesn't parse the JSON body — measurements reflect server + HTTP time,
not PowerShell deserialization cost.

A fresh `results/BENCHMARK.md` and timestamped `benchmark-YYYY-MM-DD_HHmm.json`
are written on every run. The nightly runner ([`test/nightly/Run-NightlyLocal.ps1`](../nightly/Run-NightlyLocal.ps1),
Phase 4k) runs it with `-FailOnRegression` and fails if any endpoint's
p95 goes more than 25% above `baseline.json`.

## Establishing the baseline

Now that the matrix + systems + access-packages endpoints are fixed, the
current numbers are a reasonable baseline. Commit one:

```powershell
Copy-Item test/benchmark/results/benchmark-<latest>.json test/benchmark/baseline.json
git add test/benchmark/baseline.json
```

Re-baseline any time you intentionally change dataset shape, view
definitions, or endpoint contracts.

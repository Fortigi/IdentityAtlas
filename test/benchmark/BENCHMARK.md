# Identity Atlas — API Benchmark

First benchmark run against the 2.18M-row load-test dataset. The raw numbers
and server-side SQL breakdowns live in
[`results/BENCHMARK.md`](results/BENCHMARK.md) (overwritten on every run); this
document is the narrative analysis plus the list of things to fix next.

## Dataset

| Entity | Rows |
|---|---:|
| Systems | 126 |
| Contexts / OrgUnits | 70 229 |
| Resources (all) | 80 000 |
| Business roles (`resourceType='BusinessRole'`) | 13 225 |
| Principals (users) | 80 000 |
| ResourceAssignments | 1 499 932 |
| — of which Governed | 437 354 |
| ResourceRelationships | 99 998 |
| Identities | 25 000 |
| IdentityMembers | 76 000 |
| CertificationDecisions | 300 000 |

Generated via [`test/load-test/Generate-LoadTestData.ps1`](../load-test/Generate-LoadTestData.ps1).
Imported end-to-end in **37 minutes** by the CSV crawler (see "Load test
timings" below).

## Benchmark configuration

- 3 wall-clock runs per endpoint (the script defaults to 5 — this first run
  used 3 because the matrix endpoint was hitting the 120 s HTTP timeout).
- `AUTH_ENABLED=false` — no auth overhead on any request.
- `PERF_METRICS_ENABLED=true` — server timings captured through the
  `perfMetrics` middleware.
- Client: PowerShell 7.4, `Invoke-RestMethod` over localhost.

## Headline results

| Endpoint | Client p95 | Verdict |
|---|---:|---|
| `GET /api/sync-log` | **156 ms** | Fine |
| `GET /api/users?limit=25` | **430 ms** | Fine |
| `GET /api/resources?resourceType=BusinessRole` | **364 ms** | Fine |
| `GET /api/users?search=user` | **950 ms** | Slow — `ILIKE '%user%'` on displayName/email with no trigram index |
| `GET /api/admin/dashboard-stats` | **1 629 ms** | Slow — 15 unrelated `COUNT(*)` subqueries in one statement |
| `GET /api/resources?limit=25` | **1 278 ms** | Slow — the non-BusinessRole branch has a missing filter index |
| `GET /api/identities?limit=25` | **1 672 ms** | Slow — runs three queries sequentially: `identity-type-dist`, `identity-summary`, `identity-list` |
| `GET /api/access-package-resources` | **18 949 ms** | **Broken** — the `ap-groups` query (`2.2 s` server) is only part of the total (`18.1 s`); the rest is JSON serialization in Node |
| `GET /api/systems` | **44 555 ms** | **Broken** — a single SQL query (`systems-list`) takes 37 s because each of the 126 systems scans `ResourceAssignments` (1.5 M rows) three times via correlated subqueries |
| `GET /api/permissions?userLimit=25` (matrix, unfiltered) | **331 751 ms** | **Broken** — two runs timed out at 120 s; the actual server time per run is ~100 s |
| `GET /api/permissions?filters={__userTag:Benchmark}&userLimit=500` (15 tagged users) | **334 131 ms** | **Broken** — even with 15 users in the filter, the query still joins against the full assignments + business-role view before filtering |

## What the SQL says

The numbers in brackets below come from `Server-Timing` headers (collected by
the `perfMetrics` middleware), not from client timings, so they exclude
network and JSON serialization.

### `GET /api/permissions` — ~100 s average, 3 SQL queries per call

```
perm-combined-limited   65.5 s   — main join over vw_ResourceUserPermissionAssignments
perm-total-users        14.5 s   — SELECT COUNT(DISTINCT ...) FROM the same view
perm-ap-mapping         10.7 s   — vw_UserPermissionAssignmentViaBusinessRole join
```

The matrix endpoint executes three independent queries back-to-back. Each of
them scans the full `ResourceAssignments` table (1.5 M rows) via
`vw_ResourceUserPermissionAssignments`, which is a non-materialized view.
When the user filter is a tag with 15 users, the view still materializes all
1.5 M rows before the outer `WHERE` narrows it down.

### `GET /api/systems` — 37.8 s, 1 SQL query

```
systems-list            37.8 s   — SELECT s.*, (corr), (corr), (corr), (json_agg), (json_agg)
```

Six correlated subqueries per row × 126 rows = 756 scans of the child tables.
With 1.5 M rows in `ResourceAssignments` and a join back to `Resources` inside
the subquery, this is quadratic on the biggest table.

### `GET /api/admin/dashboard-stats` — 1.2 s, 1 SQL query

```
(no explicit label) — 15 COUNT(*) subqueries joined as columns of a single row
```

None of the 15 counts have a supporting partial index. Postgres does 15 full
table scans sequentially. Every tab change on the Dashboard triggers this.

### `GET /api/access-package-resources` — 2.7 s server / 18 s client

```
ap-groups               2.2 s
```

The SQL side is tolerable (2.2 s on a 1.5 M × 13 k join) but the API spends
another **15 seconds in Node** building the response. Almost certainly the
`json_agg` on a 13 k × 80 k join is returning a gigantic result set that is
then being re-shaped in JavaScript. Serializing 15 MB of JSON through Express
is where the time goes.

## Performance — what to fix first

Ranked by impact for this dataset.

### 1. Matrix — materialize `vw_ResourceUserPermissionAssignments`

**Impact:** ~100× on the matrix endpoint.

The matrix view is the only screen users land on in the current UI and it
dominates every benchmark. Three separate passes of a 1.5 M-row view is
unworkable.

Concrete steps:
1. Convert `vw_ResourceUserPermissionAssignments` and
   `vw_UserPermissionAssignmentViaBusinessRole` to **materialized views**
   (postgres `MATERIALIZED VIEW`).
2. Add a `REFRESH MATERIALIZED VIEW CONCURRENTLY` call at the end of every
   CSV crawler run and at the end of any Entra sync.
3. Index the materialized view on `(principalId)` and `(principalId, resourceId)`
   so the user filter can push down before any join.
4. Replace the three separate SQL calls in
   [`app/api/src/routes/permissions.js:121-410`](../../app/api/src/routes/permissions.js#L121-L410)
   with one joined query against the materialized view.

Sanity check: the matrix view over the demo dataset (9 k users, 27 k groups)
runs in ~200 ms today, so the view query shape is fine — the problem is
that it's computed from scratch for every request.

### 2. `/api/systems` — stop doing correlated subqueries per row

**Impact:** 44 s → expected ~1 s.

Rewrite [`app/api/src/routes/systems.js:15-42`](../../app/api/src/routes/systems.js#L15-L42)
to use GROUP BY instead of correlated subqueries:

```sql
WITH res_counts AS (
  SELECT "systemId", COUNT(*) AS "resourceCount",
         json_agg(DISTINCT "resourceType") FILTER (WHERE "resourceType" IS NOT NULL) AS "computedResourceTypes"
  FROM "Resources" GROUP BY "systemId"
),
princ_counts AS (
  SELECT "systemId", COUNT(*) AS "principalCount"
  FROM "Principals" GROUP BY "systemId"
),
ra_counts AS (
  SELECT r."systemId",
         COUNT(*) AS "assignmentCount",
         json_agg(DISTINCT ra."assignmentType") FILTER (WHERE ra."assignmentType" IS NOT NULL) AS "computedAssignmentTypes"
  FROM "ResourceAssignments" ra
  INNER JOIN "Resources" r ON ra."resourceId" = r.id
  GROUP BY r."systemId"
)
SELECT s.*, COALESCE(rc."resourceCount", 0) AS "resourceCount",
       COALESCE(pc."principalCount", 0) AS "principalCount",
       COALESCE(rac."assignmentCount", 0) AS "assignmentCount",
       rc."computedResourceTypes", rac."computedAssignmentTypes"
  FROM "Systems" s
  LEFT JOIN res_counts rc  ON rc."systemId"  = s.id
  LEFT JOIN princ_counts pc ON pc."systemId" = s.id
  LEFT JOIN ra_counts rac  ON rac."systemId" = s.id
 ORDER BY s."displayName";
```

One scan per child table instead of 126 per query.

### 3. `/api/permissions` — narrow the filter **before** the view, not after

**Impact:** filtered matrix 322 s → expected < 2 s.

When the request carries `filters={"__userTag":"Benchmark"}`, the permissions
endpoint currently joins the full permissions view and then applies the tag
filter at the top. The 15-user case is extreme: the server materializes
1.5 M rows and then throws 1 499 997 of them away.

Fix in [`app/api/src/routes/permissions.js`](../../app/api/src/routes/permissions.js):
- If a `__userTag` or `__principalSearch` filter is present, resolve it to a
  concrete `principalId` list first (one quick query against
  `GraphTagAssignments`).
- Push that list down as `WHERE u.id = ANY(@principalIds)` in the main query
  so the planner can index-scan instead of full-scanning the view.

### 4. `/api/access-package-resources` — don't `json_agg` the whole join

**Impact:** 18 s → expected ~1 s.

The 15 s difference between the SQL time (2.2 s) and the client time (18 s) is
Node building the response. Two cheap fixes in [`app/api/src/routes/permissions.js`](../../app/api/src/routes/permissions.js):
- Return only the aggregate counts per access package on this endpoint;
  stream the resource lists through a separate `/api/access-package/:id/resources`
  endpoint when the user clicks a row.
- Or keep the current shape but use `json_build_object` at the DB level and
  let postgres build the JSON, so Express just forwards the string.

### 5. `/api/admin/dashboard-stats` — add partial-count indexes

**Impact:** 1.6 s → expected < 50 ms.

For each subquery with a WHERE clause, add a partial index. For the plain
`COUNT(*)` ones, the numbers are still cheap enough that this isn't urgent —
but postgres planners can answer `COUNT(*)` very fast when there's an
`indexonlyscan` path available. Candidates:

```sql
CREATE INDEX IF NOT EXISTS "ix_Resources_businessRole"
    ON "Resources"("id") WHERE "resourceType" = 'BusinessRole';
CREATE INDEX IF NOT EXISTS "ix_RA_governed"
    ON "ResourceAssignments"("resourceId") WHERE "assignmentType" = 'Governed';
```

### 6. `/api/users?search=X` — trigram index on `displayName` / `email`

**Impact:** 950 ms → expected ~80 ms.

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "ix_Principals_displayName_trgm"
    ON "Principals" USING GIN ("displayName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "ix_Principals_email_trgm"
    ON "Principals" USING GIN ("email" gin_trgm_ops);
```

With a trigram index, `ILIKE '%term%'` queries go from sequential scan to
index scan.

### 7. `/api/identities?limit=25` — parallelize the three queries

**Impact:** 632 ms → expected ~350 ms.

`identity-type-dist`, `identity-summary`, `identity-list` run sequentially
in [`app/api/src/routes/identities.js`](../../app/api/src/routes/identities.js).
They're independent — wrap them in `await Promise.all([...])` so postgres
can run them in parallel.

## Load test timings

For reference, the CSV crawler import times on this machine with the
post-fix (fast-path) crawler build:

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

Before the crawler fixes the 1.5 M assignments step never completed (it got
stuck in an O(N²) PowerShell array-append loop for >2 hours before being
killed). The relevant commits:

- `Send-GroupedBySystem` now uses `List[object]` and a Dictionary-based
  dedup with an ordinal string comparer (PowerShell hashtables degrade
  badly past ~500 k entries).
- `Read-CsvFast` replaces `Import-Csv` for large files — 5-10× faster
  because it skips PSCustomObject allocation entirely.
- Every `$list.Add(...) | Out-Null` was rewritten to `[void]$list.Add(...)`.
  The `Out-Null` cmdlet call overhead was a surprise dominant cost for 1.5 M
  iterations.
- The classify-business-role-assignments endpoint was split into a DELETE
  pass + UPDATE pass to avoid the "ON CONFLICT cannot affect row a second
  time" postgres error on redundant (Direct, Governed) pairs.

## Running the benchmark yourself

```powershell
pwsh -File test/benchmark/Run-Benchmark.ps1              # 5 runs per endpoint
pwsh -File test/benchmark/Run-Benchmark.ps1 -Runs 3      # quick pass
```

The script writes a fresh `results/BENCHMARK.md` (raw numbers) plus a
timestamped `results/benchmark-YYYY-MM-DD_HHmm.json`. The nightly runner
calls it with `-FailOnRegression` and fails the phase if any endpoint's
p95 goes more than 25 % above `baseline.json`.

## Establishing the baseline

The first benchmark against this dataset is useful for *finding* problems
but a terrible *baseline* — several endpoints are known-broken and
committing those numbers would immunize us against regression. The baseline
should be established **after** at least items 1 and 2 above are fixed:

```powershell
pwsh -File test/benchmark/Run-Benchmark.ps1
cp test/benchmark/results/benchmark-<latest>.json test/benchmark/baseline.json
```

Then commit `baseline.json` and enable `-FailOnRegression` nightly.

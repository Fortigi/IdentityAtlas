# API benchmark

Hits the main read endpoints, pulls the server-side metrics from `/api/perf`,
and writes a markdown report. Used both for ad-hoc performance investigation
and as a nightly regression check.

## Run it

```powershell
pwsh -File test/benchmark/Run-Benchmark.ps1
```

Defaults:

- `-ApiBaseUrl http://localhost:3001/api`
- `-Runs 5` (per endpoint)
- `-OutputFolder test/benchmark/results`
- `-BaselineFile test/benchmark/baseline.json`
- `-RegressionPct 25` (p95 increase above baseline that counts as a regression)

## What it does

1. **Inventory** — calls `/api/admin/dashboard-stats` so the report records
   the size of the dataset the numbers were taken against.
2. **Seeds a `Benchmark` tag + 15 tagged users**. The 15 users are pulled
   from the same system as the first `BusinessRole` resource so the next step
   can link them.
3. **Seeds governed assignments** — up to 5 business roles × 15 users, posted
   through `/api/ingest/resource-assignments` so the matrix has something
   non-empty to show when filtered by the tag.
4. **Clears `/api/perf`** so only this run's requests are measured.
5. **Exercises the target endpoints** N times each with wall-clock timing on
   the client side.
6. **Pulls `/api/perf/export`** and writes `BENCHMARK.md` + `benchmark-*.json`
   with:
   - dataset inventory
   - client-side p50 / p95 per endpoint
   - server-side p50 / p95 / p99 per route
   - SQL query breakdown for the 5 slowest endpoints
   - regression table if a baseline is present

## Establishing a baseline

The first time you run against a dataset:

```powershell
pwsh -File test/benchmark/Run-Benchmark.ps1
cp test/benchmark/results/benchmark-<timestamp>.json test/benchmark/baseline.json
```

Future runs will diff against the baseline. Commit the baseline when you want
everyone else to see the same numbers — typically after a known-good release.
Re-baseline when you intentionally change the shape of the data, the matrix
columns, or an endpoint's behaviour.

## Nightly integration

`Run-NightlyLocal.ps1` runs the benchmark as Phase 4i after the integration
tests. It passes `-FailOnRegression`, so any endpoint with a p95 more than
25% above the baseline fails the nightly run.

## Target endpoints

| Name | Path | What it proves |
|---|---|---|
| `dashboard-stats` | `/admin/dashboard-stats` | Home-page load |
| `matrix-unfiltered` | `/permissions?userLimit=25` | Default matrix view |
| `matrix-benchmark-tag` | `/permissions?userLimit=500&filters={__userTag:Benchmark}` | Tag-scoped matrix |
| `users-page1` | `/users?limit=25&offset=0` | Users tab first page |
| `users-search` | `/users?limit=25&offset=0&search=user` | Users tab text search |
| `resources-page1` | `/resources?limit=25&offset=0` | Resources tab first page |
| `resources-business` | `/resources?limit=25&offset=0&resourceType=BusinessRole` | Business-role list |
| `identities-page1` | `/identities?limit=25&offset=0` | Identities tab |
| `systems` | `/systems` | Systems tab |
| `access-packages` | `/access-package-resources` | Access-packages tab |
| `sync-log` | `/sync-log?limit=25` | Sync-log tab |

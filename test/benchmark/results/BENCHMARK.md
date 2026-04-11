# Identity Atlas — API Benchmark

_Run at_ `2026-04-11T19:59:46.7855282+02:00`

## Dataset inventory

| Entity | Rows |
|---|---:|
| Systems | 126 |
| Contexts / OrgUnits | 70229 |
| Resources (all) | 80000 |
| Business roles | 13225 |
| Principals (users) | 80000 |
| ResourceAssignments | 1500221 |
| Governed assignments | 437354 |
| ResourceRelationships | 99998 |
| Identities | 25000 |
| Certifications | 300000 |

## Client-side timings

Wall-clock over 5 runs per endpoint, measured via Invoke-WebRequest without JSON parsing (server-side HTTP time only).

| Endpoint | avg | p50 | p95 | Response size |
|---|---:|---:|---:|---:|
| `access-packages` | 3493.4 ms | 3211.5 ms | 4451.3 ms | 7,4 MB |
| `dashboard-stats` | 654.8 ms | 566.6 ms | 1106.1 ms | 396 B |
| `identities-page1` | 266.3 ms | 212.7 ms | 498.4 ms | 15,9 KB |
| `matrix-benchmark-tag` | 257.6 ms | 214.5 ms | 402.1 ms | 195,3 KB |
| `matrix-unfiltered` | 3630.3 ms | 2637.7 ms | 5895.2 ms | 583,8 KB |
| `resources-business` | 70.8 ms | 75.4 ms | 89.2 ms | 10,5 KB |
| `resources-page1` | 146.2 ms | 142.2 ms | 160.9 ms | 10,4 KB |
| `sync-log` | 49.2 ms | 47.2 ms | 60.8 ms | 6,7 KB |
| `systems` | 1825.1 ms | 1227.6 ms | 4288.7 ms | 46,8 KB |
| `users-page1` | 132.4 ms | 125.7 ms | 147.9 ms | 7,7 KB |
| `users-search` | 292.7 ms | 271.2 ms | 399.8 ms | 7,7 KB |

## Server-side timings (from /api/perf)

Per-route aggregates from the API's own middleware. `count` is the number of requests recorded during this benchmark run.

| Route | count | avg | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| `GET /api/permissions` | 10 | 1863.5 ms | 264.6 ms | 5802 ms | 5802 ms | 5802 ms |
| `GET /api/systems` | 5 | 1773.4 ms | 1185.7 ms | 4207.7 ms | 4207.7 ms | 4207.7 ms |
| `GET /api/access-package-resources` | 5 | 3102.8 ms | 2717.6 ms | 4025.4 ms | 4025.4 ms | 4025.4 ms |
| `GET /api/admin/dashboard-stats` | 5 | 610.7 ms | 509.3 ms | 1060.2 ms | 1060.2 ms | 1060.2 ms |
| `GET /api/identities` | 5 | 209.4 ms | 163.2 ms | 453.6 ms | 453.6 ms | 453.6 ms |
| `GET /api/users` | 10 | 176 ms | 120.3 ms | 363.3 ms | 363.3 ms | 363.3 ms |
| `POST /api/crawlers/jobs/claim` | 2 | 100.6 ms | 53.5 ms | 147.7 ms | 147.7 ms | 147.7 ms |
| `GET /api/resources` | 10 | 74.2 ms | 57.4 ms | 128.3 ms | 128.3 ms | 128.3 ms |
| `GET /api/sync-log` | 5 | 13.8 ms | 12.1 ms | 23.9 ms | 23.9 ms | 23.9 ms |
| `POST /api/perf/clear` | 1 | 3.4 ms | 3.4 ms | 3.4 ms | 3.4 ms | 3.4 ms |

## Server-side SQL query breakdown (slowest endpoints)

### `GET /api/permissions`

| SQL label | count | avg | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| `perm-combined-limited` | 10 | 918.3 ms | 61.3 ms | 3344.2 ms | 3344.2 ms |
| `perm-ap-mapping` | 10 | 840.4 ms | 28.5 ms | 2663.4 ms | 2663.4 ms |
| `perm-tag-resolve` | 5 | 105.4 ms | 105 ms | 112.1 ms | 112.1 ms |
| `perm-total-users` | 10 | 29.4 ms | 19.8 ms | 62.8 ms | 62.8 ms |
| `perm-mat-check` | 10 | 3.4 ms | 3.2 ms | 5.2 ms | 5.2 ms |

### `GET /api/systems`

| SQL label | count | avg | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| `systems-list` | 5 | 1770.5 ms | 1183 ms | 4202.7 ms | 4202.7 ms |

### `GET /api/access-package-resources`

| SQL label | count | avg | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| `ap-groups` | 5 | 2468.9 ms | 2136.6 ms | 3224.2 ms | 3224.2 ms |

### `GET /api/identities`

| SQL label | count | avg | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| `identity-type-dist` | 5 | 114.1 ms | 66.4 ms | 313.7 ms | 313.7 ms |
| `identity-list` | 5 | 67.9 ms | 49.1 ms | 105.2 ms | 105.2 ms |
| `identity-summary` | 5 | 40.6 ms | 40.3 ms | 61.5 ms | 61.5 ms |
| `identity-count` | 5 | 15.9 ms | 10.7 ms | 34.9 ms | 34.9 ms |



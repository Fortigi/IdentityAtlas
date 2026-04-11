# Identity Atlas — API Benchmark

_Run at_ `2026-04-11T19:34:57.6263037+02:00`

## Dataset inventory

| Entity | Rows |
|---|---:|
| Systems | 126 |
| Contexts / OrgUnits | 70229 |
| Resources (all) | 80000 |
| Business roles | 13225 |
| Principals (users) | 80000 |
| ResourceAssignments | 1499932 |
| Governed assignments | 437354 |
| ResourceRelationships | 99998 |
| Identities | 25000 |
| Certifications | 300000 |

## Client-side timings

Wall-clock over 5 runs per endpoint, as seen from the benchmark client.

| Endpoint | avg | p50 | p95 |
|---|---:|---:|---:|
| `access-packages` | 26186.2 ms | 24344.4 ms | 29977.1 ms |
| `dashboard-stats` | 1108 ms | 903.3 ms | 1493.3 ms |
| `identities-page1` | 570.4 ms | 293.7 ms | 1718.7 ms |
| `matrix-benchmark-tag` | 1563.7 ms | 1008.2 ms | 4051.2 ms |
| `matrix-unfiltered` | 247845.7 ms | 258658.4 ms | 294986.2 ms |
| `resources-business` | 165.4 ms | 122 ms | 258.1 ms |
| `resources-page1` | 366.5 ms | 261.6 ms | 845.3 ms |
| `sync-log` | 135.7 ms | 143.4 ms | 160.5 ms |
| `systems` | 7680.4 ms | 4911.7 ms | 19240.2 ms |
| `users-page1` | 140.3 ms | 136.7 ms | 165.2 ms |
| `users-search` | 315.6 ms | 303 ms | 421 ms |

## Server-side timings (from /api/perf)

Per-route aggregates from the API's own middleware. `count` is the number of requests recorded during this benchmark run.

| Route | count | avg | p50 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| `GET /api/permissions` | 10 | 12261.1 ms | 3200.6 ms | 33452.1 ms | 33452.1 ms | 33452.1 ms |
| `GET /api/systems` | 5 | 7559.7 ms | 4768.1 ms | 19123.4 ms | 19123.4 ms | 19123.4 ms |
| `GET /api/access-package-resources` | 5 | 7841.6 ms | 6817.5 ms | 12344.4 ms | 12344.4 ms | 12344.4 ms |
| `GET /api/admin/history-retention` | 1 | 5600.7 ms | 5600.7 ms | 5600.7 ms | 5600.7 ms | 5600.7 ms |
| `POST /crawlers/jobs/claim` | 1 | 5310.4 ms | 5310.4 ms | 5310.4 ms | 5310.4 ms | 5310.4 ms |
| `GET /api/admin/status` | 2 | 951.8 ms | 274.7 ms | 1628.8 ms | 1628.8 ms | 1628.8 ms |
| `GET /api/identities` | 5 | 469.4 ms | 199.8 ms | 1616.1 ms | 1616.1 ms | 1616.1 ms |
| `GET /api/admin/dashboard-stats` | 5 | 1049.2 ms | 852 ms | 1433.6 ms | 1433.6 ms | 1433.6 ms |
| `GET /api/features` | 5 | 356.3 ms | 252.6 ms | 1119.6 ms | 1119.6 ms | 1119.6 ms |
| `POST /api/crawlers/jobs/claim` | 46 | 322.1 ms | 217.8 ms | 876.1 ms | 1747.4 ms | 1747.4 ms |
| `GET /api/resources` | 10 | 166 ms | 80.5 ms | 797 ms | 797 ms | 797 ms |
| `GET /api/admin/crawler-configs` | 2 | 504.8 ms | 235.6 ms | 774 ms | 774 ms | 774 ms |
| `GET /api/users` | 10 | 176 ms | 109.1 ms | 368.6 ms | 368.6 ms | 368.6 ms |
| `GET /api/sync-log` | 8 | 88.9 ms | 24.9 ms | 285.8 ms | 285.8 ms | 285.8 ms |
| `GET /api/admin/crawlers` | 2 | 119.6 ms | 56.9 ms | 182.3 ms | 182.3 ms | 182.3 ms |
| `GET /api/admin/crawler-jobs` | 2 | 73.8 ms | 23.7 ms | 124 ms | 124 ms | 124 ms |
| `POST /api/perf/clear` | 1 | 2.2 ms | 2.2 ms | 2.2 ms | 2.2 ms | 2.2 ms |

## Server-side SQL query breakdown (slowest endpoints)

### `GET /api/permissions`

| SQL label | count | avg | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| `perm-ap-mapping` | 10 | 3381.2 ms | 71.2 ms | 10267.6 ms | 10267.6 ms |
| `perm-combined-limited` | 10 | 2160.9 ms | 840.6 ms | 5978.9 ms | 5978.9 ms |
| `perm-tag-resolve` | 5 | 618.8 ms | 266.7 ms | 2149.1 ms | 2149.1 ms |
| `perm-total-users` | 10 | 50.7 ms | 43.1 ms | 103 ms | 103 ms |
| `perm-mat-check` | 10 | 9 ms | 6.3 ms | 21.1 ms | 21.1 ms |

### `GET /api/systems`

| SQL label | count | avg | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| `systems-list` | 5 | 7556.6 ms | 4765 ms | 19118.8 ms | 19118.8 ms |

### `GET /api/access-package-resources`

| SQL label | count | avg | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| `ap-groups` | 5 | 6575 ms | 5738.8 ms | 10349 ms | 10349 ms |



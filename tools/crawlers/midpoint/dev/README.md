# midPoint Crawler — Developer Tools

Scripts in this folder are **development and testing utilities**, not part of the production crawler. They are not loaded by the dispatcher and not shipped in the worker image.

---

## Seed-MidpointLoadData.ps1

Seeds a fictitious AD (users, groups, group memberships) as raw shadows directly in a midPoint instance, for load and capacity testing of the crawler.

### Usage

```powershell
. .\Seed-MidpointLoadData.ps1

# Create load data (run from the worker container or any host that can reach midPoint)
New-MidpointLoadData -BaseUrl <midpoint-url> -Username administrator -Password <pw> -Tier T1

# Cleanup — only touches the 1b… OID block, safe to run against any midPoint instance
Remove-MidpointLoadData -Tier T1 -BaseUrl <midpoint-url> -Username administrator -Password <pw>
```

### Tiers

| Tier | Users | Groups | Memberships | Notes |
|---|---|---|---|---|
| T1 | 250 | 1,000 | 30,000 | Quick baseline |
| T2 | 1,000 | 5,000 | 150,000 | Medium scale |
| T3 | 2,500 | 10,000 | 300,000 | Target production size |
| T4 | 2,500 | 10,000 | 1,000,000 | Stress tier |

Memberships follow a deterministic power-law distribution (a few universal groups + a long tail), seeded for reproducibility.

All OIDs use the `1b…` block — disjoint from the functional fixture OIDs (`1a…`), so load data and test fixtures can coexist safely.

### Measured results (midpoint-dev + identityatlas, streaming crawler)

| Tier | Crawl wall-clock | Ingest throughput |
|---|---|---|
| T1 | 12.8 s | 9,740 rec/s |
| T2 | 39.5 s | 9,704 rec/s |
| T3 | 76.7 s (warm: 59.1 s) | 8,230 rec/s |
| T4 | 313–371 s | 4,886–7,869 rec/s |

The streaming crawler completes T4 within a 1.5 GiB managed-heap limit. The midPoint JVM stays at ~2.4 GiB of 4 GiB regardless of tier — midPoint is not the bottleneck.

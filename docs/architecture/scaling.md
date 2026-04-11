# Scaling & Load Testing

This page documents the largest workload Identity Atlas has been tested
against, the hardware it ran on, and the observed throughput — so you can
judge whether your own tenant fits in the tested envelope.

!!! note "TL;DR"
    Identity Atlas has been load-tested with a **2.17 million-record
    synthetic dataset (~97 MB of CSV)** ingested end-to-end in **about
    30 minutes** on a **6-core / 16 GB VM on older server hardware**.
    Every batch in the sync log came back `Success`, and the Dashboard,
    Matrix, and detail pages stay responsive afterwards. No special
    tuning, no dedicated database host, no cluster.

## The load test dataset

The synthetic dataset is produced by [test/load-test/Generate-LoadTestData.ps1](https://github.com/Fortigi/IdentityAtlas/blob/main/test/load-test/Generate-LoadTestData.ps1).
A fixed random seed (`20260411`) makes the output reproducible, and the
ready-made CSVs are committed under [test/load-test/data/](https://github.com/Fortigi/IdentityAtlas/tree/main/test/load-test/data)
so you don't have to regenerate them — they weigh in at ~97 MB total.

| Entity                    | Records       | CSV size |
|---------------------------|---------------|----------|
| Systems                   | 20            | < 1 KB   |
| Users                     | 80,000        | 7.6 MB   |
| Resources                 | 80,000        | 6.7 MB   |
| Contexts (departments)    | 15,000        | 0.9 MB   |
| Identities                | 25,000        | 2.1 MB   |
| Identity members          | 76,000        | 1.9 MB   |
| Resource assignments      | **1,500,000** | 51.5 MB  |
| Resource relationships    | 100,000       | 3.7 MB   |
| Certification decisions   | 300,000       | 22.7 MB  |
| **Total**                 | **~2.17 M**   | **~97 MB** |

This is intentionally top-heavy on *assignments* and *certifications* —
those are the tables that grow fastest in real tenants and that matter
most for both ingest throughput and query performance on the Matrix
view.

## The hardware

The test was run on a **virtual machine on an older server**, not a
modern laptop or a tuned database box. The host the screenshots below
were taken on:

| Resource | Spec                                         |
|----------|----------------------------------------------|
| CPU      | 1 socket / 6 cores / 6 logical, 3.70 GHz base |
| Memory   | 16 GB                                        |
| Disk     | SAS SSD                                      |
| OS       | Windows running Docker Desktop               |

Observed during the tail end of the ingest run:

| Signal   | Utilisation | Reading                                                |
|----------|-------------|--------------------------------------------------------|
| CPU      | **73 %**    | Headroom left — ingest is not CPU-bound                |
| Memory   | **87 %**    | Tight — 16 GB is close to the minimum for this dataset |
| Disk     | **1 %**     | The SAS SSD is idle, disk I/O is not a bottleneck      |

In plain language: the limiting factor on this box is **RAM**, not CPU
and not disk. If you have at least 16 GB free for the stack and
a modern SSD, Identity Atlas will handle a tenant of roughly this size
on whatever hardware happens to be available — there is nothing special
going on.

## Observed ingest times

These are the actual durations captured in the sync log for the full
load-test run. Numbers are taken straight from the `GraphSyncLog` table
via the UI's **Sync Log** page.

| Phase                    | Records       | Duration     | Throughput     |
|--------------------------|---------------|--------------|----------------|
| Identities               | 25,000        | 9 s          | ~2,800 rows/s  |
| Identity members         | 76,000        | 40 s         | ~1,900 rows/s  |
| Certification decisions  | 300,000       | 4 min 12 s   | ~1,190 rows/s  |
| Resource assignments     | 1,500,000     | ~20 min[^1]  | ~1,250 rows/s sustained |
| **Full run**             | **~2.17 M**   | **~30 min**  | **~1,200 rows/s overall** |

[^1]: The Resource Assignments phase runs as roughly 20 MERGE batches
    of 75,000 records each, via the Ingest API's built-in batching.
    Individual batch durations observed ranged from 22 s (warm cache)
    to 2 min 12 s (early batches, index rebuild). Identity Atlas does
    not retry successful batches, so the wall-clock total is simply
    the sum of the per-batch durations.

The small-table phases (Systems, Principals, Resources, Contexts,
Resource Relationships) all finish in well under a minute each and are
rounding errors in the total runtime. The interesting phase is
**Resource Assignments** — with 1.5 M rows it is the dominant chunk of
the ingest time, and it's where the sustained ~1,250 rows/sec number
comes from.

## What the UI looks like afterwards

Once ingest completes, the Dashboard shows the combined counts across
all loaded systems. In one test run this looked like:

| Counter        | Value |
|----------------|-------|
| Systems        | 126   |
| Users          | 80 k  |
| Resources      | 80 k  |
| Business Roles | 13 k  |
| Identities     | 25 k  |
| Contexts       | 70 k  |
| Assignments    | 1.5 M |
| Relationships  | 100 k |

(Higher than the raw generator output in Systems, Contexts, and
Business Roles because this run also had older test data still
present — the numbers you get from a clean generator run will be
closer to the "load test dataset" table above.)

With that state loaded:

- **Dashboard** renders instantly, with accurate stat counts.
- **Matrix view** handles the full assignment table. Use the
  user-limit slider (default 25, see [Matrix page](../api/matrix.md))
  to keep the rendered grid interactive — Identity Atlas applies this
  limit at the SQL level, so it scales independently of how many
  rows live in the table.
- **Detail pages** for a single user, resource, or access package
  load in well under a second.
- **Sync log** shows every batch as `Success` — no retries, no
  timeouts, no failed batches.

## Reproducing the load test yourself

You have two options:

### Option 1: use the committed fixtures

The CSV files are already in the repo at [test/load-test/data/](https://github.com/Fortigi/IdentityAtlas/tree/main/test/load-test/data).
Upload them via the in-browser CSV crawler wizard:

1. Go to **Admin → Crawlers → Add Crawler → CSV**.
2. Step 1: pick a system name (any — the crawler will honour the
   `SystemName` column from `Systems.csv`).
3. Step 2: upload the nine CSVs from `test/load-test/data/`.
4. Submit. The built-in worker picks the job up within 30 seconds.

Watch the **Sync Log** page while it runs. You'll see the same phase
pattern as the table above.

### Option 2: regenerate the dataset

If you want different sizes or a different seed:

```powershell
# Full 2.17 M record dataset
.\test\load-test\Generate-LoadTestData.ps1

# Smaller, e.g. for sanity checks in CI
.\test\load-test\Generate-LoadTestData.ps1 `
    -UserCount 1000 `
    -ResourceCount 1000 `
    -AssignmentCount 10000

# Or crank it up — the generator has no built-in ceiling
.\test\load-test\Generate-LoadTestData.ps1 `
    -UserCount 200000 `
    -AssignmentCount 5000000
```

See the generator's parameter block for the full list of knobs
(`UserCount`, `ResourceCount`, `SystemCount`, `ContextCount`,
`IdentityCount`, `AssignmentCount`, `RelationshipCount`,
`CertificationCount`, `IdentityMemberRatio`, `Seed`).

## What this tells you about your own tenant

- **If your tenant is smaller than the load test**, you're comfortably
  inside the tested envelope. No hardware planning required — a spare
  VM or a developer laptop will do.
- **If your tenant is roughly the size of the load test** (tens of
  thousands of users, a million-ish assignments), expect ingest on the
  order of 30 minutes on modest hardware. Matrix, detail pages, and
  dashboard remain responsive. Keep at least 16 GB RAM free for the
  stack.
- **If your tenant is larger**, the limiting factor is going to be
  memory first, then the Resource Assignments ingest throughput.
  Throughput scales roughly linearly with CPU clock and core count on
  the ingest pipeline, and Postgres itself benefits from more RAM and
  faster storage. Moving Postgres off Docker Desktop onto a dedicated
  host with proper shared buffers is the first thing to try if you
  need to scale well past 5 M assignments.

## Caveats

- These numbers are **observed, not guaranteed**. They describe a
  specific run on a specific host with a specific Docker Desktop
  configuration. Your mileage will vary with CPU frequency, Docker
  resource limits, filesystem choice, and concurrent workload on the
  host.
- The dataset is **synthetic**. Real tenants have less uniform
  distributions (power-law on group membership, clustered
  certifications, etc.) that can change the ingest profile. The load
  test is a ceiling check, not a production simulation.
- **Crawler-driven ingest** (Entra ID or similar) is typically
  bottlenecked by the upstream API's pagination, not by Identity
  Atlas's write path. A Graph API pull of 80 k users takes longer
  than the corresponding CSV ingest, because Graph rate-limits you.
  See [Entra ID sync](../sync/entra-id.md) for what to expect there.

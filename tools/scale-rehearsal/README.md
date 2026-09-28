# Scale rehearsal harness

The scripts that produced the measurements in
[`docs/architecture/scale-rehearsal.md`](../../docs/architecture/scale-rehearsal.md).
They were written on the rig and lived only there until the step-7 re-run; they are
committed so the next re-run starts from the same instruments instead of a
reconstruction of them.

They are **rig tooling, not product code**. They assume a Linux host with Docker,
`python3`, a `scale-test` Compose project built from a checkout at
`~/stacks/scale-test` (with a `compose.scale.yml` override that publishes the web
container on port 3005 and PostgreSQL on 127.0.0.1:5433), the scripts themselves in
`~/harness/`, and the dataset from [`tools/scale-dataset`](../scale-dataset) in
`~/scale-data/p100`. Copy this folder to `~/harness` on the rig.

## The runs

| Script | What it runs |
|---|---|
| `step7.sh [ref]` | The authoritative re-run: deploy `ref` (default `main`), wipe the database, regenerate the 41M dataset, one full CSV crawler load, post-sync, a restart with populated views, the query set. |
| `step7-repeat.sh [ref] [configId]` | Waits for `step7.sh`, redeploys `ref` onto the same database, then: the same crawler config over byte-identical files (a repeat import, with before/after snapshots of systems, rows per system, governed duplicates and `_history`), an unchanged re-import through the staged load, and `filter-shape.sh`. |
| `step7-resume.sh` | Resumes step 7 at the query set (used once, when the first query set had to be discarded). |
| `attribute.sh <label> <regex> <ref>...` | Attribution of a regression: the same queries on the same database with each code version deployed in turn, twice each. |
| `filter-shape.sh <label>` | Writes the customer's extension-attribute shape onto principals and resources, then measures filter-value discovery cold (API restarted) and warm. Chains `enabled-share.sh`. Rewrites every principal and resource: run it after anything that must compare against the loaded data. |
| `enabled-share.sh <label> [pct]` | Sets a share of principals enabled (default 62%, the customer's), refreshes the views, re-runs the enabled-filtered matrix queries. |

## The instruments

| Script | Role |
|---|---|
| `deploy.sh <ref> [--worker]` | Point the stack at a ref (branch or **full** commit SHA) and rebuild web (and worker); the database is kept. |
| `reset.sh` | `down -v` + `up`: an empty database. |
| `run-load.sh <dataset> <label>` | One instrumented CSV crawler load. `CONFIG_ID=n` re-runs an existing config. Has a disk guard that stops the job below `GUARD_GB`. |
| `bench.sh <label>` | The query set: post-sync calls (each followed by a wait for the background refresh it schedules — see below), the matrix, logical applications, resource detail, the report, the dashboard, filter-value discovery cold and warm. `SKIP=<regex>` / `ONLY=<regex>` select measurements. |
| `stage-bench.py <csv> <batches\|stage> <label>` | Drives the staged full load (or the batch protocol) directly, streaming the assignments file. |
| `sampler.sh`, `pgactivity.sh`, `refresh-counter.sh`, `logtail.py` | Every 5 s: process and container memory, database size; the non-idle backends; every `REFRESH MATERIALIZED VIEW`; the job log, stamped on arrival. |
| `pgguard.sh` | Cancels the app database's queries when the shared disk falls below `MIN_MB`. |
| `analyze.py` | Summarises a run's samples. |

The other scripts (`compound100.sh`, `integ100.sh`, `step4.sh`, `step6.sh`,
`index-experiment.sh`, `merge-experiment.sh`, `refresh-timed.sh`, `extra.sh`) are the
one-off experiments of the earlier steps, kept because the report cites their
numbers.

## Two traps this harness has already fallen into

- **Background refresh.** Since #1269, `POST /ingest/refresh-views` and
  classification return once a refresh is *scheduled*. A query set that starts right
  after them measures beside a 15-minute refresh that also needs ~11 GB of scratch
  disk. `bench.sh` waits for it (`settle`); anything new that triggers a refresh must
  too.
- **Short SHAs.** `deploy.sh` fetches the ref from GitHub; a short commit SHA cannot
  be fetched. Use the full one.

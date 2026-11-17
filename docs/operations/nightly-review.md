# Nightly tests + automated Claude review

This document covers the automated nightly suite that runs at 02:00 daily on
the developer workstation, plus the optional Claude-driven review pass that
looks at the results afterwards.

## What gets tested

The runner is `test/nightly/Run-NightlyLocal.ps1`. The review is a separate
scheduled step that reads its report. Phases:

| Phase   | What it does                                                                                              |
|---------|-----------------------------------------------------------------------------------------------------------|
| 1       | PowerShell unit tests (Pester)                                                                            |
| 1b      | Verify deleted-function references don't sneak back in                                                    |
| 2       | Backend Vitest tests (`app/api/`)                                                                         |
| 3       | Frontend Vitest tests (`app/ui/`)                                                                         |
| 4a-c    | Provision a fresh Docker stack, wait for migrations, verify schema                                        |
| 4d-e    | Queue a demo crawler job, verify the data lands                                                           |
| 4f      | Smoke-test all read endpoints                                                                             |
| 4g      | Entra ID crawler scenarios (Validate-Only, Identity-Only, Users-Groups, Full-Sync, With-Identity-Filter). Skipped when test/test.secrets.json is missing. |
| 4h      | LLM / secrets / risk-profile substrate smoke test                                                         |
| 5       | Playwright E2E browser tests                                                                              |
| 6       | API documentation completeness check                                                                      |
| Review  | (Separate scheduled session, acts only on failure) Investigate, fix, open a pull request                  |

### Deep assertions added April 2026

The Full-Sync scenario does more than count rows now. After every Entra crawler
completes successfully it runs:

- **`Assert-MatrixWorks`** — verifies `/api/permissions?userLimit=25` returns
  rows with the right shape, `/api/access-package-groups` is reachable, and
  `/api/groups-with-nested` returns the expected envelope. This catches the
  "matrix loads but is empty" class of bug.
- **`Assert-BusinessRolesWork`** — verifies the Business Roles list returns
  rows with non-zero `totalAssignments`. This was the April 2026 regression
  where the route returned rows but with all-zero counts because the SQL
  filter used lowercase `'delivered'` while the column stores `'Delivered'`.
- **`Assert-SyncLogShape`** — verifies the sync log has entries, every entry
  has a numeric `DurationSeconds`, and (only after a real Entra Full-Sync)
  there's an `EntraID-FullCrawl` row written by the crawler script at
  end-of-run.
- **`Assert-PostSyncEndpoints`** — pings all the routes that were broken or
  T-SQL-leftover after the postgres rewrite (governance/summary,
  governance/categories, governance/review-compliance, admin/llm/status,
  admin/llm/config, admin/history-retention, risk-profiles, risk-classifiers,
  risk-scoring/runs).

The substrate phase (4h) runs `Test-LLMSubstrate.ps1` and validates the LLM
config endpoint, the secrets vault round-trip, and that the scoring run
endpoint returns 412 (preconditions failed) rather than 500 when no
classifier is active.

## Scheduling

```powershell
# Register the nightly run at 02:00 daily (default)
pwsh -File test\nightly\Register-NightlySchedule.ps1

# Pick a different time
pwsh -File test\nightly\Register-NightlySchedule.ps1 -Time '03:30'

# Remove the schedule
pwsh -File test\nightly\Register-NightlySchedule.ps1 -Unregister
```

The task runs as the current user with `S4U` logon — no password prompt, runs
whether or not the user is signed in. It does **not** wake the workstation,
because Docker on Windows doesn't always cope with cold-start under power
management. Make sure the box stays awake (or wake it via BIOS scheduling
if you need to).

Logs land in `test/nightly/results/<yyyy-MM-dd_HHmm>/`. Each run writes a
`report.md` there and copies it to `test/nightly/results/latest.md`, so the
most recent report is always at the same path.

## The review pass

The review is a separate, scheduled Claude Code session, not part of the test
runner. The prompt it runs is kept in `test/nightly/scheduled-review-prompt.md`;
paste it into a daily Claude Code schedule set a couple of hours after the
nightly run (the prompt assumes tests at 02:00 and the review at 04:00).

The session reads `test/nightly/results/latest.md`:

- If the report is missing or more than 12 hours old, the nightly did not run
  and the session stops.
- If there are no failures, it reports "All green" and stops.
- If there are failures, it reads the detailed logs, the failing test and the
  code under test, and sorts each failure into environmental flake, tooling
  issue or real bug. For a real bug it edits the source, re-runs the failing
  test, commits on a fresh `nightly-review/<date>` branch and opens a pull
  request into `main`.

## Safety constraints

The prompt in `test/nightly/scheduled-review-prompt.md` explicitly forbids:

- Pushing to `main` directly — fixes always go through a pull request
- `docker compose down -v`
- Modifying `.github/workflows/`

It also tells the session to stop chasing a failure it cannot diagnose in about
ten minutes and to write up its findings instead.

## Running the suite without scheduling

Run it on demand:

```powershell
# Full nightly suite
pwsh -File test\nightly\Run-NightlyLocal.ps1

# Skip the browser tests and keep the Docker stack up afterwards for debugging
pwsh -File test\nightly\Run-NightlyLocal.ps1 -SkipE2E -KeepEnvironment

# Check that the assertions wired up correctly without a full nightly run
pwsh -File test\nightly\Test-LLMSubstrate.ps1
pwsh -File test\nightly\dry-run-assertions.ps1
```

The dry-run script loads only the new `Assert-*` helpers from
`Test-EntraIdCrawler.ps1` and runs them against whatever data is currently in
the local stack. It needs the demo dataset (or a real crawler) loaded first;
queue a demo job from the UI or via:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"jobType":"demo"}' http://localhost:3001/api/admin/crawler-jobs
```

## Where to look in the morning

```
test/nightly/results/latest.md               ← the most recent report
test/nightly/results/<date>/
  ├── report.md                               ← the same report, kept per run
  ├── results.json                            ← machine-readable test results
  ├── summary.txt                             ← plain-text summary
  └── *.log                                   ← per-phase logs
```

If the report lists failures and the review session ran, look for a
`nightly-review/<date>` branch and its pull request to see what was changed.

## Limitations

- **The scheduled task cannot wake the workstation.** If the box was suspended
  at the scheduled time the task runs whenever it next starts. Plan accordingly.
- **Re-runs are full nightly runs.** To repeat only one area, run the individual
  scenario script directly (e.g.
  `Test-EntraIdCrawler.ps1 -Scenarios @('Identity-Only')`).

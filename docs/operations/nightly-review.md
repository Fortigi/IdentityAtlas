# Nightly tests + automated Claude review

This document covers the automated nightly suite that runs at 04:00 daily on
the developer workstation, plus the optional Claude-driven review pass that
fires only when something fails.

## What gets tested

The runner is `test/nightly/Run-NightlyAndReview.ps1`. It wraps the existing
`Run-NightlyLocal.ps1` and adds a post-test review step. Phases:

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
| Review  | (Only on failure) Investigate, fix, re-run                                                                |

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
# Register the wrapper at 04:00 daily (default)
pwsh -File test\nightly\Register-ReviewSchedule.ps1

# Pick a different time
pwsh -File test\nightly\Register-ReviewSchedule.ps1 -Time '03:30'

# Also remove the old standalone test task — recommended, since the wrapper
# already runs the nightly tests.
pwsh -File test\nightly\Register-ReviewSchedule.ps1 -RemoveOldNightlyTask

# Remove the schedule
pwsh -File test\nightly\Register-ReviewSchedule.ps1 -Unregister
```

The task runs as the current user with `S4U` logon — no password prompt, runs
whether or not the user is signed in. It does **not** wake the workstation,
because Docker on Windows doesn't always cope with cold-start under power
management. Make sure the box stays awake (or wake it via BIOS scheduling
if you need to).

Logs land in `test/nightly/results/<yyyy-MM-dd_HHmm>/`. A one-line summary
per run is appended to `test/nightly/results/_rolling-summary.log` so you can
`tail` it to see the last week of pass/fail status.

## The review pass

When the test suite has zero failures, the review pass is a **no-op** — it
writes a single line to the rolling log and exits. No LLM tokens are spent.
This is the design: pay only when there's something to fix.

When there are failures, the wrapper builds a structured prompt with:

- The list of failed test names and their detail strings
- The current branch, HEAD commit, and last commit's `git log -1 --name-status`
- Paths to all log files in the run folder
- The constraint block (what Claude is and isn't allowed to do)
- The token budget

Then it picks one of three execution paths in priority order:

### Path A — Claude Code in headless fix-it mode (preferred)

If the `claude` CLI is on `PATH` (or at `$ClaudeCli`), the wrapper invokes:

```
claude -p "<prompt>" --dangerously-skip-permissions --add-dir <repo>
```

Claude has read/edit/run permission on the repo, can rebuild containers,
re-run individual tests, and commit fixes on a fresh `nightly-review/<date>`
branch. **It cannot push.** The morning operator reviews and decides.

After Claude finishes, the wrapper re-runs the nightly suite once and uses
*that* exit code as its own. So a successful auto-fix run looks like:

```
04:00  Run-NightlyAndReview.ps1 starts
04:01  Phase 1-4 run, 1 failure detected in Phase 4f
04:30  Claude invoked, identifies the issue, edits a file, rebuilds web
04:35  Claude commits to nightly-review/2026-04-09 and exits
04:35  Wrapper re-runs the nightly suite
05:05  Re-run completes with 0 failures
05:05  Wrapper writes "FIXED" to the rolling log and exits 0
```

### Path B — Anthropic API analysis only

If `claude` isn't installed but `ANTHROPIC_API_KEY` is set (or
`test/test.secrets.json` has an `AnthropicApiKey` field), the wrapper makes
**one** API call and writes Claude's analysis to `review-analysis.md` in the
run folder. No fix attempt, no re-run. Token usage is bounded by
`-MaxTokensPerReview` (default 4096 → roughly $0.05 per call).

### Path C — No LLM available

If neither path is configured, the wrapper writes the full prompt to
`claude-prompt.txt` in the run folder so you can paste it into Claude Code
manually in the morning.

## Cost shape

| Outcome             | LLM tokens   | Cost (rough)     |
|---------------------|--------------|------------------|
| All tests pass      | 0            | $0               |
| Failure, Path A     | ~5k-30k      | $0.10-$2.00      |
| Failure, Path B     | ~2k-4k       | $0.02-$0.08      |

If the suite has been green for a week, the review system has cost you
nothing. Cost only happens when there's actually something to investigate.

## Safety constraints

The prompt template at `test/nightly/claude-review-prompt.md` explicitly
forbids:

- `git push` (anywhere, ever)
- `git reset --hard`, `git clean -f`, `git branch -D`
- `docker compose down -v`
- Dropping database tables, deleting database rows
- `--no-verify`, `--no-gpg-sign`, or any flag that bypasses commit hooks
- Modifying CI/CD pipeline files

Claude is told to commit fixes on a fresh `nightly-review/<date>` branch and
stop. The morning operator decides whether to merge.

## Testing the wrapper without scheduling

Run it on demand:

```powershell
# Full thing — runs the nightly suite, reviews failures, re-runs
pwsh -File test\nightly\Run-NightlyAndReview.ps1

# Skip the fix-it Claude invocation. Useful before you trust the system.
# Will still run the nightly tests + (if there's an API key) produce a
# read-only analysis markdown.
pwsh -File test\nightly\Run-NightlyAndReview.ps1 -NoFix

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
test/nightly/results/_rolling-summary.log    ← one line per nightly run
test/nightly/results/<date>/
  ├── results.json                            ← machine-readable test results
  ├── nightly-output.log                      ← full nightly stdout
  ├── review.log                              ← wrapper's own log
  ├── review-analysis.md                      ← Claude's analysis (Path A or B)
  └── claude-prompt.txt                       ← the prompt that was sent (Path C)
```

If the rolling log says `FIXED`, look at the `nightly-review/<date>` git
branch to see what Claude changed.

If it says `FAIL`, open `review-analysis.md` to see what Claude found before
giving up.

If it says `PASS`, you have nothing to do.

## Limitations

- **The wrapper cannot wake the workstation.** If the box was suspended at
  04:00 the task runs whenever it next starts. Plan accordingly.
- **The Anthropic API key must live somewhere the wrapper can read it
  without the Identity Atlas stack.** The vault inside Identity Atlas is
  intentionally NOT used as the primary source — at 4 AM the most likely
  reason for needing the review is that Identity Atlas itself is broken.
  Use `ANTHROPIC_API_KEY` env var or `test/test.secrets.json`.
- **Path A (fix-it mode) requires the Claude Code CLI on PATH.** If you
  haven't installed it, the wrapper falls back to Path B automatically.
- **Re-runs are full nightly runs.** They take ~30 minutes. The wrapper does
  not yet support "re-run only the failed tests" — if you need that, run
  the individual scenario script directly (e.g.
  `Test-EntraIdCrawler.ps1 -Scenarios @('Identity-Only')`).

# Identity Atlas — Nightly Test Review Prompt

Paste this prompt into the Claude Code app schedule (daily at 04:00).
The nightly test suite runs at 02:00 via Windows Task Scheduler and
finishes around 03:15. This agent reviews the results, fixes failures,
and creates a PR.

## Prompt

```
Review the Identity Atlas nightly test results and fix any failures.

1. Read test/nightly/results/latest.md — that's the full test report.
   If the file is missing or older than 12 hours, the nightly didn't run. Stop.

2. If 0 failures: report "All green" and stop.

3. If there ARE failures, read CLAUDE.md for project conventions, then for each failure:
   - Read the detailed log in test/nightly/results/<timestamped-folder>/
   - Read the test script to understand the assertion
   - Read the source code the test exercises
   - Categorize: environmental flake (skip), tooling/PATH issue (note), or real bug (fix)
   - For real bugs: edit the source, rebuild if needed (docker compose build web && docker compose up -d web), re-run the specific failing test to verify

4. If you made fixes:
   - Create branch: git checkout -b nightly-review/<today's date>
   - Stage only changed source files (not test results/logs)
   - Bump version in setup/IdentityAtlas.psd1
   - Add bullet to CHANGES.md
   - Commit and push
   - Create PR into main: title "Nightly review: <date> — <N> fix(es)", body with failure summary + what you fixed + re-run results

5. Output a brief summary: date, passed/failed counts, fixes applied, PR link, anything needing manual attention.

Rules:
- NEVER push to main directly — always PR
- NEVER docker compose down -v
- NEVER modify .github/workflows/
- If you can't diagnose in ~10 minutes, write up findings and move on
- Environmental flakes (timeouts, port conflicts) self-resolve — don't chase them
```

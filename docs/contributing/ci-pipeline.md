# CI Pipeline

Two GitHub Actions workflows run on every PR targeting `main`. Both use the same two-step pattern: a **commit-range skip** job that detects housekeeping-only pushes, then **path-filter gates** that run only what actually changed. A handful of **post-merge** workflows then run on the push to `main` itself (version bump, docs deploy, SBOM and coverage refresh) — see [Post-merge workflows](#post-merge-workflows-push-to-main) below.

Branch protection requires two checks to pass before a PR can merge:

| Required check | Workflow | What it gates |
|---|---|---|
| `CI Passed` | `pr.yml` | Lint, unit tests, build, hygiene |
| `Integration CI Passed` | `pr-integration.yml` | Docker integration tests, E2E, load soak |

---

## pr.yml — fast checks (~5 min)

### Commit-range skip

The `changes` job inspects commit messages in the push range. If every commit is a housekeeping commit (`chore: bump version to …` or `Merge branch 'main' into …`), all downstream jobs are skipped and `CI Passed` reports green. This prevents re-running CI when "Update branch" imports only an automated version bump.

A fresh branch push (no previous SHA) or a force-push/rebase always runs CI.

### Path gates

When product changes are detected, a `filter` job uses `dorny/paths-filter` to produce boolean outputs. Each job only runs if its relevant paths changed:

| Job | Check name | Runs when |
|---|---|---|
| `lint-ps` | Lint: PSScriptAnalyzer | `tools/crawlers/**/*.ps1`, `tools/powershell-sdk/**`, `setup/**/*.ps1` |
| `lint-js` | Lint: ESLint | `app/ui/src/**`, `tools/crawlers/**/*.jsx` |
| `unit-tests` | Unit Tests: Pester | `tools/powershell-sdk/**`, `tools/crawlers/shared/**`, `setup/docker/Invoke-CrawlerJob.ps1`, `test/unit/**` |
| `unit-js` | Unit Tests: Vitest (API) | `app/api/src/**` |
| `contract-tests` | Contract Tests: Vitest + PostgreSQL | `app/api/src/**`, `app/api/contract-tests/**`, `app/api/test-utils/**` |
| `unit-ui` | Unit Tests: Vitest (UI) | `app/ui/src/**`, `tools/crawlers/**/*.jsx` |
| `node-launcher-ui-build` | Build: Node-launcher UI | `app/ui/src/**`, `tools/crawlers/**/*.jsx` |
| `openapi` | Lint: OpenAPI spec | `app/api/src/openapi.yaml` |

These four jobs have **no path gate** — they always run when there are product changes:

| Job | Check name | Purpose |
|---|---|---|
| `audit` | Audit: npm audit | npm vulnerability scan (known advisories) |
| `supply-chain` | Audit: Supply-chain firewall (Socket) | Installs both Node projects through [Socket Firewall](https://github.com/SocketDev/sfw-free), blocking known-malicious packages with no CVE yet |
| `hygiene` | PR Hygiene | Branch naming, PR description checks |
| `crawler-manifest` | Lint: Crawler manifest completeness | Every crawler has a `crawler.json` |
| `docs-nav` | Lint: Crawler docs registered in site nav | Every crawler has a docs entry in `mkdocs.yml` |

### Gate jobs

`ci-passed` (`CI Passed`) wraps all of the above. It fails if any job failed or was cancelled; it passes if all jobs succeeded or were legitimately skipped. This is the check required by branch protection.

`pr-summary` (`PR Summary`) is a stub that runs after `ci-passed`. It exists to suppress a ghost pending check created by the Claude GitHub App (used for issue triage, autofix, and release notes) — the app creates a "PR Summary" check suite on every PR push that would otherwise show as permanently pending.

### Labels

| Label | Effect |
|---|---|
| `skip-hygiene` | Skips the PR Hygiene job |

---

## pr-integration.yml — Docker integration tests (~20–50 min)

### Commit-range skip

Same logic as `pr.yml` — skips the entire integration suite when only housekeeping commits were pushed.

### Path gates

A `filter` job determines which heavy jobs need to run:

| Job | Check name | Runs when |
|---|---|---|
| `integration` | Integration Tests | API source, crawler `.ps1`/`.js`, shared infra, Dockerfiles, compose files |
| `e2e` | Playwright E2E | UI source, crawler `.jsx`, API source, Dockerfile |
| `load-soak` | Load & Soak Tests | API source, shared infra, `Start-*.ps1`, Dockerfiles, compose files |

### Per-crawler scoping

When the `integration` job is triggered, a `scope` step computes `CRAWLERS_TO_TEST` from the git diff against the base branch:

- **Shared infra changed** (`tools/crawlers/shared/`, `tools/powershell-sdk/`, `Invoke-CrawlerJob.ps1`, `IdentityAtlas.psm1`, `Dockerfile.powershell`) → full run, all crawlers tested.
- **Only specific crawler directories changed** → only those crawler types are listed (e.g. `csv,omada`).
- **Integration triggered by non-crawler paths** (e.g. `app/api/src/`) → full run.

The PS integration runner expands `CRAWLERS_TO_TEST` using the dependency graph:

```
testSet = changed crawler types + their transitive dependents (upward)
runSet  = testSet + their transitive dependencies (downward, for data setup)
```

Types in `runSet` but not `testSet` run for data setup only — their exit code is ignored. Types in `testSet` must pass.

Example: only `omada` changed → `testSet = [omada]`, `runSet = [odata, omada]`. The `odata` crawler runs first to seed the data omada's test needs; only omada's result is asserted.

### Gate job

`ci-integration-passed` (`Integration CI Passed`) wraps `integration`, `e2e`, and `load-soak`. Same logic as `CI Passed` — failure or cancellation fails the gate; success or legitimate skip passes it.

### Labels

| Label | Effect |
|---|---|
| `integration-test` | Forces full crawler run regardless of which paths changed |
| `load-soak` | Forces load soak regardless of which paths changed |
| `skip-load-soak` | Skips load soak even when paths would trigger it |
| `skip-e2e` | Skips Playwright E2E |

---

## Post-merge workflows (push to main)

These run **after** a PR merges, on the push to `main` — not as PR gates. They push their results back to `main` with the GitHub App token (branch protection blocks `GITHUB_TOKEN`), each rebasing-and-retrying to absorb the concurrent `bump-version.yml` commit on the same merge.

| Workflow | Triggers on | What it does |
|---|---|---|
| `bump-version.yml` | Every PR merge | Increments `Minor` + timestamp in `setup/IdentityAtlas.psd1`, merges `changes/*.md` fragments into `CHANGES.md`, pushes `:edge` Docker tag |
| `docs.yml` | `docs/**`, `mkdocs.yml` changes; releases | Builds the MkDocs site and deploys with `mike` (edge from `main`, stable from a release tag) |
| `sbom-update.yml` | Dependency-manifest changes | Regenerates the SPDX SBOM and refreshes `docs/reference/sbom.md` |
| `coverage.yml` | `app/api/src/**`, `app/ui/src/**`, `tools/crawlers/**`, `tools/powershell-sdk/**`, `tools/riskscoring/**`, `test/unit/**` | Runs API/UI (Vitest) + Pester with coverage, converts each suite to a browsable HTML report via ReportGenerator, renders `docs/reference/coverage.md`, and commits the page + `docs/coverage/**` |

### coverage.yml — test coverage to docs

The coverage workflow publishes line/branch/method coverage for all three suites to the **Reference → Test Coverage** docs page, each suite linking to a full per-file HTML report.

- **Build:** `npm run test:coverage` for API and UI (Vitest v8 → `lcov.info`); Pester over `tools/powershell-sdk`, the crawler dirs, and `tools/riskscoring` (→ JaCoCo XML). The API suite also runs the contract tests with coverage (`npm run test:contract -- --coverage` → a second `lcov.info`); [ReportGenerator](https://github.com/danielpalme/ReportGenerator) merges the unit + contract lcov for the API row, so route code exercised only end-to-end still counts. It converts each suite to a consistent HTML report + `Summary.json`, which `tools/generate-coverage-doc.py` turns into the curated page.
- **Versioning:** because the page and reports are committed into `docs/`, `mike` builds them into **both** doc versions — edge refreshes every merge, a release is frozen at its tag's numbers.
- **No loop:** the commit only touches `docs/**`, so it re-triggers `docs.yml` (redeploy) but not `coverage.yml` (its paths filter is source/tests only) and not `docker-publish.yml` (gated on `bump-version`).
- A suite that fails or produces no coverage degrades gracefully — the page still renders, marking that suite as having no report.

---

## What runs for common change types

| What changed | PS lint | Pester | API tests | UI tests | Crawler tests | E2E | Load soak |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| One crawler's `.ps1` files only | ✅ | — | — | — | that crawler + dependents | — | — |
| `tools/crawlers/shared/` | ✅ | ✅ | — | — | all crawlers | — | ✅ |
| `tools/powershell-sdk/` | ✅ | ✅ | — | — | all crawlers | — | ✅ |
| `app/api/src/` | — | — | ✅ | — | all crawlers | ✅ | ✅ |
| `app/api/contract-tests/` or `app/api/test-utils/` | — | — | ✅ contract only | — | — | — | — |
| `app/ui/src/` | — | — | — | ✅ | — | ✅ | — |
| Crawler `.jsx` wizard only | — | — | — | ✅ | — | — | — |
| Dockerfiles / compose | — | — | — | — | all crawlers | ✅ | ✅ |
| Housekeeping only | — | — | — | — | — | — | — |

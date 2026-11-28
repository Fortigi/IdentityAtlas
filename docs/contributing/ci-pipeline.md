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
| `unit-tests-shard` + `unit-tests` | Unit Tests: Pester (shard N/4), then Unit Tests: Pester (merges shard coverage, applies the 90% floor) | `tools/powershell-sdk/**`, `tools/crawlers/shared/**`, `setup/docker/Invoke-CrawlerJob.ps1`, `test/unit/**`, `tools/pester/**` |
| `unit-js` | Unit Tests: Vitest (API) — includes the [core ontology check](maintaining-the-ontology.md) | `app/api/src/**`, `ontology/**`, `docs/**` |
| `contract-tests` | Contract Tests: Vitest + PostgreSQL | `app/api/src/**`, `app/api/contract-tests/**`, `app/api/test-utils/**`, `ontology/**` |
| `unit-ui` | Unit Tests: Vitest (UI) | `app/ui/src/**`, `tools/crawlers/**/*.jsx` |
| `node-launcher-ui-build` | Build: Node-launcher UI | `app/ui/src/**`, `tools/crawlers/**/*.jsx` |

`static-gates` (**Lint: static gates**) is one job holding six small checks as steps, each with its own path gate: file-length ratchet (any source file), migration immutability (`app/api/src/db/migrations/**`), Node-version consistency (`.nvmrc`, workflows, Dockerfiles, `package.json`), OpenAPI lint (`app/api/src/openapi.yaml`), crawler-manifest completeness (every product change) and compiled Azure templates (`azure/**`). A failing check does not stop the others; the final **Verdict** step fails the job and lists which check failed in the job summary. They used to be six jobs, each paying a runner start for a few seconds of work.

These four jobs have **no path gate** — they always run when there are product changes:

| Job | Check name | Purpose |
|---|---|---|
| `audit` | Audit: npm audit | npm vulnerability scan (known advisories) |
| `supply-chain` | Audit: Supply-chain firewall (Socket) | Installs both Node projects through [Socket Firewall](https://github.com/SocketDev/sfw-free), blocking known-malicious packages with no CVE yet |
| `hygiene` | PR Hygiene | Branch naming, PR description checks |
| `docs-nav` | Lint: Crawler docs registered in site nav | Every crawler has a docs entry in `mkdocs.yml` |

### Gate jobs

`ci-passed` (`CI Passed`) wraps all of the above. It fails if any job failed or was cancelled; it passes if all jobs succeeded or were legitimately skipped. This is the check required by branch protection.

`pr-summary` (`PR Summary`) is a stub that runs after `ci-passed`. It exists to suppress a ghost pending check created by the Claude GitHub App (used for issue triage, autofix, and release notes) — the app creates a "PR Summary" check suite on every PR push that would otherwise show as permanently pending.

### Labels

| Label | Effect |
|---|---|
| `skip-hygiene` | Skips the PR Hygiene job |

### Docs guards

The documentation is checked by Vitest tests in `app/api/src/docs/`, so they run in **Unit Tests: Vitest (API)**. That job also runs on a docs-only PR (the `docs` path gate: `docs/**`, `mkdocs.yml`, `app/api/src/docs/**`, `ontology/**`).

| Guard | Fails when |
|---|---|
| `docsStructure.guard.test.js` | A page is missing from the nav, a nav entry or a relative link points at a page that does not exist, a learning-path page lacks its `type` / `prereq` / `outcome`, or a learning-path `#anchor` is dead. Hard zero, no baseline. |
| `docsDrift.guard.test.js`: retired vocabulary | A page uses a retired word more often than `.ci/docs-jargon-baseline.json` allows. |
| `docsDrift.guard.test.js`: links and anchors | A page has a broken link that `.ci/docs-links-baseline.json` does not list. |

**Retired vocabulary.** The banned words are listed in `app/api/src/docs/docsJargon.js`, each with the word to use instead: SOLL and IST (whole words, upper case, so "list" and "exist" do not match), org unit / OrgUnit, the retired assignment types (`assignmentType='Governed'`, `assignmentType='Owner'`, `AppRoleViaGroup`, `OAuth2Grant`, `DirectoryRoleEligible`) and the `Start-FGSync` cmdlet. Code samples count the same as prose, because a sample query is the line readers copy. The UI rule `local/no-legacy-jargon` keeps its own copy of the list; the guard fails if the UI bans a word that the docs list does not. Some pages keep the old words on purpose: the glossary note that maps them, the dated assessments (`security/`, `ux/` and the audit pages), the history page, and the design archive. They are listed with a reason in `EXEMPT` in the same file.

**Links and anchors.** This check covers every page, not only the learning path. It looks at each relative link and image and reports:

- an `#anchor` that the target page does not generate;
- a file that does not exist (a missing screenshot, for example);
- a target outside `docs/`, which the site does not publish.

Anchors are computed the way mkdocs computes them. Punctuation is dropped, the text is lowercased, and each run of spaces and hyphens becomes ONE hyphen, so `## SMTP & mail` gives `#smtp-mail`, not `#smtp--mail`. A repeated heading gets `_1`, `_2`, and `{ #id }` sets an id by hand.

**How the baselines work.** Each baseline lists, per page, what is still wrong today and how many times it occurs. A count above the baseline fails. So does a new page or a new term. A count below the baseline never fails, so fixing a page needs no baseline change in the same PR. Lock in an improvement, or see the result locally, with:

```bash
cd app/api
npm run docs:check      # same comparison as CI, with what to write instead
npm run docs:baseline   # lower both baselines to the current state of docs/
```

`docs:baseline` only lowers: anything that got worse keeps its old ceiling and the command exits 1. `npm run docs:baseline -- --allow-increase` writes the measurement as it is and prints every raised entry. Use it only for an exception a reviewer has agreed to.

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

## Release workflows

None of these gate a PR. How they fit together, what the release test covers and the one-time setup are in [Release process](release-process.md).

| Workflow | Triggers on | What it does |
|---|---|---|
| `release-weekly.yml` | Schedule, Tuesdays 02:07 UTC; by hand | Plans the run and starts up to two routes: the **stable route** when `release/X.Y` moved (a patch beta, the release test, then the stable patch on `:latest` if green) and the **beta route** when `main` got Dependabot updates of shipped code (a beta of the next minor and the release test). Azure only for the first beta of a minor and when the templates changed. Without a new beta of `main` it tests an untested pre-release or `:edge`. A manual run is a dry run by default |
| `release-route.yml` | Called by `release-weekly.yml` | One route: Cut Beta on an exact commit, wait for the images, the release test, and for the stable route Cut Hotfix on the same commit; one issue per route on failure |
| `release-test.yml` | Called by the weekly run and the routes; by hand; PRs that change the release test itself (against `:edge`, advisory) | Docker upgrade, backup and restore, fresh install (with and without the report generator), sign-in with real Entra ID tokens, both portable ZIPs on Windows, and with `azure` the Azure templates in `ia-reltest-*` resource groups |
| `dependabot-auto-merge.yml` | Dependabot PRs into `release/**` (`pull_request_target`) | Auto-merges patch and minor updates of the release line once CI is green |
| `cut-beta.yml` | By hand; called by the routes | Tags `vX.Y.Z-beta.N` (on `main`, or on the release line with `hotfix`), builds the ZIPs, creates the pre-release. `dry_run` pushes no tag |
| `cut-release.yml` | By hand | Tags `vX.Y.Z` on a commit on `main`, builds the ZIPs and the Azure package, creates the release. For `X.Y.0` also creates `release/X.Y` and opens the PR that moves Dependabot there |
| `cut-hotfix.yml` | Called by the stable route; by hand | Tags `vX.Y.Z` on a commit of the release line (cherry-picks of `main` commits and Dependabot updates), creates the release. `dry_run` pushes no tag |
| `cut-tag.yml` | Called by the three `cut-*.yml` above | Their shared steps: the main-only check, the tag, the ZIPs and Azure package, the release notes and the GitHub release. Each `cut-*.yml` keeps its own inputs, notes prompt and run summary |
| `docker-publish.yml` | Every `bump-version.yml` run; every `v*` tag | Builds, smoke-tests and CVE-scans the images, then pushes `:edge`, `:beta` (only for `X.Y.0` pre-releases) or `:latest`. Refuses a tag that is not on `main` or a release branch, unless main's checker accepts it as a hotfix |

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

## Scheduled reviews of main

These read `main` on a schedule (and on demand, Actions → Run workflow). They are not PR gates. A scheduled run that fails opens or updates one issue per workflow (`.github/scripts/scheduled_failure_issue.sh`).

| Workflow | When | What it does |
|---|---|---|
| `docs-review.yml` | Nightly, 03:00 UTC | Reads the last 24 hours of commits against the docs and opens a draft PR with the edits it thinks are needed |
| `security-review.yml` | 2nd of the month | AI-assisted security review of the code and a running stack; see [Security testing](../security/index.md) |
| `docs-audit.yml` | 9th of the month | Reads **all** hand-written docs against the code and opens an issue per place a reader would be misled |

### docs-audit.yml — monthly docs audit

The nightly review only sees one day's diff, so drift that builds up over several PRs (a table that became a context, a switch that became a grid) slips past it. The monthly audit reads every page in `docs/` (except `docs/coverage/` and the dated records listed in `EXEMPT` in `app/api/src/docs/docsJargon.js`), `README.md`, the `CLAUDE.md` guides and `ontology/core.ttl`, and checks what they say against the code. The checklist is `.github/docs-review/prompt.md`. Broken links and retired words are left to the [docs guards](#docs-guards).

- **Two jobs.** The model runs with a read-only token and writes `findings.json`. A second job without the model validates it (`app/api/src/docsReview/`) and opens the issues. A finding needs a code reference as evidence and must point at a page that exists.
- **Issues.** Each finding becomes an issue labelled `documentation`, `bug`, `ai-docs-review` and `needs-vouch`, assigned to the maintainers in `DOCS_AUDIT_ASSIGNEES`. Apply `dor-vouched` to hand it to the bug pipeline, fix it by hand, or close it.
- **No duplicates.** Each issue carries a fingerprint marker. Next month's audit leaves a finding alone while its issue is open, never files it again once the issue is closed as **not planned**, and files it again (marked "came back") if it was closed as fixed but is still there.
- **At most 25 new issues per run.** The rest wait for the next run, which finds them again.
- **Dry run.** Run it by hand with *dry-run* ticked to see the plan in the job summary without opening issues.

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

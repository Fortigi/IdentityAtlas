# CI Scope-Targeted Testing

> Tracked in: [Issue #375](https://github.com/Fortigi/IdentityAtlas/issues/375)

## Problem

Every PR update — including a bare "Update branch" that only imports an automated `chore: bump version` commit — re-runs the full CI pipeline. All lint jobs, all unit tests, and a 50-minute Docker integration suite fire unconditionally. The only existing gates are: Azure credentials missing (secret-dependent tests skip gracefully) or a manually added label. Everything else always runs.

This produces two problems:

1. **Wrong time** — CI re-runs on housekeeping imports where the feature code hasn't changed and the result is predetermined.
2. **Wrong scope** — a change to a single crawler's PowerShell script triggers the full integration suite including crawlers that were never touched, and the 50-minute load soak.

The goal is: test the right things, for the right reasons, at the right time.

---

## Current pipeline overview

| Workflow | Trigger | Duration | Current skip logic |
|---|---|---|---|
| `pr.yml` | `pull_request` | ~5 min | None |
| `pr-integration.yml` | `pull_request` | ~50 min | `paths-ignore` on `changes/**`, `docs/**`, `**.md` |
| `docker-publish.yml` | `workflow_run` from `bump-version` | ~15 min | N/A — runs on merge to `main` only, never on PRs |

Jobs in `pr.yml`: `lint-ps`, `lint-js`, `unit-tests` (Pester), `unit-js` (Vitest API), `unit-ui` (Vitest UI), `node-launcher-ui-build`, `openapi`, `audit`, `hygiene`, `crawler-manifest`, `docs-nav`, `pr-summary`.

Jobs in `pr-integration.yml`: `integration` (core + crawler tests), `e2e` (Playwright), `load-soak`.

---

## Why `paths-ignore` alone doesn't solve the "Update branch" problem

After "Update branch" (GitHub merges `main` into the feature branch), the PR diff is evaluated between the new `main` base and the updated feature head. The bump files (`CHANGES.md`, `setup/IdentityAtlas.psd1`, `changes/*.md`) are now equal on both sides — they were just merged in — so they don't appear as changed files. CI re-runs not because of those files, but because a new commit was pushed (`pull_request: synchronize` fires unconditionally). `paths-ignore` has nothing to exclude because the product code is still in the PR diff.

---

## Scope-to-test matrix

What each change surface should trigger:

| What changed | PS lint | Pester unit | API vitest | UI vitest | OpenAPI | Crawler tests (specific) | Crawler tests (all) | E2e | Load soak |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `tools/crawlers/<type>/` only | ✅ | — | — | ✅ | — | ✅ (that type + dependents) | — | — | ✅ |
| `tools/crawlers/shared/` | ✅ | ✅ | — | — | — | — | ✅ | — | ✅ |
| `tools/powershell-sdk/` | ✅ | ✅ | — | — | — | — | ✅ | — | ✅ |
| `setup/docker/Invoke-CrawlerJob.ps1` / `IdentityAtlas.psm1` | ✅ | ✅ | — | — | — | — | ✅ | — | ✅ |
| `app/api/src/` (non-migration) | — | — | ✅ | — | — | — | — | — | ✅ |
| `app/api/src/db/migrations/` | — | — | ✅ | — | — | — | — | — | ✅ |
| `app/api/src/openapi.yaml` | — | — | — | — | ✅ | — | — | — | — |
| `app/ui/src/` | — | — | — | ✅ | — | — | — | ✅ | — |
| `tools/crawlers/*/ConfigWizard.jsx` / `CrawlerMeta.js` / `Summary.jsx` | — | — | — | ✅ | — | — | — | — | — |
| Dockerfiles / compose files | — | — | — | — | — | — | ✅ | ✅ | ✅ |
| Housekeeping only (`CHANGES.md`, `psd1`, `changes/`) | — | — | — | — | — | — | — | — | — |

### Load soak triggers

Load soak exists to catch regressions in throughput and query performance that unit tests cannot see at volume. It must run automatically when any processing path changes:

```
Automatic triggers:
  app/api/src/**
  tools/crawlers/shared/**
  tools/powershell-sdk/**
  tools/crawlers/*/Start-*.ps1
  setup/docker/Invoke-CrawlerJob.ps1
  setup/docker/Dockerfile.powershell
  docker-compose*.yml

Skipped when only:
  app/ui/src/**
  tools/crawlers/*/ConfigWizard.jsx|CrawlerMeta.js|Summary.jsx|*.test.*
  docs/**  changes/**  *.md  setup/IdentityAtlas.psd1
```

The `load-soak` label is a **force-trigger supplement** for cases where you want a soak run on a PR that wouldn't automatically qualify (e.g. a targeted query optimisation). It does not replace the automatic triggers above.

---

## Crawler dependency model

Test obligation propagates **upward to dependents**, not downward to dependencies.

| What changed | What to test | What to run (setup only, no assertions) |
|---|---|---|
| `odata` changed | `odata` + `omada` (omada depends on odata — odata changes can break omada even with no omada code changes) | — |
| `omada` changed | `omada` only | `odata` (run first to populate data omada's test needs; odata's behavior hasn't changed) |

### Two sets

```
CRAWLERS_TO_TEST = changed types ∪ transitive dependents   (traverse upward)
CRAWLERS_TO_RUN  = CRAWLERS_TO_TEST ∪ transitive dependencies of CRAWLERS_TO_TEST
                   (traverse downward, for data setup)
```

The PS integration runner already has the full registry and the topological sort. Only `CRAWLERS_TO_TEST` needs to be passed in as input; the script derives `CRAWLERS_TO_RUN` itself. The failure gate becomes: `if ($failed -and $type -in $CrawlersToTest) { $totalFailed++ }`. Types in `CRAWLERS_TO_RUN` but not in `CRAWLERS_TO_TEST` run for setup and their exit code is ignored.

---

## Implementation plan

### Phase 1 — Commit-range skip + job-level path gates (~1 day)

Gets the most common pain points: housekeeping re-runs and the integration suite firing on UI-only changes.

#### 1a. Commit-range skip (both workflows)

Add a `changes` pre-job that detects whether the only new commits since the last CI run are bump-version housekeeping. The checkout uses `fetch-depth: 0` so the full history is available for the range query.

> **Why not `paths-ignore`?** After "Update branch", the PR diff includes all the branch's product files. `paths-ignore` can't exclude them — they're legitimately changed relative to the new base. We detect housekeeping at the commit-message level instead.

```yaml
# Detects whether this push added any non-housekeeping commits.
# Downstream jobs guard on: needs.changes.outputs.has_product_changes == 'true'
# Passing on a housekeeping-only push (result=false) is INTENTIONAL — it means
# "nothing meaningful changed since last CI run; skip everything".
changes:
  runs-on: ubuntu-latest
  outputs:
    has_product_changes: ${{ steps.check.outputs.result }}
  steps:
    - uses: actions/checkout@...
      with:
        fetch-depth: 0

    - id: check
      run: |
        # First push to a new branch: before is all-zeros. Always run CI.
        if [ "${{ github.event.before }}" = "0000000000000000000000000000000000000000" ]; then
          echo "result=true" >> "$GITHUB_OUTPUT"; exit 0
        fi

        # After a rebase or force-push, event.before is no longer in the
        # rewritten history. Treat this as a real change (safe default).
        if ! git merge-base --is-ancestor "${{ github.event.before }}" "${{ github.sha }}" 2>/dev/null; then
          echo "result=true" >> "$GITHUB_OUTPUT"; exit 0
        fi

        # Collect subjects of commits added by this push. Filter blank lines
        # so an empty range (no new commits) doesn't produce a false positive.
        NON_HOUSEKEEPING=$(
          git log "${{ github.event.before }}..${{ github.sha }}" --format="%s" \
            | grep -v '^$' \
            | grep -cvE "^chore: bump version|^Merge branch 'main'" \
            || echo 0
        )
        if [ "$NON_HOUSEKEEPING" -gt 0 ]; then
          echo "result=true" >> "$GITHUB_OUTPUT"
          echo "Found $NON_HOUSEKEEPING non-housekeeping commit(s)" >> "$GITHUB_STEP_SUMMARY"
        else
          echo "result=false" >> "$GITHUB_OUTPUT"
          echo "CI skipped — no product code changes detected in this push. If this is wrong, check the commit range or add the \`integration-test\` label." >> "$GITHUB_STEP_SUMMARY"
        fi
```

All downstream jobs add `needs: [changes]` and a top-level guard:

```yaml
if: needs.changes.outputs.has_product_changes == 'true'
```

Jobs that also have a path filter (see 1b) wrap both conditions:

```yaml
if: |
  needs.changes.outputs.has_product_changes == 'true' &&
  (needs.filter.outputs.ps == 'true' || needs.filter.outcome == 'failure')
```

> **paths-filter failure fallback:** The `|| needs.filter.outcome == 'failure'` clause is intentional. If `dorny/paths-filter` has an outage or errors, its outputs are empty strings — all `== 'true'` comparisons evaluate to false, silently skipping everything and producing a false green. The fallback runs all applicable jobs when the filter step itself fails, which is the safe direction.

#### 1b. Path-filter gates in `pr.yml`

Add a `filter` job using `dorny/paths-filter@v3`:

```yaml
filter:
  needs: [changes]
  if: needs.changes.outputs.has_product_changes == 'true'
  runs-on: ubuntu-latest
  outputs:
    ps:      ${{ steps.f.outputs.ps }}
    pester:  ${{ steps.f.outputs.pester }}
    api:     ${{ steps.f.outputs.api }}
    ui:      ${{ steps.f.outputs.ui }}
    openapi: ${{ steps.f.outputs.openapi }}
    outcome: ${{ steps.f.outcome }}
  steps:
    - uses: actions/checkout@...
    - uses: dorny/paths-filter@v3
      id: f
      with:
        filters: |
          ps:
            - 'tools/crawlers/**/*.ps1'
            - 'tools/powershell-sdk/**'
            - 'setup/**/*.ps1'
            - 'setup/IdentityAtlas.psm1'
          pester:
            - 'tools/powershell-sdk/**'
            - 'tools/crawlers/shared/**'
            - 'setup/docker/Invoke-CrawlerJob.ps1'
            - 'setup/IdentityAtlas.psm1'
            - 'test/unit/**'
          api:
            - 'app/api/src/**'
          ui:
            - 'app/ui/src/**'
            - 'tools/crawlers/**/*.jsx'
            - 'tools/crawlers/**/*.test.js'
            - 'tools/crawlers/**/*.test.jsx'
          openapi:
            - 'app/api/src/openapi.yaml'
```

Job conditions (the `|| needs.filter.outputs.outcome == 'failure'` fallback applies to all gated jobs):

| Job | Condition |
|---|---|
| `lint-ps` | `filter.outputs.ps == 'true'` |
| `lint-js` | `filter.outputs.ui == 'true'` |
| `unit-tests` (Pester) | `filter.outputs.pester == 'true'` |
| `unit-js` (API Vitest) | `filter.outputs.api == 'true'` |
| `unit-ui` (UI Vitest) | `filter.outputs.ui == 'true'` |
| `node-launcher-ui-build` | `filter.outputs.ui == 'true'` |
| `openapi` | `filter.outputs.openapi == 'true'` |
| `hygiene`, `crawler-manifest`, `docs-nav`, `audit` | always (fast hygiene checks — no path gate) |

#### 1c. Path-filter gates in `pr-integration.yml`

Add an equivalent `filter` job and gate each heavy job. Also add `setup/IdentityAtlas.psd1` to the existing `paths-ignore` block (it's a version-number-only file that never justifies a 50-minute run):

```yaml
filter:
  needs: [changes]
  if: needs.changes.outputs.has_product_changes == 'true'
  runs-on: ubuntu-latest
  outputs:
    integration: ${{ steps.f.outputs.integration }}
    e2e:         ${{ steps.f.outputs.e2e }}
    load_soak:   ${{ steps.f.outputs.load_soak }}
    outcome:     ${{ steps.f.outcome }}
  steps:
    - uses: actions/checkout@...
    - uses: dorny/paths-filter@v3
      id: f
      with:
        filters: |
          integration:
            - 'app/api/src/**'
            - 'tools/crawlers/**/*.ps1'
            - 'tools/crawlers/**/*.js'
            - 'tools/crawlers/shared/**'
            - 'tools/powershell-sdk/**'
            - 'setup/docker/Invoke-CrawlerJob.ps1'
            - 'setup/IdentityAtlas.psm1'
            - 'app/api/Dockerfile'
            - 'setup/docker/Dockerfile.powershell'
            - 'docker-compose*.yml'
          e2e:
            - 'app/ui/src/**'
            - 'tools/crawlers/**/*.jsx'
            - 'app/api/src/**'
            - 'app/api/Dockerfile'
          load_soak:
            - 'app/api/src/**'
            - 'tools/crawlers/shared/**'
            - 'tools/powershell-sdk/**'
            - 'tools/crawlers/*/Start-*.ps1'
            - 'setup/docker/Invoke-CrawlerJob.ps1'
            - 'setup/docker/Dockerfile.powershell'
            - 'docker-compose*.yml'
```

#### 1d. `ci-passed` gate job

Replace `pr-summary` with a `ci-passed` gate that covers all 11 jobs. The gate passes when every job either succeeded or was legitimately skipped — this is intentional for housekeeping pushes.

```yaml
ci-passed:
  needs:
    - changes
    - filter
    - lint-ps
    - lint-js
    - unit-tests
    - unit-js
    - unit-ui
    - node-launcher-ui-build
    - openapi
    - hygiene
    - crawler-manifest
    - docs-nav
    - audit
  if: always()
  runs-on: ubuntu-latest
  steps:
    - name: Check results
      run: |
        # A skipped job (has_product_changes=false) is intentionally allowed —
        # it means CI correctly identified a housekeeping-only push.
        FAILED=$(echo '${{ toJSON(needs) }}' \
          | jq -r 'to_entries | .[] | select(.value.result == "failure") | .key')
        if [ -n "$FAILED" ]; then
          echo "## CI Failed" >> "$GITHUB_STEP_SUMMARY"
          echo "The following jobs failed:" >> "$GITHUB_STEP_SUMMARY"
          echo "$FAILED" | while read -r job; do
            echo "- $job" >> "$GITHUB_STEP_SUMMARY"
          done
          exit 1
        fi
        echo "All checks passed or were legitimately skipped." >> "$GITHUB_STEP_SUMMARY"
```

**Branch protection migration sequence (do not skip this):**

1. Add `ci-passed` as a NEW required status check alongside the existing individual job requirements.
2. Merge this PR. Verify `ci-passed` appears and passes on 2–3 real PRs.
3. Remove the old individual job requirements, keeping only `ci-passed`.

Never remove the old requirements and add the new gate in the same step — there is a window where open PRs have neither set of checks and can merge unprotected.

---

### Phase 2 — Per-crawler scoping in integration tests (~1 day)

Reduces the integration job from "test all crawlers every time" to "test only the crawlers that matter."

#### 2a. Detect changed crawler types

Extend the `filter` job in `pr-integration.yml` with per-type filters. Use one filter key per crawler type — **do not use `tr '-' '_'` to auto-generate keys** as it produces wrong keys for multi-hyphen names like `custom-connector`. Map each type explicitly:

```yaml
# Per-crawler type filters — one key per type, named to match the type slug.
# Extend this list when a new crawler is added to tools/crawlers/.
crawler_csv:              ['tools/crawlers/csv/**']
crawler_entra_id:         ['tools/crawlers/entra-id/**']
crawler_omada:            ['tools/crawlers/omada/**']
crawler_midpoint:         ['tools/crawlers/midpoint/**']
crawler_demo:             ['tools/crawlers/demo/**']
crawler_custom_connector: ['tools/crawlers/custom-connector/**']
crawlers_all:
  - 'tools/crawlers/shared/**'
  - 'tools/powershell-sdk/**'
  - 'setup/docker/Invoke-CrawlerJob.ps1'
  - 'setup/IdentityAtlas.psm1'
  - 'setup/docker/Dockerfile.powershell'
```

A follow-on step builds `CRAWLERS_TO_TEST` using direct GHA expression outputs rather than a jq parse of the JSON blob (safer — no fragility around key name encoding):

```yaml
- id: scope
  run: |
    if [ "${{ steps.f.outputs.crawlers_all }}" = "true" ]; then
      echo "crawlers_to_test=csv,entra-id,omada,midpoint,demo,custom-connector" >> "$GITHUB_OUTPUT"
    else
      LIST=""
      [ "${{ steps.f.outputs.crawler_csv }}"              = "true" ] && LIST="${LIST:+$LIST,}csv"
      [ "${{ steps.f.outputs.crawler_entra_id }}"         = "true" ] && LIST="${LIST:+$LIST,}entra-id"
      [ "${{ steps.f.outputs.crawler_omada }}"            = "true" ] && LIST="${LIST:+$LIST,}omada"
      [ "${{ steps.f.outputs.crawler_midpoint }}"         = "true" ] && LIST="${LIST:+$LIST,}midpoint"
      [ "${{ steps.f.outputs.crawler_demo }}"             = "true" ] && LIST="${LIST:+$LIST,}demo"
      [ "${{ steps.f.outputs.crawler_custom_connector }}" = "true" ] && LIST="${LIST:+$LIST,}custom-connector"
      echo "crawlers_to_test=$LIST" >> "$GITHUB_OUTPUT"
    fi
    # Emit to step summary so CI logs show why certain crawlers were included.
    echo "CRAWLERS_TO_TEST: ${LIST:-all}" >> "$GITHUB_STEP_SUMMARY"
```

#### 2b. Modify the PS integration runner

Pass `$CrawlersToTest` as an env var. The script:

1. If `$CrawlersToTest` is empty → run and test everything (current behaviour, unchanged)
2. Otherwise:
   - Compute `$testSet` = the given types + their transitive dependents (traverse `dependsOn` upward through the registry)
   - Compute `$runSet` = `$testSet` + their transitive dependencies (traverse downward, for data setup)
   - Run all types in `$runSet` in topological order
   - Assert results only for types in `$testSet`; types in `$runSet \ $testSet` run for setup and their exit code is ignored

The registry already contains all `dependsOn` information. No external dep-graph logic needed — the PS script computes both sets itself from the registry.

#### 2c. `integration-test` label override

If the `integration-test` label is present on the PR, force `CRAWLERS_TO_TEST` to the full list regardless of paths. Useful for performance optimisations or infra changes that touch paths not covered by the filter.

---

### Phase 3 — Crawler tests as visible parallel pipeline jobs (~2 days)

Currently the crawler integration test is one opaque step in the GHA UI. All crawlers run inside a single PowerShell block using `Start-Job`. You see nothing until the entire block finishes, and a failure in one crawler produces a wall of interleaved output with no per-crawler pass/fail signal in the pipeline view.

The goal is for each crawler to appear as its own named job in the GHA pipeline — independently green or red, with its own live log and timing.

#### The core constraint: jobs can't share a running Docker stack

GHA jobs run on separate ephemeral runners. A Docker stack started in job A is not reachable from job B. This means each matrix job must build its own full stack — expensive (~15 min without cache, ~3–5 min with warm GHA layer cache).

The solution is a **setup job + DB seed artifact**:

```
integration-setup (one job)
  → Build web + worker images (GHA layer cache)
  → Start full stack
  → Run mock-server crawlers that have no live-credential dependency
    (odata via Start-MockODataServer.ps1; omada via Start-MockODataServer.ps1)
    NOTE: entra-id is EXCLUDED from the seed — it requires live Azure credentials
    and cannot be replicated for a generic shared seed. The entra-id matrix job
    builds its own state when Azure secrets are present; it skips otherwise.
  → pg_dump -Fc -f ci-db-seed.dump   (custom format — required for pg_restore --data-only)
  → upload as GHA artifact (name: ci-db-seed, retention-days: 1)
  → emit CRAWLERS_TO_TEST JSON array → GITHUB_OUTPUT (filtered by Phase 2 scope)

crawler-tests (matrix job, one entry per crawler in CRAWLERS_TO_TEST)
  → Build images from GHA layer cache (~3–5 min, warm)
  → Start fresh stack (postgres + API + worker)
    → API runs migrations on startup → empty schema created
  → wait for API ready
  → download ci-db-seed artifact
  → pg_restore --data-only -Fc ci-db-seed.dump
    (--data-only: schema already exists from migrations; don't recreate it)
  → run Test-${{ matrix.crawler }}.ps1 -ApiBaseUrl ... -ApiKey ...
  → pass/fail independently (fail-fast: false)
```

**Why `pg_dump -Fc` + `pg_restore --data-only`:**
- `-Fc` (custom format) is required for `pg_restore` to work; plain SQL dumps use `psql`, not `pg_restore`.
- `--data-only` skips schema DDL during restore — the API already ran migrations and created the schema on startup. Restoring the schema again would conflict.
- This is fast: CI datasets are small (hundreds of rows), dump/restore is <5 seconds.

#### Why not share the built image via registry?

Pushing a PR-specific image to GHCR on every CI run adds ~2 min, consumes registry storage, and requires image cleanup. GHA's layer cache achieves the same warm-rebuild goal without registry involvement — the `type=gha,scope=web` cache already configured in `pr-integration.yml` is the right mechanism.

#### Short-term improvement (before Phase 3): `::group::` log markers

While the matrix restructure is in progress, add GHA log group markers to the PS runner so each crawler's output is at least collapsible in the current single-step view:

```powershell
# Before running each crawler:
Write-Host "::group::Crawler: $type (depth $depth)"
Write-Host "::notice title=${type}::Starting at $(Get-Date -Format 'HH:mm:ss')"

# After Wait-Job, emit the captured log:
$output = Receive-Job -Job $job -Keep
$output | ForEach-Object { Write-Host $_ }

if ($failed) {
    Write-Host "::error title=${type}::Test failed — see log above"
} else {
    Write-Host "::notice title=${type}::Passed"
}
Write-Host "::endgroup::"
```

This requires switching from fire-and-forget `Start-Job` output to per-crawler captured output (redirect each job's stdout to a temp file, emit grouped after `Wait-Job`). The parallelism via `Start-Job` is preserved; the output is just buffered per crawler and emitted sequentially in labeled groups after all jobs at that depth level complete.

Result: collapsible per-crawler sections in the GHA log, `::error::` annotations surfaced in the PR summary, per-crawler pass/fail visible without scrolling through a wall of interleaved output. Takes ~2 hours; can ship independently of Phase 3.

#### Phase 3 YAML structure

```yaml
jobs:
  integration-setup:
    outputs:
      crawlers: ${{ steps.scope.outputs.crawlers_json }}   # JSON array for matrix
    steps:
      - build web + worker images (GHA cache)
      - start stack
      - run setup-only crawlers (odata, midpoint — mock-server crawlers only; NOT entra-id)
      - pg_dump -Fc -f ci-db-seed.dump
      - uses: actions/upload-artifact@...
        with:
          name: ci-db-seed
          path: ci-db-seed.dump
          retention-days: 1
      # Filter CRAWLERS_TO_TEST from Phase 2; emit as JSON array for matrix
      - id: scope
        run: |
          # CRAWLERS_TO_TEST passed in as env var from Phase 2 filter job
          # Convert comma-separated list to JSON array
          JSON=$(echo "$CRAWLERS_TO_TEST" | tr ',' '\n' | jq -R . | jq -sc .)
          echo "crawlers_json=$JSON" >> "$GITHUB_OUTPUT"
          echo "CRAWLERS_TO_TEST: $CRAWLERS_TO_TEST" >> "$GITHUB_STEP_SUMMARY"

  crawler-tests:
    needs: [integration-setup, changes, filter]
    if: needs.filter.outputs.integration == 'true' || needs.filter.outputs.outcome == 'failure'
    strategy:
      matrix:
        crawler: ${{ fromJson(needs.integration-setup.outputs.crawlers) }}
      fail-fast: false          # one crawler failing doesn't cancel others
    name: 'Crawler: ${{ matrix.crawler }}'
    steps:
      - build images from GHA cache
      - start stack (fresh postgres — migrations run on API startup)
      - wait for API ready
      - uses: actions/download-artifact@...
        with:
          name: ci-db-seed
      - run: pg_restore --data-only -Fc -d identity_atlas ci-db-seed.dump
      - run: pwsh -File tools/crawlers/${{ matrix.crawler }}/Test-*.ps1 -ApiBaseUrl ... -ApiKey ...

  # Gate job — required in branch protection instead of individual matrix job names.
  # Dynamic matrix entries can't be individually required in GHA branch protection;
  # this wrapper ensures the matrix passes/fails as a single named check.
  ci-integration-passed:
    needs: [integration-setup, crawler-tests, e2e, load-soak]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: |
          FAILED=$(echo '${{ toJSON(needs) }}' \
            | jq -r 'to_entries | .[] | select(.value.result == "failure") | .key')
          if [ -n "$FAILED" ]; then
            echo "## Integration CI Failed" >> "$GITHUB_STEP_SUMMARY"
            echo "$FAILED" | while read -r job; do echo "- $job" >> "$GITHUB_STEP_SUMMARY"; done
            exit 1
          fi
          echo "All integration checks passed or were skipped."
```

`fail-fast: false` is essential — one crawler failing should not cancel the remaining parallel jobs.

**Branch protection for Phase 3:** Update to require `ci-integration-passed` (from `pr-integration.yml`) instead of the individual `integration`, `e2e`, `load-soak` job names. Apply the same add-then-remove migration sequence as described in Phase 1d.

---

## Acceptance criteria

- [ ] "Update branch" that only imports a `chore: bump version` commit triggers no new CI run
- [ ] A PR touching only `app/ui/src/` skips PS lint, Pester, and the integration suite entirely
- [ ] A PR touching only `tools/crawlers/omada/` runs only omada's integration test (odata runs for setup, not assertion)
- [ ] A PR touching `tools/crawlers/shared/` runs all crawler integration tests
- [ ] A PR touching `tools/powershell-sdk/` runs Pester unit tests and all crawler integration tests
- [ ] A PR touching `app/api/src/db/migrations/` triggers the load soak automatically
- [ ] Branch protection resolves correctly (`ci-passed` succeeds) when CI jobs are legitimately skipped
- [ ] The `integration-test` label forces the full integration suite regardless of paths
- [ ] The `load-soak` label forces load soak regardless of paths
- [ ] Each crawler appears as its own named job in the GHA pipeline with independent pass/fail (Phase 3)
- [ ] A failing crawler does not cancel other crawler jobs (`fail-fast: false`) (Phase 3)
- [ ] Per-crawler log output is visible live (not buffered until the whole suite finishes) (Phase 3)
- [ ] Short-term: per-crawler `::group::` log sections visible in the current single-step view before Phase 3 lands
- [ ] Force-pushed or rebased branches run CI (commit-range skip does not false-negative on non-ancestor `before` SHA)
- [ ] CI produces informative step summary when jobs are skipped (housekeeping message) or fail (per-job failure list)

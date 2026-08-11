#!/usr/bin/env bash
# Simulates dorny/paths-filter and verifies the job conditions for each
# "what changed" scenario from docs/architecture/ci-scope-testing.md.
#
# Usage: bash test/ci-scripts/test-path-gates.sh [--against-branch main]
#
# Runs against synthetic file lists — no actual git diff needed.

set -euo pipefail

PASS=0
FAIL=0

# ── Harness ─────────────────────────────────────────────────────────────────

assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"
    echo "        expected: $expected"
    echo "        actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

# Simulates dorny/paths-filter for a given list of changed files.
# Outputs: ps, pester, api, ui, openapi, integration, e2e, load_soak
# Each is "true" or "false", matching the filter patterns in the workflows.
simulate_filter() {
  local files="$1"  # newline-separated list of changed file paths

  ps="false";     pester="false"; api="false";      ui="false"
  openapi="false"; integration="false"; e2e="false"; load_soak="false"

  # Note: every condition ends with || true so set -e doesn't kill the script
  # when the regex doesn't match (bash exits 1 on a failed [[...]] && chain).
  while IFS= read -r f; do
    [ -z "$f" ] && continue

    # ps scope
    { [[ "$f" =~ ^tools/crawlers/.*\.ps1$ ]]           && ps="true"; } || true
    { [[ "$f" =~ ^tools/powershell-sdk/ ]]              && ps="true"; } || true
    { [[ "$f" =~ ^setup/.*\.ps1$ ]]                     && ps="true"; } || true
    { [[ "$f" = "setup/IdentityAtlas.psm1" ]]           && ps="true"; } || true

    # pester scope
    { [[ "$f" =~ ^tools/powershell-sdk/ ]]              && pester="true"; } || true
    { [[ "$f" =~ ^tools/crawlers/shared/ ]]             && pester="true"; } || true
    { [[ "$f" = "setup/docker/Invoke-CrawlerJob.ps1" ]] && pester="true"; } || true
    { [[ "$f" = "setup/IdentityAtlas.psm1" ]]           && pester="true"; } || true
    { [[ "$f" =~ ^test/unit/ ]]                         && pester="true"; } || true

    # api scope — package.json declares ranges, package-lock.json is what gets installed (#997)
    { [[ "$f" =~ ^app/api/src/ ]]                       && api="true"; } || true
    { [[ "$f" = "app/api/package.json" ]]               && api="true"; } || true
    { [[ "$f" = "app/api/package-lock.json" ]]          && api="true"; } || true

    # ui scope
    { [[ "$f" =~ ^app/ui/src/ ]]                        && ui="true"; } || true
    { [[ "$f" = "app/ui/package.json" ]]                && ui="true"; } || true
    { [[ "$f" = "app/ui/package-lock.json" ]]           && ui="true"; } || true
    { [[ "$f" =~ ^tools/crawlers/.*\.jsx$ ]]            && ui="true"; } || true
    { [[ "$f" =~ ^tools/crawlers/.*\.test\.js$ ]]       && ui="true"; } || true
    { [[ "$f" =~ ^tools/crawlers/.*\.test\.jsx$ ]]      && ui="true"; } || true

    # openapi scope
    { [[ "$f" = "app/api/src/openapi.yaml" ]]           && openapi="true"; } || true

    # integration scope
    { [[ "$f" =~ ^app/api/src/ ]]                       && integration="true"; } || true
    { [[ "$f" = "app/api/package.json" ]]               && integration="true"; } || true
    { [[ "$f" = "app/api/package-lock.json" ]]          && integration="true"; } || true
    { [[ "$f" =~ ^tools/crawlers/.*\.ps1$ ]]            && integration="true"; } || true
    { [[ "$f" =~ ^tools/crawlers/.*\.js$ ]]             && integration="true"; } || true
    { [[ "$f" =~ ^tools/crawlers/shared/ ]]             && integration="true"; } || true
    { [[ "$f" =~ ^tools/powershell-sdk/ ]]              && integration="true"; } || true
    { [[ "$f" = "setup/docker/Invoke-CrawlerJob.ps1" ]] && integration="true"; } || true
    { [[ "$f" = "setup/IdentityAtlas.psm1" ]]           && integration="true"; } || true
    { [[ "$f" = "app/api/Dockerfile" ]]                 && integration="true"; } || true
    { [[ "$f" = "setup/docker/Dockerfile.powershell" ]] && integration="true"; } || true
    { [[ "$f" =~ ^docker-compose ]]                     && integration="true"; } || true

    # e2e scope — drives both halves, so both trees matter
    { [[ "$f" =~ ^app/ui/src/ ]]                        && e2e="true"; } || true
    { [[ "$f" = "app/ui/package.json" ]]                && e2e="true"; } || true
    { [[ "$f" = "app/ui/package-lock.json" ]]           && e2e="true"; } || true
    { [[ "$f" = "app/api/package.json" ]]               && e2e="true"; } || true
    { [[ "$f" = "app/api/package-lock.json" ]]          && e2e="true"; } || true
    { [[ "$f" =~ ^tools/crawlers/.*\.jsx$ ]]            && e2e="true"; } || true
    { [[ "$f" =~ ^app/api/src/ ]]                       && e2e="true"; } || true
    { [[ "$f" = "app/api/Dockerfile" ]]                 && e2e="true"; } || true

    # load_soak scope
    { [[ "$f" =~ ^app/api/src/ ]]                       && load_soak="true"; } || true
    { [[ "$f" =~ ^tools/crawlers/shared/ ]]             && load_soak="true"; } || true
    { [[ "$f" =~ ^tools/powershell-sdk/ ]]              && load_soak="true"; } || true
    { [[ "$f" =~ ^tools/crawlers/.*/Start-.*\.ps1$ ]]   && load_soak="true"; } || true
    { [[ "$f" = "setup/docker/Invoke-CrawlerJob.ps1" ]] && load_soak="true"; } || true
    { [[ "$f" = "setup/docker/Dockerfile.powershell" ]] && load_soak="true"; } || true
    { [[ "$f" =~ ^docker-compose ]]                     && load_soak="true"; } || true

  done <<< "$files"
}

# ── Scenario tests ───────────────────────────────────────────────────────────

echo ""
echo "=== Path-gate conditions (dorny/paths-filter simulation) ==="

# ── Scenario 1: UI-only change
echo ""
echo "── Scenario: app/ui/src/ only ──"
simulate_filter "app/ui/src/components/CrawlersPage.jsx
app/ui/src/hooks/useData.js"
assert "lint-js: runs"              "true"  "$ui"
assert "unit-ui: runs"              "true"  "$ui"
assert "node-launcher-ui-build: runs" "true" "$ui"
assert "e2e: runs"                  "true"  "$e2e"
assert "lint-ps: skips"             "false" "$ps"
assert "unit-tests (Pester): skips" "false" "$pester"
assert "unit-js (API): skips"       "false" "$api"
assert "integration: skips"         "false" "$integration"
assert "load-soak: skips"           "false" "$load_soak"

# ── Scenario 2: API source change
echo ""
echo "── Scenario: app/api/src/ (non-migration) ──"
simulate_filter "app/api/src/routes/jobs.js
app/api/src/crawlerManifests.js"
assert "unit-js: runs"              "true"  "$api"
assert "integration: runs"          "true"  "$integration"
assert "load-soak: runs"            "true"  "$load_soak"
assert "e2e: runs"                  "true"  "$e2e"
assert "lint-ps: skips"             "false" "$ps"
assert "unit-tests (Pester): skips" "false" "$pester"
assert "unit-ui: skips"             "false" "$ui"
assert "openapi: skips"             "false" "$openapi"

# ── Scenario 3: API migration
echo ""
echo "── Scenario: app/api/src/db/migrations/ ──"
simulate_filter "app/api/src/db/migrations/0042_add_context_type.js"
assert "unit-js: runs"              "true"  "$api"
assert "integration: runs"          "true"  "$integration"
assert "load-soak: runs (migrations trigger soak)" "true" "$load_soak"

# ── Scenario 4: OpenAPI spec only
echo ""
echo "── Scenario: openapi.yaml only ──"
simulate_filter "app/api/src/openapi.yaml"
assert "openapi: runs"              "true"  "$openapi"
assert "unit-js: runs (api scope also matches)" "true" "$api"
assert "integration: runs (api scope)"          "true" "$integration"
assert "lint-ps: skips"             "false" "$ps"
assert "unit-ui: skips"             "false" "$ui"

# ── Scenario 5: Single crawler PS change
echo ""
echo "── Scenario: tools/crawlers/omada/ PS file ──"
simulate_filter "tools/crawlers/omada/Start-OmadaCrawler.ps1"
assert "lint-ps: runs"              "true"  "$ps"
assert "integration: runs"          "true"  "$integration"
assert "load-soak: runs"            "true"  "$load_soak"
assert "unit-tests (Pester): skips (not shared/sdk)" "false" "$pester"
assert "unit-js: skips"             "false" "$api"
assert "unit-ui: skips"             "false" "$ui"
assert "e2e: skips"                 "false" "$e2e"

# ── Scenario 6: Crawler wizard (JSX) — UI vitest only, no integration
echo ""
echo "── Scenario: tools/crawlers/entra-id/ConfigWizard.jsx ──"
simulate_filter "tools/crawlers/entra-id/ConfigWizard.jsx"
assert "unit-ui: runs"              "true"  "$ui"
assert "lint-js: runs"              "true"  "$ui"
assert "e2e: runs (jsx triggers e2e)" "true" "$e2e"
assert "lint-ps: skips"             "false" "$ps"
assert "unit-tests (Pester): skips" "false" "$pester"
assert "integration: skips"         "false" "$integration"
assert "load-soak: skips"           "false" "$load_soak"

# ── Scenario 7: Shared crawler code — all crawlers must test
echo ""
echo "── Scenario: tools/crawlers/shared/ change ──"
simulate_filter "tools/crawlers/shared/Get-CapabilityId.ps1"
assert "lint-ps: runs"              "true"  "$ps"
assert "pester: runs"               "true"  "$pester"
assert "integration: runs"          "true"  "$integration"
assert "load-soak: runs"            "true"  "$load_soak"
assert "unit-js: skips"             "false" "$api"
assert "unit-ui: skips"             "false" "$ui"

# ── Scenario 8: PowerShell SDK change
echo ""
echo "── Scenario: tools/powershell-sdk/ change ──"
simulate_filter "tools/powershell-sdk/Functions/Invoke-GraphRequest.ps1"
assert "lint-ps: runs"              "true"  "$ps"
assert "pester: runs"               "true"  "$pester"
assert "integration: runs"          "true"  "$integration"
assert "load-soak: runs"            "true"  "$load_soak"
assert "unit-js: skips"             "false" "$api"
assert "e2e: skips"                 "false" "$e2e"

# ── Scenario 9: Dockerfile change
echo ""
echo "── Scenario: Dockerfile / docker-compose change ──"
simulate_filter "setup/docker/Dockerfile.powershell"
assert "integration: runs"          "true"  "$integration"
assert "load-soak: runs"            "true"  "$load_soak"
assert "lint-ps: skips"             "false" "$ps"
assert "unit-js: skips"             "false" "$api"
assert "e2e: skips"                 "false" "$e2e"

simulate_filter "docker-compose.ci.yml"
assert "integration: runs (compose)"  "true"  "$integration"
assert "load-soak: runs (compose)"    "true"  "$load_soak"
assert "e2e: skips for compose-only"  "false" "$e2e"  # compose doesn't trigger browser tests

# ── Scenario 10: Housekeeping only — nothing should run
echo ""
echo "── Scenario: housekeeping files only ──"
simulate_filter "CHANGES.md
changes/feature-my-thing.md
setup/IdentityAtlas.psd1"
assert "lint-ps: skips"             "false" "$ps"
assert "pester: skips"              "false" "$pester"
assert "unit-js: skips"             "false" "$api"
assert "unit-ui: skips"             "false" "$ui"
assert "openapi: skips"             "false" "$openapi"
assert "integration: skips"         "false" "$integration"
assert "e2e: skips"                 "false" "$e2e"
assert "load-soak: skips"           "false" "$load_soak"

# ── Scenario 11: Mixed — crawler PS + UI
echo ""
echo "── Scenario: crawler PS + UI (mixed PR) ──"
simulate_filter "tools/crawlers/midpoint/Start-MidpointCrawler.ps1
app/ui/src/components/CrawlersPage.jsx"
assert "lint-ps: runs"              "true"  "$ps"
assert "unit-ui: runs"              "true"  "$ui"
assert "integration: runs"          "true"  "$integration"
assert "e2e: runs"                  "true"  "$e2e"
assert "load-soak: runs"            "true"  "$load_soak"
assert "pester: skips (no shared/sdk)" "false" "$pester"

# ── Scenario: lockfile-only change — the shape of every npm Dependabot PR (#997)
# package.json declares RANGES; package-lock.json is what actually gets installed, and a
# transitive bump moves only the lockfile. No filter listed it, so the suites that run against
# the installed tree all skipped — #985 (nanoid 3.3.16 -> 3.3.18) merged with zero tests behind it.
echo ""
echo "── Scenario: lockfile-only change (Dependabot / npm audit fix)"
simulate_filter "app/api/package-lock.json
app/ui/package-lock.json
changes/npm-audit-nanoid.md"
assert "unit-js (API): runs"        "true"  "$api"
assert "unit-ui: runs"              "true"  "$ui"
assert "integration: runs"          "true"  "$integration"
assert "e2e: runs"                  "true"  "$e2e"
assert "lint-ps: skips"             "false" "$ps"
assert "unit-tests (Pester): skips" "false" "$pester"
# Deliberately NOT in scope: load/soak answers a performance question, not "does this tree still
# work", and it is the heaviest job in CI. The `load-soak` label opts a dependency bump in when the
# change warrants it.
assert "load-soak: skips"           "false" "$load_soak"

echo ""
echo "── Scenario: one side's lockfile must not wake the other side"
simulate_filter "app/api/package-lock.json"
assert "unit-js (API): runs"        "true"  "$api"
assert "unit-ui: skips"             "false" "$ui"
simulate_filter "app/ui/package-lock.json"
assert "unit-ui: runs"              "true"  "$ui"
assert "unit-js (API): skips"       "false" "$api"
assert "integration: skips"         "false" "$integration"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ "$FAIL" -eq 0 ]

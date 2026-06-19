#!/usr/bin/env bash
# Unit tests for the CRAWLERS_TO_TEST scope logic in pr-integration.yml.
# Tests both the dynamic scope detection (from git diff) and the PS runner's
# testSet/runSet dependency graph expansion.
#
# Dependency graph (from tools/crawlers/*/crawler.json):
#   csv, entra-id, odata, midpoint, demo, custom-connector — no dependsOn
#   omada — dependsOn: odata
#
# Usage: bash test/ci-scripts/test-crawler-scope.sh

set -euo pipefail

PASS=0
FAIL=0

assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"
    echo "        expected: '$expected'"
    echo "        actual:   '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

# ── Part 1: Dynamic crawler type detection from git diff ─────────────────────
# Mirrors the 'scope' step in the filter job.

# Returns CRAWLERS_TO_TEST given a simulated list of changed file paths.
detect_scope() {
  local changed="$1"

  # Shared infra → full run
  if echo "$changed" | grep -qE \
    "^tools/crawlers/shared/|^tools/powershell-sdk/|\
^setup/docker/Invoke-CrawlerJob\.ps1|^setup/IdentityAtlas\.psm1|\
^setup/docker/Dockerfile\.powershell"; then
    echo ""
    return
  fi

  local list
  list=$(echo "$changed" \
    | grep -oE "^tools/crawlers/[^/]+" \
    | sed 's|tools/crawlers/||' \
    | grep -v '^shared$' \
    | sort -u \
    | tr '\n' ',' \
    | sed 's/,$//')

  echo "$list"
}

echo ""
echo "=== Part 1: Dynamic scope detection from git diff ==="

echo ""
echo "── Single crawler changed ──"
assert "omada PS file: detects omada" \
  "omada" \
  "$(detect_scope "tools/crawlers/omada/Start-OmadaCrawler.ps1")"

assert "entra-id wizard: detects entra-id" \
  "entra-id" \
  "$(detect_scope "tools/crawlers/entra-id/ConfigWizard.jsx
tools/crawlers/entra-id/CrawlerMeta.js")"

assert "custom-connector: detects custom-connector (hyphen in name)" \
  "custom-connector" \
  "$(detect_scope "tools/crawlers/custom-connector/Start-CustomConnector.ps1")"

echo ""
echo "── Multiple crawlers changed ──"
assert "csv + omada: detects both" \
  "csv,omada" \
  "$(detect_scope "tools/crawlers/csv/Start-CSVCrawler.ps1
tools/crawlers/omada/Start-OmadaCrawler.ps1")"

assert "entra-id + midpoint: detects both in alphabetical order" \
  "entra-id,midpoint" \
  "$(detect_scope "tools/crawlers/midpoint/Start-MidpointCrawler.ps1
tools/crawlers/entra-id/Test-EntraIdCrawler.ps1")"

echo ""
echo "── Shared/infra changes → full run (empty) ──"
assert "tools/crawlers/shared/ → full run" \
  "" \
  "$(detect_scope "tools/crawlers/shared/Get-CapabilityId.ps1")"

assert "tools/powershell-sdk/ → full run" \
  "" \
  "$(detect_scope "tools/powershell-sdk/Functions/Invoke-GraphRequest.ps1")"

assert "Invoke-CrawlerJob.ps1 → full run" \
  "" \
  "$(detect_scope "setup/docker/Invoke-CrawlerJob.ps1")"

assert "IdentityAtlas.psm1 → full run" \
  "" \
  "$(detect_scope "setup/IdentityAtlas.psm1")"

assert "Dockerfile.powershell → full run" \
  "" \
  "$(detect_scope "setup/docker/Dockerfile.powershell")"

echo ""
echo "── Non-crawler paths → empty (full run) ──"
assert "app/api/src/ → empty (PS runner tests all)" \
  "" \
  "$(detect_scope "app/api/src/routes/jobs.js")"

assert "docker-compose.yml → empty" \
  "" \
  "$(detect_scope "docker-compose.ci.yml")"

echo ""
echo "── New crawler type (future-proofing) ──"
assert "tools/crawlers/newtype/ → detects newtype automatically" \
  "newtype" \
  "$(detect_scope "tools/crawlers/newtype/Start-NewtypeCrawler.ps1")"

assert "tools/crawlers/my-org-connector/ → detects hyphenated name" \
  "my-org-connector" \
  "$(detect_scope "tools/crawlers/my-org-connector/Start-MyOrgConnector.ps1")"

# ── Part 2: testSet/runSet expansion (mirrors PS runner logic) ───────────────

deps_of()       { case "$1" in omada) echo "odata" ;; *) echo "" ;; esac; }
dependents_of() { case "$1" in odata) echo "omada" ;; *) echo "" ;; esac; }

expand_test_set() {
  local result=" $1 "
  local queue="$1"
  while [ -n "$queue" ]; do
    local next_queue=""
    for t in $queue; do
      for dep in $(dependents_of "$t"); do
        if [[ "$result" != *" $dep "* ]]; then
          result="$result$dep "
          next_queue="$next_queue $dep"
        fi
      done
    done
    queue="${next_queue## }"
  done
  echo "${result## }"
}

expand_run_set() {
  local result=" $1 "
  for t in $1; do
    local queue="$t"
    while [ -n "$queue" ]; do
      local next_queue=""
      for cur in $queue; do
        for dep in $(deps_of "$cur"); do
          if [[ "$result" != *" $dep "* ]]; then
            result="$result$dep "
            next_queue="$next_queue $dep"
          fi
        done
      done
      queue="${next_queue## }"
    done
  done
  echo "${result## }"
}

sort_set() { echo "$1" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//'; }

echo ""
echo "=== Part 2: testSet/runSet dependency expansion ==="

echo ""
echo "── omada changed: only omada asserted, odata runs for setup ──"
TEST=$(sort_set "$(expand_test_set "omada")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "testSet = {omada}"         "omada"       "$TEST"
assert "runSet  = {odata, omada}"  "odata omada" "$RUN"

echo ""
echo "── odata changed: omada must also be asserted (depends on odata) ──"
TEST=$(sort_set "$(expand_test_set "odata")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "testSet = {odata, omada}"  "odata omada" "$TEST"
assert "runSet  = {odata, omada}"  "odata omada" "$RUN"

echo ""
echo "── csv changed: no deps, no dependents ──"
TEST=$(sort_set "$(expand_test_set "csv")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "testSet = {csv}"  "csv" "$TEST"
assert "runSet  = {csv}"  "csv" "$RUN"

echo ""
echo "── csv + omada both changed ──"
TEST=$(sort_set "$(expand_test_set "csv omada")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "testSet = {csv, omada}"         "csv omada"       "$TEST"
assert "runSet  = {csv, odata, omada}"  "csv odata omada" "$RUN"

echo ""
echo "── odata + omada both changed (no duplication) ──"
TEST=$(sort_set "$(expand_test_set "odata omada")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "testSet = {odata, omada}"  "odata omada" "$TEST"
assert "runSet  = {odata, omada}"  "odata omada" "$RUN"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
# Unit tests for the CRAWLERS_TO_TEST scope resolution logic.
# Simulates the testSet/runSet computation from the PS runner without needing PowerShell.
#
# Dependency graph (from tools/crawlers/*/crawler.json):
#   csv             (no deps, nothing depends on it)
#   entra-id        (no deps, nothing depends on it)
#   odata           (no deps; omada depends on odata)
#   omada           (dependsOn: odata)
#   midpoint        (no deps, nothing depends on it)
#   demo            (no deps, nothing depends on it)
#   custom-connector(no deps, nothing depends on it)
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

# ── Simulated registry (matches crawler.json dependsOn fields) ───────────────
# deps_of <type> → space-separated list of direct dependencies
deps_of() {
  case "$1" in
    omada) echo "odata" ;;
    *)     echo "" ;;
  esac
}

# dependents_of <type> → space-separated list of types that directly depend on $1
dependents_of() {
  case "$1" in
    odata) echo "omada" ;;
    *)     echo "" ;;
  esac
}

ALL_TYPES="csv entra-id odata omada midpoint demo custom-connector"

# ── Scope resolution (mirrors the PS runner logic) ───────────────────────────

# Expand testSet upward: add transitive dependents of each changed type.
expand_test_set() {
  local initial="$1"
  local result=" $initial "
  local queue="$initial"
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

# Build runSet: testSet + transitive dependencies (for data setup).
expand_run_set() {
  local test_set="$1"
  local result=" $test_set "
  for t in $test_set; do
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

# Canonicalise: sort space-separated list for stable comparison, strip whitespace
sort_set() { echo "$1" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' ' | sed 's/ $//'; }

# ── Tests ────────────────────────────────────────────────────────────────────

echo ""
echo "=== Crawler scope resolution (testSet / runSet) ==="

echo ""
echo "── Single crawler changed, no dependents ──"

TEST=$(sort_set "$(expand_test_set "csv")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "csv changed: testSet = {csv}"            "csv"       "$TEST"
assert "csv changed: runSet = {csv}"             "csv"       "$RUN"

TEST=$(sort_set "$(expand_test_set "entra-id")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "entra-id changed: testSet = {entra-id}"  "entra-id"  "$TEST"
assert "entra-id changed: runSet = {entra-id}"   "entra-id"  "$RUN"

echo ""
echo "── omada changed: only omada, but odata runs for setup ──"

TEST=$(sort_set "$(expand_test_set "omada")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "omada changed: testSet = {omada}"        "omada"      "$TEST"
assert "omada changed: runSet = {odata omada}"   "odata omada" "$RUN"

echo ""
echo "── odata changed: odata AND omada must be tested (omada depends on odata) ──"

TEST=$(sort_set "$(expand_test_set "odata")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "odata changed: testSet = {odata omada}"  "odata omada" "$TEST"
assert "odata changed: runSet = {odata omada}"   "odata omada" "$RUN"

echo ""
echo "── Multiple crawlers changed ──"

TEST=$(sort_set "$(expand_test_set "csv omada")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "csv+omada: testSet = {csv omada}"        "csv omada"       "$TEST"
assert "csv+omada: runSet = {csv odata omada}"   "csv odata omada" "$RUN"

TEST=$(sort_set "$(expand_test_set "csv entra-id")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "csv+entra-id: testSet = {csv entra-id}"  "csv entra-id"    "$TEST"
assert "csv+entra-id: runSet = {csv entra-id}"   "csv entra-id"    "$RUN"

echo ""
echo "── Edge cases ──"

TEST=$(sort_set "$(expand_test_set "odata omada")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "odata+omada both changed: testSet = {odata omada}" "odata omada" "$TEST"
assert "odata+omada both changed: runSet = {odata omada}"  "odata omada" "$RUN"

TEST=$(sort_set "$(expand_test_set "midpoint")")
RUN=$(sort_set "$(expand_run_set "$TEST")")
assert "midpoint: no deps, no dependents"         "midpoint"   "$TEST"
assert "midpoint runSet = testSet"                "midpoint"   "$RUN"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
# Unit tests for .github/scripts/assert_test_secrets.sh, the test-secret gate in
# pr-integration.yml.
#
# The regression this guards: the exemption for "a run that cannot receive
# secrets" was a list of who those runs are (forks, then dependabot[bot] after
# #1532 failed). Every new kind of secret-less run would have failed every PR of
# its kind once ENFORCE_TEST_SECRETS=true. The gate now asks one canary instead,
# and these cases pin both halves: no canary never fails, a canary with a
# missing secret does.
#
# Usage: bash test/ci-scripts/test-assert-test-secrets.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/assert_test_secrets.sh"

PASS=0
FAIL=0
assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"; echo "        expected: $expected"; echo "        actual:   $actual"; FAIL=$((FAIL + 1))
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ALL=(TEST_GRAPH_TENANT_ID=t TEST_GRAPH_CLIENT_ID=c TEST_GRAPH_CLIENT_SECRET=s TEST_LLM_API_KEY=k)

# run <env assignments...>: runs the gate in a clean environment and sets
# CODE (exit status), OUT (stdout) and SUM (the step summary).
run() {
  : > "$TMP/summary"
  set +e
  OUT="$(env -i PATH="$PATH" GITHUB_STEP_SUMMARY="$TMP/summary" "$@" bash "$SCRIPT")"
  CODE=$?
  set -e
  SUM="$(cat "$TMP/summary")"
}
has() { case "$2" in *"$1"*) echo yes ;; *) echo no ;; esac; }

echo "no secrets reached the run (fork / Dependabot)"
run ENFORCE=true
assert "enforced but secret-less: does not fail" 0 "$CODE"
assert "says enforcement is skipped" yes "$(has 'received no repository secrets' "$SUM")"
assert "does not warn about each secret" no "$(has '::warning' "$OUT")"
run SECRETS_REACHED=false ENFORCE=true "${ALL[@]}"
assert "canary 'false' is secret-less even if TEST_* leak through" 0 "$CODE"
assert "...and is reported as secret-less" yes "$(has 'received no repository secrets' "$SUM")"
run SECRETS_REACHED=TRUE ENFORCE=true
assert "canary must be exactly 'true'" 0 "$CODE"

echo "secrets reached the run"
run SECRETS_REACHED=true ENFORCE=true "${ALL[@]}"
assert "all present, enforced: passes" 0 "$CODE"
assert "says the suites will run" yes "$(has 'All required test secrets are present' "$SUM")"

run SECRETS_REACHED=true ENFORCE=true TEST_GRAPH_TENANT_ID=t TEST_GRAPH_CLIENT_ID=c TEST_GRAPH_CLIENT_SECRET=s
assert "one missing, enforced: fails" 1 "$CODE"
assert "names the missing secret in a warning" yes "$(has '::warning title=Missing test secret::TEST_LLM_API_KEY' "$OUT")"
assert "does not warn about a present one" no "$(has '::warning title=Missing test secret::TEST_GRAPH_TENANT_ID' "$OUT")"
assert "lists it in the summary" yes "$(has '`TEST_LLM_API_KEY`' "$SUM")"
assert "emits the enforcement error" yes "$(has '::error::ENFORCE_TEST_SECRETS=true and 1 required' "$OUT")"

run SECRETS_REACHED=true ENFORCE=true TEST_GRAPH_TENANT_ID= TEST_GRAPH_CLIENT_ID=c TEST_GRAPH_CLIENT_SECRET=s TEST_LLM_API_KEY=k
assert "an EMPTY secret counts as missing" 1 "$CODE"

run SECRETS_REACHED=true
assert "all missing, not enforced: reports only" 0 "$CODE"
assert "counts all four as missing" 4 "$(grep -c '::warning' <<<"$OUT")"
assert "tells how to enforce" yes "$(has 'ENFORCE_TEST_SECRETS=true' "$SUM")"
run SECRETS_REACHED=true ENFORCE=yes
assert "ENFORCE must be exactly 'true'" 0 "$CODE"

echo
echo "assert-test-secrets: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

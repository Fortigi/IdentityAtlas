#!/usr/bin/env bash
# Unit tests for the commit-range skip logic in .github/workflows/pr.yml and pr-integration.yml.
# Runs entirely locally — no GitHub Actions needed.
#
# Usage: bash test/ci-scripts/test-commit-range.sh

set -euo pipefail

PASS=0
FAIL=0

# ── Test harness ────────────────────────────────────────────────────────────

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

# Run the commit-range check logic against a mocked git log output.
# $1 = simulated git log --format="%s" output (empty string = no commits)
# $2 = before SHA (use "0000000000000000000000000000000000000000" for first push)
# $3 = "ancestor" | "non-ancestor" (simulates merge-base result)
run_check() {
  local mock_log="$1"
  local before="${2:-"abcdef1234567890abcdef1234567890abcdef12"}"
  local merge_base_result="${3:-ancestor}"  # "ancestor" = normal, "non-ancestor" = rebase

  # Inline the exact logic from the workflow, replacing git calls with mocks.
  (
    BEFORE="$before"
    SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    MOCK_LOG="$mock_log"
    MERGE_BASE_RESULT="$merge_base_result"

    RESULT=""

    # Condition 1: first push (before = all-zeros)
    if [ "$BEFORE" = "0000000000000000000000000000000000000000" ]; then
      RESULT="true"
    # Condition 2: rebase / force-push (before not an ancestor)
    elif [ "$MERGE_BASE_RESULT" = "non-ancestor" ]; then
      RESULT="true"
    else
      # Count non-housekeeping, non-blank commit subjects.
      # wc -l (not grep -cvE) because grep -cvE exits 1 on empty input,
      # causing || echo 0 to fire and produce "0\n0" — integer comparison fails.
      NON_HOUSEKEEPING=$(
        echo "$MOCK_LOG" \
          | grep -v '^$' \
          | grep -vE "^chore: bump version to [0-9]|^Merge branch 'main' into " \
          | wc -l \
          | tr -d ' '
      )
      if [ "$NON_HOUSEKEEPING" -gt 0 ]; then
        RESULT="true"
      else
        RESULT="false"
      fi
    fi

    echo "$RESULT"
  )
}

# ── Tests ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Commit-range skip logic ==="
echo ""

echo "── First push (before = all-zeros) ──"
assert "first push: always runs CI" \
  "true" \
  "$(run_check "" "0000000000000000000000000000000000000000")"

assert "first push with real commit: always runs CI" \
  "true" \
  "$(run_check "feat: add new feature" "0000000000000000000000000000000000000000")"

echo ""
echo "── Housekeeping-only pushes (should SKIP CI) ──"

assert "single bump-version commit: skips" \
  "false" \
  "$(run_check "chore: bump version to 5.213.20260619.0904")"

assert "single merge-main commit: skips" \
  "false" \
  "$(run_check "Merge branch 'main' into feature/my-feature")"

assert "bump + merge (Update branch scenario): skips" \
  "false" \
  "$(run_check "chore: bump version to 5.213.20260619.0904
Merge branch 'main' into feature/my-feature")"

assert "empty commit range (no new commits): skips" \
  "false" \
  "$(run_check "")"

echo ""
echo "── Real product changes (should RUN CI) ──"

assert "single feature commit: runs" \
  "true" \
  "$(run_check "feat: add omada crawler self-contained config")"

assert "bug fix commit: runs" \
  "true" \
  "$(run_check "fix(ui): resolve react-hooks warnings in CrawlersPage")"

assert "real commit mixed with housekeeping: runs" \
  "true" \
  "$(run_check "chore: bump version to 5.213.20260619.0904
feat: add new feature
Merge branch 'main'")"

assert "multiple real commits: runs" \
  "true" \
  "$(run_check "feat: step 1
feat: step 2
feat: step 3")"

echo ""
echo "── Edge cases ──"

assert "commit subject with only whitespace (tab): runs — tab is not blank, treated as unknown commit" \
  "true" \
  "$(run_check "
	")"

assert "commit that starts with 'chore:' but is NOT bump-version: runs" \
  "true" \
  "$(run_check "chore: update dev dependencies")"

assert "commit mentioning bump version mid-message: runs" \
  "true" \
  "$(run_check "fix: correct chore: bump version detection edge case")"

assert "Merge branch other than main: runs" \
  "true" \
  "$(run_check "Merge branch 'feature/other' into feature/my-feature")"

assert "bypass attempt — bump version prefix with extra text: runs (not exact match)" \
  "true" \
  "$(run_check "chore: bump version — also deletes auth middleware")"

assert "bypass attempt — bump version without 'to N': runs (not exact match)" \
  "true" \
  "$(run_check "chore: bump version")"

assert "bypass attempt — Merge branch main without 'into': runs (not exact match)" \
  "true" \
  "$(run_check "Merge branch 'main'")"

echo ""
echo "── Rebase / force-push ──"

assert "non-ancestor before (rebase): always runs CI" \
  "true" \
  "$(run_check "" "abcdef1234567890abcdef1234567890abcdef12" "non-ancestor")"

assert "non-ancestor before with housekeeping log: still runs CI" \
  "true" \
  "$(run_check "chore: bump version" "abcdef1234567890abcdef1234567890abcdef12" "non-ancestor")"

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════"
echo ""

[ "$FAIL" -eq 0 ]


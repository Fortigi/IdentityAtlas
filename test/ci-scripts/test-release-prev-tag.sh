#!/usr/bin/env bash
# Unit tests for .github/scripts/release_prev_tag.sh — the baseline a release's
# notes are computed against.
#
# The regression this guards: cut-release.yml took the GLOBALLY latest stable
# tag as the baseline. That is right only while releases move forward from main
# alone. The moment a maintained release line exists — the whole point of
# backporting library updates to the latest stable — cutting 5.10.1 from
# release/5.10 after main had tagged v5.11.0 would diff the patch against
# v5.11.0 and describe it as REMOVING every dependency 5.11 added.
#
# cut-hotfix.yml had the mirror bug: scoping to the v5.10.* series finds nothing
# when the tag is the first of its series, and an empty baseline silently drops
# both the changelog slice and the Full Changelog link.
#
# Each case builds a throwaway repo with a tag history and asks for the
# baseline. No network, no fixtures.
#
# Usage: bash test/ci-scripts/test-release-prev-tag.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/release_prev_tag.sh"

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

# Build a repo whose tags are exactly the arguments, then ask for the baseline
# of the tag named in $1.
baseline_for() {
  local want="$1"; shift
  rm -rf "$TMP/repo"
  mkdir -p "$TMP/repo"
  (
    cd "$TMP/repo"
    git init -q
    git config user.email t@example.invalid
    git config user.name t
    git commit -q --allow-empty -m init
    for t in "$@"; do git tag "$t"; done
    bash "$SCRIPT" "$want"
  )
}

echo "── Maintained release line (the reason this script exists) ──"

# Cutting a patch on 5.10 while main has already shipped 5.11 and 5.12.
assert "5.10.1 follows v5.10.0 even though v5.12.0 is the newest tag" \
  "v5.10.0" "$(baseline_for v5.10.1 v5.9.1 v5.10.0 v5.11.0 v5.12.0)"

# Second patch on the same line — follows the first patch, not the .0.
assert "5.10.2 follows v5.10.1, not v5.10.0" \
  "v5.10.1" "$(baseline_for v5.10.2 v5.10.0 v5.10.1 v5.11.0)"

echo
echo "── New minor from main ──"

# First tag of its series: the series-scoped search would find nothing here.
assert "5.10.0 falls back to the previous series' latest patch" \
  "v5.9.1" "$(baseline_for v5.10.0 v5.9.0 v5.9.1)"

assert "5.11.0 follows v5.10.1 when that is the highest below it" \
  "v5.10.1" "$(baseline_for v5.11.0 v5.9.1 v5.10.0 v5.10.1)"

echo
echo "── Version ordering ──"

# Lexical sort puts v5.9.1 above v5.10.0; version sort must not.
assert "double-digit minors sort above single-digit ones" \
  "v5.9.1" "$(baseline_for v5.10.0 v5.8.0 v5.9.1)"

assert "a double-digit patch sorts above single-digit patches" \
  "v5.9.10" "$(baseline_for v5.9.11 v5.9.9 v5.9.10)"

echo
echo "── Pre-releases are never a baseline ──"

# A beta precedes the stable it becomes, so diffing against it reports a subset.
assert "betas of the release being cut are ignored" \
  "v5.9.1" "$(baseline_for v5.10.0 v5.9.1 v5.10.0-beta.1 v5.10.0-beta.2)"

assert "rc and alpha tags are ignored too" \
  "v5.9.1" "$(baseline_for v5.10.0 v5.9.1 v5.10.0-rc.1 v5.10.0-alpha.1)"

echo
echo "── Nothing to diff against ──"

assert "the first release ever has no baseline" \
  "" "$(baseline_for v5.0.0)"

assert "a tag below every existing one has no baseline" \
  "" "$(baseline_for v4.0.0 v5.9.1 v5.10.0)"

assert "a repo holding only pre-releases has no baseline" \
  "" "$(baseline_for v5.10.0 v5.10.0-beta.1)"

echo
echo "── Already-created tag (how the workflows actually call it) ──"

# The workflows tag before generating notes, so the tag exists when we look.
assert "the tag being cut is not its own baseline" \
  "v5.9.1" "$(baseline_for v5.10.0 v5.9.1 v5.10.0)"

echo
echo "── Argument handling ──"

rc=0; out="$(bash "$SCRIPT" 2>&1)" || rc=$?
assert "no argument exits 2" 2 "$rc"
assert "…and says how to call it" "true" \
  "$(echo "$out" | grep -q usage && echo true || echo false)"

echo
echo "── Wiring ──"

for wf in cut-release.yml cut-hotfix.yml; do
  assert "$wf calls the shared script" "true" \
    "$(grep -q 'release_prev_tag.sh' "$REPO_ROOT/.github/workflows/$wf" && echo true || echo false)"
  assert "$wf no longer computes the baseline inline" "false" \
    "$(grep -q "git tag --list 'v\*' --sort=-version:refname" "$REPO_ROOT/.github/workflows/$wf" && echo true || echo false)"
done

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
# Unit tests for .github/scripts/dor_drop_workflow_labels.sh — the in-flight label cleanup that runs
# when a dor/issue-N PR is merged or closed.
#
# The regression: the cleanup was ONE `gh issue edit --remove-label "a,b,c,…"`. gh rejects the whole
# call when any name in it is not a label in the repo, and `dor-retry` was in the list before the repo
# had one — so from 2026-09-12 every merged issue kept all of its labels, silently. #1212 still said
# `state:awaiting-approval` after it shipped; #1125, #1166, #872 and #370 still said `build-done`.
#
# `gh` is a stub on PATH that behaves the way GitHub did: a removal naming a label the repo does not
# have fails outright and changes nothing. No network, no tokens.
#
# Usage: bash test/ci-scripts/test-dor-drop-workflow-labels.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/dor_drop_workflow_labels.sh"

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
mkdir -p "$TMP/bin"
export STUB="$TMP" REPO=Fortigi/IdentityAtlas PATH="$TMP/bin:$PATH"

# The repo's labels, as on 2026-09-15: everything the cleanup names EXCEPT dor-retry.
printf '%s\n' build-done needs-triage ready-to-build dor-stuck dor-paused bug enhancement sk:sk5 \
  state:awaiting-approval state:awaiting-requestor state:awaiting-design state:ready-to-probe \
  state:decompose state:blocked-external > "$TMP/repo-labels"

cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
# gh issue view <n> … → the issue's labels, one per line (what `--jq '.labels[].name'` prints)
# gh issue edit <n> … --remove-label <names> → all-or-nothing, like GitHub
[ "$1 $2" = "issue view" ] && { [ -f "$STUB/issue-$3" ] || exit 1; cat "$STUB/issue-$3"; exit 0; }
if [ "$1 $2" = "issue edit" ]; then
  n="$3"; shift 3
  while [ $# -gt 0 ]; do [ "$1" = --remove-label ] && names="$2"; shift; done
  echo "remove $names" >> "$STUB/calls"
  IFS=, read -ra list <<< "$names"
  for l in "${list[@]}"; do
    grep -qxF "$l" "$STUB/repo-labels" || { echo "'$l' not found" >&2; exit 1; }
    [ "$l" = "${FAIL_ON:-}" ] && exit 1
  done
  for l in "${list[@]}"; do grep -vxF "$l" "$STUB/issue-$n" > "$STUB/tmp" || true; mv "$STUB/tmp" "$STUB/issue-$n"; done
  exit 0
fi
exit 1
STUB
chmod +x "$TMP/bin/gh"

issue() { local n="$1"; shift; printf '%s\n' "$@" > "$TMP/issue-$n"; : > "$TMP/calls"; }
labels() { sort "$TMP/issue-$1" | paste -sd' ' -; }

echo "DoR terminal cleanup — every in-flight label goes, whatever else is in the list"
echo

# ── 1. The #1212 shape ──────────────────────────────────────────────────────
issue 1212 bug state:awaiting-approval
out="$(bash "$SCRIPT" 1212)"
assert "a shipped issue loses its state label even though dor-retry does not exist in the repo" \
  "bug" "$(labels 1212)"

# ── 2. Everything in flight, nothing else touched ───────────────────────────
issue 1166 enhancement sk:sk5 build-done needs-triage ready-to-build dor-stuck dor-paused state:decompose
bash "$SCRIPT" 1166 >/dev/null
assert "every in-flight label is removed" "enhancement sk:sk5" "$(labels 1166)"
assert "…one label per call, never a comma list gh can reject as a whole" "false" \
  "$(grep -q ',' "$TMP/calls" && echo true || echo false)"

# ── 3. Only what the issue carries ──────────────────────────────────────────
issue 1125 bug
bash "$SCRIPT" 1125 >/dev/null
assert "an issue with no in-flight labels gets no edits at all" "" "$(cat "$TMP/calls")"

# dor-retry once it exists and the issue carries it: removed like the rest.
echo dor-retry >> "$TMP/repo-labels"
issue 370 bug dor-retry build-done
bash "$SCRIPT" 370 >/dev/null
assert "dor-retry is removed once an issue actually carries it" "bug" "$(labels 370)"

# ── 4. One refusal does not stop the others ─────────────────────────────────
issue 872 needs-triage build-done state:awaiting-design
out="$(FAIL_ON=needs-triage bash "$SCRIPT" 872)"; rc=$?
assert "a label GitHub refuses stays, and the rest still go" "needs-triage" "$(labels 872)"
assert "…and the refusal is reported, not swallowed" "true" \
  "$(printf '%s' "$out" | grep -q '::warning::could not remove needs-triage from #872' && echo true || echo false)"
assert "…without failing the finalize step" 0 "$rc"

# ── 5. Unreadable issue ─────────────────────────────────────────────────────
out="$(bash "$SCRIPT" 9999)"; rc=$?
assert "an issue that cannot be read is reported" "true" \
  "$(printf '%s' "$out" | grep -q '::warning::could not read #9999' && echo true || echo false)"
assert "…and does not fail the step" 0 "$rc"

# ── 6. Wiring ───────────────────────────────────────────────────────────────
RESET="$REPO_ROOT/.github/workflows/dor-reset.yml"
assert "dor-reset runs the cleanup on both merge and close-unmerged" 2 \
  "$(grep -c 'bash .github/scripts/dor_drop_workflow_labels.sh "\$issue"' "$RESET")"
assert "…and no longer carries its own comma-joined removal list" "false" \
  "$(grep -q 'remove-label *\\\?$\|"build-done,' "$RESET" && echo true || echo false)"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

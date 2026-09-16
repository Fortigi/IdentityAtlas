#!/usr/bin/env bash
# Unit tests for .github/scripts/dor_finalize_merged_pr.sh — moving the issues a merged PR closes to
# Done on the DoR board, whatever branch the PR came from.
#
# #1046, #1047 and #1162 were fixed by hand-made `bugfixes/*` PRs. Their issues closed, but dor-reset
# only finalizes `dor/issue-N` heads, so their cards stayed at "Awaiting merge" until a human noticed.
#
# Like test-dor-reconcile-liveness.sh, the stub serves the JSON GitHub would return and runs the
# script's OWN --jq program over it, so the selection logic itself is under test. No network.
#
# Usage: bash test/ci-scripts/test-dor-finalize-merged-pr.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/dor_finalize_merged_pr.sh"

command -v jq >/dev/null 2>&1 || {
  echo "jq is required: the stub applies the script's real --jq program to the JSON fixtures." >&2
  exit 1
}

PASS=0
FAIL=0
check() {  # $1 description, $2 expected, $3 actual
  if [ "$2" = "$3" ]; then echo "  PASS  $1"; PASS=$((PASS + 1))
  else echo "  FAIL  $1"; echo "        expected: $(printf '%q' "$2")"; echo "        actual:   $(printf '%q' "$3")"; FAIL=$((FAIL + 1)); fi
}

FEATURE=PVT_kwDOAhfTz84Bern-
BUG=PVT_kwDOAhfTz84BezXo

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# gh stub: the one GraphQL read, answered from $FIX/pr.json through the caller's --jq.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
prev=""; prog=""
for a in "$@"; do [ "$prev" = "--jq" ] && prog="$a"; prev="$a"; done
printf '%s\n' "$*" >> "$FIX/gh.log"
jq -r "$prog" "$FIX/pr.json" | tr -d '\r'
STUB
chmod +x "$TMP/bin/gh"

# Status-writer stub: records each move; fails for any issue listed in $FIX/fail.
cat > "$TMP/set_status.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "$1" "$2" >> "$FIX/moves.log"
! grep -qx "$1" "$FIX/fail" 2>/dev/null
STUB

# One closed issue: $1 number, then zero or more "<project-id>=<Status>" items ('' Status = unset).
issue() {
  local n="$1"; shift
  local items="[]" it
  for it in "$@"; do
    items="$(jq -c --arg p "${it%%=*}" --arg s "${it#*=}" \
      '. + [{project:{id:$p}, status:(if $s == "" then null else {name:$s} end)}]' <<<"$items")"
  done
  jq -cn --argjson n "$n" --argjson i "$items" '{number:$n, projectItems:{nodes:$i}}'
}

# Run the script for PR 1190 against the given issues; echo the moves it made, space-separated.
run() {  # $1 case name, $2 issues-json-lines, [$3 issue that fails to move]
  FIX="$TMP/$1"; mkdir -p "$FIX"; : > "$FIX/moves.log"
  printf '%s\n' "$2" | jq -s '{data:{repository:{pullRequest:{closingIssuesReferences:{nodes:.}}}}}' > "$FIX/pr.json"
  [ -n "${3:-}" ] && printf '%s\n' "$3" > "$FIX/fail"
  RC=0
  OUT="$(FIX="$FIX" PATH="$TMP/bin:$PATH" SET_STATUS="$TMP/set_status.sh" REPO=Fortigi/IdentityAtlas \
         bash "$SCRIPT" 1190 2>&1)" || RC=$?
  MOVES="$(tr '\n' ' ' < "$FIX/moves.log")"
}

echo "DoR finalize — a merged PR moves the issues it closes to Done"
echo

# 1. The regression: a bug parked at Awaiting merge on the Bug board, closed by a non-dor PR.
run stuck "$(issue 1162 "$BUG=Awaiting merge")"
check "a closed-by-PR issue at Awaiting merge is moved to Done" "1162 done " "$MOVES"
check "…and the run succeeds" 0 "$RC"
check "…asking GitHub for that PR by number" 1 "$(grep -c -- '-F n=1190' "$TMP/stuck/gh.log")"

# 2. Several issues, both boards, mixed states — only the unfinished pipeline ones move.
run mixed "$(issue 1046 "$BUG=Awaiting merge")
$(issue 1047 "$FEATURE=")
$(issue 1050 "$BUG=Done")
$(issue 1051)
$(issue 1052 "PVT_someOtherBoard=Awaiting merge")"
check "moves only open-on-a-DoR-board issues, including one with no Status" "1046 done 1047 done " "$MOVES"

# 3. Already Done everywhere — nothing to write.
run done "$(issue 1050 "$BUG=Done")"
check "an issue already Done is left alone" "" "$MOVES"
check "…and that is reported, not an error" 0 "$RC"
case "$OUT" in *"closes no pipeline issue"*) r=yes ;; *) r=no ;; esac
check "…with a notice saying so" yes "$r"

# 4. A PR that closes no issue at all.
run none ""
check "a PR closing nothing moves nothing" "" "$MOVES"
check "…and exits clean" 0 "$RC"

# 5. Not on any board — must NOT be added (dor_set_status.sh would add it).
run offboard "$(issue 1051)"
check "an issue on no DoR board is not dragged onto one" "" "$MOVES"

# 6. On both boards: Done on one, stale on the other — the stale card still needs the move.
run both "$(issue 1053 "$FEATURE=Done" "$BUG=Awaiting merge")"
check "a stale card on either board still triggers the move" "1053 done " "$MOVES"

# 7. One write fails: the others still happen and the run reports failure.
run partial "$(issue 1046 "$BUG=Awaiting merge")
$(issue 1047 "$BUG=Building")" 1046
check "a failed move does not stop the next one" "1046 done 1047 done " "$MOVES"
check "…but the run exits non-zero" 1 "$RC"
case "$OUT" in *"could not move issue #1046"*) r=yes ;; *) r=no ;; esac
check "…naming the issue that failed" yes "$r"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

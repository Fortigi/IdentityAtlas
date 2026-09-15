#!/usr/bin/env bash
# Unit tests for .github/scripts/dor_sidekick_claim.sh — which sidekick a DoR build may take.
#
# The regression: builds were scheduled on the `dor-build` pool label with nothing checking whether
# the idle box they landed on was still parking another issue's functional-test env. #1125's build
# landed on sk5 a month into #1049's acceptance, overwrote its reservation, and then stripped #1049's
# `sk:sk5` label as "stale" — #1049 kept no env and no route, and nothing said so.
#
# `gh` is a function here that serves JSON fixtures and runs the REAL --jq expression through jq, so
# the filters under test are the ones that ship, not a stub's idea of them. No network, no tokens.
#
# Usage: bash test/ci-scripts/test-dor-sidekick-claim.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

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
FIX="$TMP/fix"; CALLS="$TMP/calls.log"
export HOME="$TMP/home" RUNNER_TEMP="$TMP/runner"
export ISSUE=1125 REPO=Fortigi/IdentityAtlas HOST=dev-docker-05 BOARD_TOKEN=stub
SCRIPTS="$TMP/scripts"
mkdir -p "$HOME" "$RUNNER_TEMP" "$SCRIPTS" "$FIX"
printf 'echo "status $*" >> "%s"\n' "$CALLS" > "$SCRIPTS/dor_set_status.sh"

# shellcheck source=/dev/null
source "$REPO_ROOT/.github/scripts/dor_sidekick_claim.sh"

hostname()      { echo dev-docker-05; }
comment_issue() { echo "comment $1" >> "$CALLS"; }

# issue <n> <OPEN|CLOSED> [label…]  /  pr <n> <OPEN|MERGED|CLOSED>
issue() {
  local n="$1" st="$2"; shift 2
  printf '{"number":%s,"state":"%s","labels":[%s]}\n' "$n" "$st" \
    "$(for l in "$@"; do printf '{"name":"%s"},' "$l"; done | sed 's/,$//')" > "$FIX/issue-$n.json"
}
pr()   { printf '{"number":%s,"state":"%s"}\n' "$1" "$2" > "$FIX/pr-$1.json"; }
lock() { printf '%s\n' "$1" > "$HOME/.dor-reservation"; }
reset_world() { rm -f "$FIX"/* "$HOME/.dor-reservation" "$RUNNER_TEMP/dor-paused"; : > "$CALLS"; }

gh() {
  local what="$1 $2"; shift 2
  local num="" jqx="." state="" label="" search="" add="" remove=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --jq) jqx="$2"; shift 2 ;;
      --state) state="$2"; shift 2 ;;
      --label) label="$2"; shift 2 ;;
      --search) search="$2"; shift 2 ;;
      --add-label) add="$2"; shift 2 ;;
      --remove-label) remove="$2"; shift 2 ;;
      --repo|--json|--limit) shift 2 ;;
      -*) shift ;;
      *) num="$1"; shift ;;
    esac
  done
  case "$what" in
    "issue view") [ -f "$FIX/issue-$num.json" ] || return 1; jq -r "$jqx" "$FIX/issue-$num.json" ;;
    "pr view")    [ -f "$FIX/pr-$num.json" ]    || return 1; jq -r "$jqx" "$FIX/pr-$num.json" ;;
    "issue edit") echo "edit #$num add=$add remove=$remove" >> "$CALLS" ;;
    "issue list")
      local wanted="${search#label:}"
      [ -n "$label" ] && wanted="$label"
      cat "$FIX"/issue-*.json 2>/dev/null | jq -s -r \
        --arg st "$state" --arg w "$wanted" \
        "[.[] | select(\$st == \"\" or (.state | ascii_downcase) == \$st)
              | select(\$w == \"\" or ([.labels[].name] - (\$w | split(\",\")) | length) < (.labels | length))]
         | $jqx" ;;
    *) echo "unexpected gh $what" >&2; return 1 ;;
  esac
}

echo "DoR sidekick claim — never build over another issue's env"
echo

# ── sidekick_holder: who else holds this box? ───────────────────────────────
reset_world
assert "no reservation → the box is free" "" "$(sidekick_holder)"

reset_world; lock "1214 1125"; issue 1125 OPEN sk:sk5
assert "our own reservation → free (a resumed build reuses its box)" "" "$(sidekick_holder)"

reset_world; lock "1050 1049"; issue 1049 OPEN sk:sk5
assert "an open issue whose claim names THIS box holds it" "#1049" "$(sidekick_holder)"

# The #1049 incident shape once its label was gone: the file is the only record left, and it wins.
reset_world; lock "1050 1049"; issue 1049 OPEN
assert "an open issue with NO claim label still holds it (the lock is the authority)" "#1049" "$(sidekick_holder)"

reset_world; lock "1214 1212"; issue 1212 OPEN sk:sk7
assert "an open issue whose claim moved to another box left a stale lock → free" "" "$(sidekick_holder)"

reset_world; lock "1206 1202"; issue 1202 CLOSED sk:sk5
assert "a closed issue's reservation is stale → free" "" "$(sidekick_holder)"

reset_world; lock "1050 1049"
assert "an issue we cannot read counts as held" "#1049" "$(sidekick_holder)"

reset_world; lock "903"; pr 903 OPEN
assert "a plain deploy-to-sidekick of an open PR holds it" "PR #903" "$(sidekick_holder)"

reset_world; lock "903"; pr 903 MERGED
assert "…and releases it once that PR is merged" "" "$(sidekick_holder)"

reset_world; lock "903"
assert "…and a PR we cannot read counts as held" "PR #903" "$(sidekick_holder)"

# ── claim_sidekick: never overwrite a live reservation ──────────────────────
reset_world; lock "1050 1049"; issue 1049 OPEN sk:sk5; issue 1125 OPEN
rc=0; claim_sidekick 1214 >/dev/null || rc=$?
assert "claiming a box another open issue holds is refused" 1 "$rc"
assert "…the holder's reservation is untouched" "1050 1049" "$(cat "$HOME/.dor-reservation")"
assert "…and no label was touched on anyone" "" "$(cat "$CALLS")"

reset_world; lock "1206 1202"; issue 1202 CLOSED; issue 1125 OPEN sk:sk7; issue 1049 OPEN sk:sk5
claim_sidekick 1214 >/dev/null
assert "claiming a free box writes our reservation" "1214 1125" "$(cat "$HOME/.dor-reservation")"
assert "…moves our claim here, dropping the old box's label, and clears a stale claim on this box" \
  "$(printf 'edit #1125 add=sk:sk5 remove=sk:sk7\nedit #1049 add= remove=sk:sk5')" "$(cat "$CALLS")"

# ── require_free_sidekick: the on-box backstop ──────────────────────────────
reset_world; issue 1125 OPEN
assert "a free box lets the flow carry on" "carried on" "$(require_free_sidekick >/dev/null; echo 'carried on')"
assert "…without touching anything" "" "$(cat "$CALLS")"

reset_world; lock "1050 1049"; issue 1049 OPEN; issue 1125 OPEN
out="$(require_free_sidekick 2>&1; echo 'carried on')"
assert "a held box stops the flow before it touches anything" "false" \
  "$(printf '%s' "$out" | grep -q 'carried on' && echo true || echo false)"
calls="$(cat "$CALLS")"
assert "…restores the holder's missing claim so routing avoids this box next time" "true" \
  "$(printf '%s' "$calls" | grep -qx 'edit #1049 add=sk:sk5 remove=' && echo true || echo false)"
assert "…parks this build for dor-resume instead of failing it" "true" \
  "$(printf '%s' "$calls" | grep -qx 'edit #1125 add=dor-paused remove=ready-to-build' && echo true || echo false)"
assert "…moves the board to Paused" "true" \
  "$(printf '%s' "$calls" | grep -qx 'status 1125 paused' && echo true || echo false)"
assert "…tells the issue which env it is waiting on" "true" \
  "$(printf '%s' "$calls" | grep -q '^comment .*dev-docker-05.*#1049' && echo true || echo false)"
assert "…and leaves the pause marker the workflow's backstops read" "true" \
  "$([ -f "$RUNNER_TEMP/dor-paused" ] && echo true || echo false)"
assert "…and never overwrote the holder's reservation" "1050 1049" "$(cat "$HOME/.dor-reservation")"

reset_world; lock "1050 1049"; issue 1049 OPEN sk:sk5; issue 1125 OPEN
( require_free_sidekick >/dev/null 2>&1 ) || true
assert "a holder that still has its label is left alone" "false" \
  "$(grep -q '^edit #1049' "$CALLS" && echo true || echo false)"

# Unreadable is not "unlabelled": labelling an issue we could not read would be a guess on a guess.
reset_world; lock "1050 1049"; issue 1125 OPEN
( require_free_sidekick >/dev/null 2>&1 ) || true
assert "a holder we cannot read is not relabelled" "false" \
  "$(grep -q '^edit #1049' "$CALLS" && echo true || echo false)"
assert "…but the build still parks" "true" \
  "$(grep -qx 'edit #1125 add=dor-paused remove=ready-to-build' "$CALLS" && echo true || echo false)"

# ── pick_sidekick: route to a box nobody holds ──────────────────────────────
reset_world; issue 1049 OPEN sk:sk3; issue 1212 OPEN sk:sk5; issue 1125 OPEN
assert "the first pool box no open issue claims" "sk7" "$(DOR_POOL='sk3 sk5 sk7 sk8' pick_sidekick)"

reset_world; issue 1049 OPEN sk:sk3; issue 1125 OPEN sk:sk5
assert "an issue that already holds a pool box goes back to it" "sk5" "$(DOR_POOL='sk3 sk5 sk7' pick_sidekick)"

reset_world; issue 1209 CLOSED sk:sk3; issue 1125 OPEN
assert "a closed issue's leftover claim does not take a box out of the pool" "sk3" "$(DOR_POOL='sk3 sk5' pick_sidekick)"

reset_world; issue 1049 OPEN sk:sk50; issue 1125 OPEN
assert "a claim on sk50 does not count as a claim on sk5" "sk5" "$(DOR_POOL='sk5' pick_sidekick)"

reset_world; issue 1049 OPEN sk:sk3; issue 1212 OPEN sk:sk5; issue 1125 OPEN
assert "every pool box claimed → no pick (fall back to the pool + backstop)" "" "$(DOR_POOL='sk3 sk5' pick_sidekick)"

reset_world; issue 1125 OPEN
assert "no DOR_POOL → no pick" "" "$(DOR_POOL='' pick_sidekick)"

# ── Wiring: the pieces are only worth anything if they are called ──────────
FLOW="$REPO_ROOT/.github/scripts/dor_build_flow.sh"
AGENT="$REPO_ROOT/.github/workflows/dor-build-agent.yml"
guard_line="$(grep -n '^require_free_sidekick' "$FLOW" | head -1 | cut -d: -f1)"
consume_line="$(grep -n 'remove-label ready-to-build' "$FLOW" | head -1 | cut -d: -f1)"
assert "the build flow checks the box before it consumes the trigger or moves the board" "true" \
  "$([ -n "$guard_line" ] && [ -n "$consume_line" ] && [ "$guard_line" -lt "$consume_line" ] && echo true || echo false)"
assert "the build flow bails rather than claim over a holder" "true" \
  "$(grep -A1 '^claim_sidekick "\$pr"' "$FLOW" | grep -q 'bail' && echo true || echo false)"
assert "the build job runs on the picked box" "true" \
  "$(grep -q "needs.pick.outputs.sk || 'dor-build'" "$AGENT" && echo true || echo false)"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

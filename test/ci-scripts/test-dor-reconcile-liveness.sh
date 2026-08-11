#!/usr/bin/env bash
# Unit tests for the DoR reconcile sweep's per-issue triage (.github/scripts/dor_reconcile.sh).
#
# The sweep is the only thing that notices a build whose sidekick died mid-flight — the flow dies
# with the box, so it never reaches its own error handling. That detector (💀, #963) was unreachable
# for its entire target population for weeks (#995): the "no `state:*` label" branch `continue`d
# before the liveness check, and the build side deliberately runs without a state label.
#
# Two more failures followed from how the sweep gathered its facts, and both were invisible to a
# fixture that pre-rendered records:
#
#   * `@tsv` + `IFS=$'\t'` collapses a run of tabs (tab is IFS *whitespace*), so an empty `sk_label`
#     in the middle of a record shifted every field after it and `state_label` came out empty on
#     nearly every issue. Every routed issue was reported "un-routed"; the drift check never ran.
#   * the walk started from `gh issue list --label enhancement`, so 42 of the Feature board's 74
#     items — everything without the gate label — were invisible to every check in it.
#
# So the stub does NOT hand back pre-rendered records. It serves the JSON `gh` would return and runs
# the script's OWN --jq program over it, which puts the record contract itself under test. No
# network, no tokens.
#
# Usage: bash test/ci-scripts/test-dor-reconcile-liveness.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/.github/scripts/dor_reconcile.sh"

command -v jq >/dev/null 2>&1 || {
  echo "jq is required: the stub applies the script's real --jq programs to the JSON fixtures." >&2
  exit 1
}

PASS=0
FAIL=0

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  PASS  $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"
    echo "        expected to find: $needle"
    echo "        in: $(printf '%s' "$haystack" | head -c 400)"
    FAIL=$((FAIL + 1))
  fi
}

assert_lacks() {
  local desc="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  FAIL  $desc"
    echo "        did NOT expect: $needle"
    echo "        in: $(printf '%s' "$haystack" | head -c 400)"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS  $desc"
    PASS=$((PASS + 1))
  fi
}

# ── The stub ────────────────────────────────────────────────────────────────
# Dispatches on the argument shape of each call the script makes, serving files from $FIX and
# appending every write to $FIX/writes.log so a test can assert on what reached GitHub.
make_stub() {
  local dir="$1"
  mkdir -p "$dir/bin"
  cat > "$dir/bin/gh" <<'STUB'
#!/usr/bin/env bash
args="$*"
log() { printf '%s\n' "$*" >> "$FIX/writes.log"; }
# Apply the CALLER'S OWN --jq program to a JSON fixture, so the record contract is exercised rather
# than hand-copied into the fixture. jq on Windows writes CRLF while real `gh` returns LF, so
# normalise: a stray \r rides along in the last field of every record and makes a local run disagree
# with CI about what the script parsed.
jq_arg() { local prev=""; for a in "$@"; do [ "$prev" = "--jq" ] && { printf '%s' "$a"; return 0; }; prev="$a"; done; }
serve()  { local f="$1"; shift; jq -r "$(jq_arg "$@")" "$FIX/$f" | tr -d '\r'; }
case "$args" in
  # Board snapshot (number, state, Status, dates and labels per item).
  "api graphql"*)                       serve board.json "$@" ;;
  # Live DoR workflow runs — display_title lines, one per run.
  *"actions/runs?status="*)             cat "$FIX/live_runs.txt" ;;
  # has_live_run's title lookup — `gh issue view <num> … --json title`, so the number is $3.
  "issue view"*"--json title"*)         sed -n "s/^$3\t//p" "$FIX/titles.tsv" ;;
  # The previous sweep's health issue: its state and the fingerprint buried in its body.
  "issue view"*"--json state,body"*)    serve health.json "$@" ;;
  # Issues already marked `dor-stuck`. GitHub AND-s repeated --label filters, and the stub has to
  # model that: a query gated on the pipeline label sees a different set from one scoped by
  # ownership, and that difference IS the behaviour under test.
  *"--state open --label dor-stuck"*)
    want=""; prev=""
    for a in "$@"; do [ "$prev" = "--label" ] && want="$want $a"; prev="$a"; done
    jq -c --arg want "$want" \
      '[ .[] | select( (($want | split(" ") | map(select(. != ""))) - [.labels[].name]) == [] ) ]' \
      "$FIX/marked.json" | jq -r "$(jq_arg "$@")" | tr -d '\r'
    ;;
  # The gate-label query — only issues MISSING from the board still matter to the walk.
  *"--state open --label"*"--limit 201"*) serve issues.json "$@" ;;
  *"--state closed --label"*)           : ;;   # no closed issues claiming a sidekick
  # Does a health issue already exist?
  *"--state all --limit 100"*)          serve health_list.json "$@" ;;
  "pr list"*)                           : ;;   # no open PR (zombie check)
  "issue create"*)                      log "CREATE_BODY: $*" ;;
  "issue comment"*)                     log "COMMENT: $*" ;;
  "issue reopen"*)                      log "REOPEN: $*" ;;
  "issue close"*)                       log "CLOSE: $*" ;;
  "issue edit"*)                        log "EDIT: $*" ;;
  *)                                    : ;;
esac
exit 0
STUB
  chmod +x "$dir/bin/gh"
}

# Run the real sweep against one fixture set; echo the health-report body it tried to publish.
run_sweep() {
  local fix="$1"
  FIX="$fix" PATH="$fix/bin:$PATH" \
    OWNER=Fortigi REPO=IdentityAtlas PROJECT_ID=PVT_test GH_TOKEN=stub LABEL=enhancement \
    bash "$SCRIPT" >/dev/null 2>&1 || true
  # The body is multi-line, so take the CREATE_BODY line and everything after it — a plain grep
  # would return only the report's first line and every assertion below would vacuously fail.
  sed -n '/^CREATE_BODY: /,$p' "$fix/writes.log" 2>/dev/null || true
}

# ── Fixture pieces ──────────────────────────────────────────────────────────
# One board item, as the GraphQL node the script reads.
board_node() {  # $1 number  $2 OPEN|CLOSED  $3 Status ('' = no Status set)  $4 created  $5 updated  $6 labels csv
  jq -cn --argjson n "$1" --arg s "$2" --arg st "$3" --argjson c "$4" --argjson u "$5" --arg l "$6" \
    '{ content: { number: $n, state: $s, createdAt: ($c|todate), updatedAt: ($u|todate),
                  labels: { nodes: [ $l | split(",")[] | select(. != "") | {name: .} ] } },
       status: (if $st == "" then null else {name: $st} end) }'
}

# Wrap board nodes into the response envelope the query returns.
board_doc() {  # $@ = node JSON objects
  if [ "$#" -eq 0 ]; then echo '{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false},"nodes":[]}}}}'; return; fi
  printf '%s\n' "$@" | jq -s '{data:{node:{items:{pageInfo:{hasNextPage:false}, nodes: .}}}}'
}

# One issue as the gate-label query returns it.
issue_node() {  # $1 number  $2 created  $3 updated  $4 labels csv
  jq -cn --argjson n "$1" --argjson c "$2" --argjson u "$3" --arg l "$4" \
    '{ number: $n, createdAt: ($c|todate), updatedAt: ($u|todate),
       labels: [ $l | split(",")[] | select(. != "") | {name: .} ] }'
}

# Say that a previous sweep already marked #370 `dor-stuck`, so the "comment once" dedupe has
# something to find. $2 = the issue's other labels, which is what decides whether a gate-labelled
# query can see the mark at all.
mark_stuck() {  # $1 dir  $2 extra labels csv
  jq -cn --arg l "$2" \
    '[{ number: 370, labels: ([{name:"dor-stuck"}] + [ $l | split(",")[] | select(. != "") | {name:.} ]) }]' \
    > "$1/marked.json"
}

# Give the fixture a health issue as a previous sweep left it, so §4 has something to compare against.
seed_health() {  # $1 dir  $2 OPEN|CLOSED  $3 body
  jq -cn '[{number: 886, title: "DoR pipeline health"}]' > "$1/health_list.json"
  jq -cn --arg s "$2" --arg b "$3" '{state: $s, body: $b}'  > "$1/health.json"
}

# Build a fixture dir holding ONE issue (#370).
#   $2 board Status ('' = on the board with no Status)   $3 minutes since its last update
#   $4 "live" to make a DoR run look alive for it
#   $5 its `sk:*` label ('' for none)   $6 its `state:*` label ('' for none, as the build side leaves it)
#   $7 "nogate" to drop the `enhancement` gate label, so ONLY the board knows about it
#   $8 "bug" to add the `bug` label     $9 "offboard" to leave it off the board entirely
scenario() {
  local dir="$1" status="$2" upd_min="$3" live="${4:-}" sk="${5-sk:sk3}" state="${6-}"
  local gate="${7-}" bug="${8-}" place="${9-}"
  local now created updated labels=""
  now="$(date -u +%s)"
  created=$(( now - 3600 * 1000 ))          # ancient: opened ~42 days ago, like #370
  updated=$(( now - 60 * upd_min ))
  if [ "$gate" != nogate ]; then labels="enhancement"; fi
  if [ "$bug"  =  bug    ]; then labels="${labels:+$labels,}bug"; fi
  if [ -n "$sk" ];         then labels="${labels:+$labels,}$sk"; fi
  if [ -n "$state" ];      then labels="${labels:+$labels,}$state"; fi

  rm -rf "$dir"; mkdir -p "$dir"
  make_stub "$dir"
  : > "$dir/writes.log"
  printf '370\tCollapse managed resources\n' > "$dir/titles.tsv"
  printf '[]\n'                              > "$dir/health_list.json"
  printf '[]\n'                              > "$dir/marked.json"

  if [ "$place" = offboard ]; then
    board_doc                                                                  > "$dir/board.json"
  else
    board_doc "$(board_node 370 OPEN "$status" "$created" "$updated" "$labels")" > "$dir/board.json"
  fi
  if [ "$gate" = nogate ]; then
    printf '[]\n'                                                              > "$dir/issues.json"
  else
    issue_node 370 "$created" "$updated" "$labels" | jq -s .                   > "$dir/issues.json"
  fi
  if [ "$live" = "live" ]; then
    printf 'Collapse managed resources\n'                                      > "$dir/live_runs.txt"
  else
    : > "$dir/live_runs.txt"
  fi
  printf '%s' "$dir"
}

# A board that still lists CLOSED issues and no open ones, so only the closed-issue check speaks.
# Two rows, so every assertion is two-sided: #370 carries the status under test, #371 is the control
# that must always be flagged (which also proves a report was published at all).
closed_scenario() {
  local dir="$1" status="$2"
  rm -rf "$dir"; mkdir -p "$dir"; make_stub "$dir"
  : > "$dir/writes.log"; : > "$dir/live_runs.txt"; : > "$dir/titles.tsv"
  printf '[]\n' > "$dir/issues.json"; printf '[]\n' > "$dir/health_list.json"
  board_doc "$(board_node 370 CLOSED "$status"   1 1 enhancement)" \
            "$(board_node 371 CLOSED "Building"  1 1 enhancement)" > "$dir/board.json"
  printf '%s' "$dir"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "DoR reconcile — died-sidekick liveness"
echo

# ── 1. THE regression (#995): Building + no live run must be flagged 💀 ──────
# Pre-fix this emitted the 🕳️ un-routed line instead, because the label-less branch `continue`d
# before the liveness check ever ran.
out="$(run_sweep "$(scenario "$TMP/dead" 'Building' 40)")"
assert_contains "a dead Building issue is flagged as a died sidekick" "💀 #370" "$out"
assert_contains "…and is told to re-dispatch, not that the agent never ran" "re-dispatch it" "$out"
assert_lacks    "…and is NOT mis-reported as un-routed" "🕳️ #370" "$out"
assert_contains "the issue itself gets marked dor-stuck" "add-label dor-stuck" \
  "$(cat "$TMP/dead/writes.log")"
assert_contains "…and commented on directly" "COMMENT: issue comment 370" \
  "$(cat "$TMP/dead/writes.log")"

# ── 2. A build that IS alive must stay quiet ────────────────────────────────
out="$(run_sweep "$(scenario "$TMP/alive" 'Building' 40 live)")"
assert_lacks "a live build is not reported dead" "💀 #370" "$out"
assert_lacks "a live build is not reported un-routed either" "🕳️ #370" "$out"

# ── 3. Genuinely un-routed still flagged ────────────────────────────────────
# No state label AND no board Status: nothing owns it, so the original 🕳️ rule must survive.
out="$(run_sweep "$(scenario "$TMP/unrouted" '' 600)")"
assert_contains "an issue nothing owns is still flagged un-routed" "🕳️ #370" "$out"

# ── 4. Un-routed age is measured from the last update, not from creation ────
# Same ancient creation date, but touched 60 min ago and UNROUTED_HOURS defaults to 6. Pre-fix this
# reported "after 1000h" purely because the issue was opened in June.
out="$(run_sweep "$(scenario "$TMP/fresh" '' 60)")"
assert_lacks "a recently-updated issue is not flagged on its creation age" "🕳️ #370" "$out"

echo
echo "DoR reconcile — the record must not shift when a field is empty"
echo

# ── 5. An issue WITH a state label and NO sidekick — the common shape ───────
# The record is `…<sep><sep>state:decompose`: `sk_label` empty in the MIDDLE. Under @tsv/IFS-tab the
# two delimiters collapsed, `state_label` came out empty, and the sweep reported the issue as
# un-routed while the drift check silently never ran. Status here disagrees with the label, so a
# working parse MUST produce 🔀 — which also makes the 🕳️ assertion non-vacuous.
out="$(run_sweep "$(scenario "$TMP/drift" 'Awaiting design' 600 '' '' 'state:decompose')")"
assert_lacks    "a labelled issue is not mis-reported as un-routed" "🕳️ #370" "$out"
assert_contains "the drift check can see the state label again" "🔀 #370" "$out"
assert_contains "…and names both sides of the disagreement" \
  'label `state:decompose` (→ Decompose) but board Status is **Awaiting design**' "$out"

# ── 6. …and when the label and the board agree, the sweep says nothing ──────
run_sweep "$(scenario "$TMP/routed" 'Decompose' 600 '' '' 'state:decompose')" >/dev/null
assert_lacks "a correctly-routed issue publishes no health report at all" "CREATE_BODY" \
  "$(cat "$TMP/routed/writes.log")"

echo
echo "DoR reconcile — membership, not the gate label, decides what is swept"
echo

# ── 7. On the board without the gate label — was invisible to everything ────
# 42 of the Feature board's 74 items had no `enhancement` label, so the walk never saw them: no
# drift, no staleness, no liveness, and an "Awaiting approval" item missing from the 🚦 count.
# Same drift setup as #5, but the issue is absent from the gate-label query entirely.
out="$(run_sweep "$(scenario "$TMP/boardonly" 'Awaiting design' 600 '' '' 'state:decompose' nogate)")"
assert_contains "an issue the board carries is swept without the gate label" "🔀 #370" "$out"

# ── 8. …and the approval gate counts it ─────────────────────────────────────
out="$(run_sweep "$(scenario "$TMP/approval" 'Awaiting approval' 600 '' '' 'state:awaiting-approval' nogate)")"
assert_contains "…including in the value-gate backlog" "🚦 1 issue(s)" "$out"

# ── 9. An issue with the gate label but NOT on the board is still healed ────
# The board cannot show us this one, so the label query has to stay. `dor_set_status.sh` gets no
# usable GraphQL from the stub and fails, which is the ❌ arm — reaching it at all is the point.
out="$(run_sweep "$(scenario "$TMP/offboard" '' 600 '' '' 'state:decompose' '' '' offboard)")"
assert_contains "an issue missing from the board still reaches the heal path" \
  "#370 is missing from the board" "$out"

# ── 10. The "comment once" mark must work without the gate label too ────────
# 💀 comments directly on the issue, and only once — the mark is how it remembers. Once the walk
# started following board membership, `stalled` could hold an issue with no gate label, while the
# mark was still looked up with `--label dor-stuck --label "$LABEL"`. That query can never return
# such an issue, so its mark was invisible and the comment repeated every hour on something already
# broken. 38 open Feature-board items have no gate label; this was one dead build away from firing.
dir="$(scenario "$TMP/stuckmark" 'Building' 40 '' '' '' nogate)"
mark_stuck "$dir" ""            # marked dor-stuck, and carrying no gate label
run_sweep "$dir" >/dev/null
assert_lacks    "an already-marked stalled issue is not commented on again" "COMMENT: issue comment 370" \
  "$(cat "$dir/writes.log")"
assert_contains "…though it is still reported in the health digest" "💀 #370" \
  "$(cat "$dir/writes.log")"

# ── 11. …and an unmarked one still gets its one comment ─────────────────────
dir="$(scenario "$TMP/stuckfirst" 'Building' 40 '' '' '' nogate)"
run_sweep "$dir" >/dev/null
assert_contains "a newly stalled issue is commented on once" "COMMENT: issue comment 370" \
  "$(cat "$dir/writes.log")"

# ── 12. An item filed on the wrong board ────────────────────────────────────
# #819 sat on the Feature board at "Blocked (external)" while the Bug board had it at "Awaiting
# functional acceptance". Membership-driven, it must be named as misfiled rather than un-routed.
out="$(run_sweep "$(scenario "$TMP/wrongboard" 'Blocked (external)' 600 '' '' '' nogate bug)")"
assert_contains "a bug on the Feature board is called out as misfiled" "🧭 #370" "$out"
assert_lacks    "…and is NOT reported as un-routed" "🕳️ #370" "$out"

echo
echo "DoR reconcile — the report notifies on CHANGE, not on schedule"
echo

# ── 11. Same exceptions as last sweep: refresh the body, post no comment ────
# The 🕳️ line embeds a moving age, so the TEXT differs every hour while the finding is identical.
# Comparing bodies would notify forever; comparing the fingerprint is what makes it quiet.
dir="$(scenario "$TMP/nochange" '' 600)"
seed_health "$dir" OPEN "_Last swept 2026-01-01 00:00 UTC — 1 item(s) need attention:_

- 🕳️ #370 is on the board (Status: none) with no \`state:*\` label and untouched for 999h — the agent likely never ran.
<!-- dor-fingerprint: 🕳️#370 -->"
run_sweep "$dir" >/dev/null
assert_contains "the body is still refreshed every sweep" "EDIT:" "$(cat "$dir/writes.log")"
assert_lacks    "…but an unchanged exception set posts no comment" "COMMENT:" "$(cat "$dir/writes.log")"
assert_lacks    "…and a moving age alone is not a change" "999h" "$(cat "$dir/writes.log")"

# ── 12. A different exception set does notify ───────────────────────────────
dir="$(scenario "$TMP/changed" '' 600)"
seed_health "$dir" OPEN "_stale_

- 🔀 #370 drift: something else entirely.
<!-- dor-fingerprint: 🔀#370 -->"
run_sweep "$dir" >/dev/null
assert_contains "a changed exception set does comment" "COMMENT:" "$(cat "$dir/writes.log")"

# ── 13. A closed health issue is reopened, and that always warrants a comment ─
dir="$(scenario "$TMP/reopen" '' 600)"
seed_health "$dir" CLOSED "_stale_

- 🕳️ #370 is on the board … untouched for 999h — the agent likely never ran.
<!-- dor-fingerprint: 🕳️#370 -->"
run_sweep "$dir" >/dev/null
assert_contains "a closed health issue is reopened" "REOPEN:" "$(cat "$dir/writes.log")"
assert_contains "…and commented on even though the set is unchanged" "COMMENT:" "$(cat "$dir/writes.log")"

# ── 14. Healthy again: close it ─────────────────────────────────────────────
dir="$(scenario "$TMP/recovered" 'Decompose' 600 '' '' 'state:decompose')"
seed_health "$dir" OPEN "_stale_

- 🕳️ #370 …
<!-- dor-fingerprint: 🕳️#370 -->"
run_sweep "$dir" >/dev/null
assert_contains "a recovered pipeline closes its health issue" "CLOSE:" "$(cat "$dir/writes.log")"
assert_lacks    "…without a parting comment" "COMMENT:" "$(cat "$dir/writes.log")"

echo
echo "DoR reconcile — closed issues on the board"
echo

# ── 15. Done is the ONLY resting state — "Out of pipeline" must still nag ───
# Leaving the pipeline is not the same as being filed away: a closed issue parked in "Out of
# pipeline" still has to be walked over to Done, and this report line is the only reminder that it
# is sitting there. Pinned because it is tempting to read that column as terminal and silence it.
out="$(run_sweep "$(closed_scenario "$TMP/closed-oop" 'Out of pipeline')")"
assert_contains "a closed issue parked mid-pipeline is flagged" "🔚 #371" "$out"
assert_contains "…and a closed 'Out of pipeline' issue is flagged too" "🔚 #370" "$out"

# ── 16. …but a closed issue that reached Done is left alone ─────────────────
# #371 still flags, so the report exists and the assertion below is not vacuous.
out="$(run_sweep "$(closed_scenario "$TMP/closed-done" 'Done')")"
assert_contains "the control row still flags" "🔚 #371" "$out"
assert_lacks    "a closed Done issue is not flagged" "🔚 #370" "$out"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

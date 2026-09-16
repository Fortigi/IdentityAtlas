#!/usr/bin/env bash
# Tests for the DoR build's BOT-token checkpoint + continuation (.github/scripts/dor_token_checkpoint.sh,
# dor_flow_step.sh, dor_stage_flow_credentials.sh, and their wiring in dor_build_flow.sh and
# dor-build-agent.yml).
#
# The BOT app token lives one hour; the build pushed with it long after. Run 34821100296 (#1202) pushed
# its initial branch at 08:37, fix 1 at 09:06, and fix 2 at 09:46 — `Invalid username or token`, bail,
# Exceptions. The fix does not bring the private key to the sidekick: the flow checkpoints before its
# token is too old, and the workflow continues it in a new step with a freshly minted one. These tests
# pin that a stale token is never spent, that nothing is lost or repeated across the hand-over (the
# pending commit is pushed, implement never re-runs, fix attempts are not refunded), and that the
# workflow runs a continuation exactly when one was asked for.
#
# Real git against local file:// repositories; gh, claude, docker, curl and sleep are stubs; a git
# wrapper maps github.com to the local origin for the end-to-end flow runs. No network, no real tokens.
#
# Usage: bash test/ci-scripts/test-dor-token-checkpoint.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOR_SCRIPTS="$REPO_ROOT/.github/scripts"
LIB="$DOR_SCRIPTS/dor_build_lib.sh"
FLOW="$DOR_SCRIPTS/dor_build_flow.sh"
AGENT="$REPO_ROOT/.github/workflows/dor-build-agent.yml"

PASS=0; FAIL=0
assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"; echo "        expected: $expected"; echo "        actual:   $actual"; FAIL=$((FAIL + 1))
  fi
}
yesno() { if "$@"; then echo yes; else echo no; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REAL_GIT="$(command -v git)"

# ── Fixture: a bare origin with main, a clone on the build branch that already has a pushed commit ──
git init --quiet --bare "$TMP/origin.git"
WORK="$TMP/work"
git init --quiet "$WORK"
git -C "$WORK" config user.email t@example.com
git -C "$WORK" config user.name Test
git -C "$WORK" config core.autocrlf false
commit() { printf '%s\n' "$1" > "$WORK/f.txt"; git -C "$WORK" add f.txt; git -C "$WORK" commit --quiet -m "$1"; }
commit base
git -C "$WORK" push --quiet "file://$TMP/origin.git" HEAD:refs/heads/main
git -C "$WORK" remote add origin "file://$TMP/origin.git"
git -C "$WORK" fetch --quiet origin
git -C "$WORK" checkout --quiet -b dor/issue-1202
commit implemented
git -C "$WORK" push --quiet "file://$TMP/origin.git" HEAD:refs/heads/dor/issue-1202
# The library runs some git without -C (verify_loop's restore/add/commit), exactly as the flow does
# after its own `cd "$WORK"`. Do the same — from the repository, those would act on THIS checkout.
cd "$WORK" || exit 1

mkdir -p "$TMP/bin" "$TMP/home"
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$TMP/gh.log"
case "$*" in
  *"--json labels"*)          echo no ;;
  *"--json headRefOid"*)      echo deadbeef ;;
  *"actions/runs?head_sha"*)  echo 0 ;;
  *"--json statusCheckRollup"*) echo "${CI_ROLLUP:-[\"SUCCESS\"]}" ;;
esac
exit 0
STUB
# The agent: counts its runs and, like a real fixer, leaves an edit in the tree.
cat > "$TMP/bin/claude" <<'STUB'
#!/usr/bin/env bash
echo run >> "$TMP/claude.log"
date +%s%N >> "$WORK/f.txt"
echo '{"is_error":false}'
STUB
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/docker"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/sleep"
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"-w"*)            printf 200 ;;
  *"-X POST"*crawler-jobs*) echo '{"id":"1"}' ;;
  *crawler-jobs/*)   echo '{"status":"completed"}' ;;
esac
exit 0
STUB
# github.com → the local origin, for every git the flow runs (clone, fetch, the app-token push URL).
cat > "$TMP/bin/git" <<STUB
#!/usr/bin/env bash
args=()
for a in "\$@"; do
  case "\$a" in https://*github.com/Fortigi/IdentityAtlas.git) a="file://$TMP/origin.git" ;; esac
  args+=("\$a")
done
exec "$REAL_GIT" "\${args[@]}"
STUB
chmod +x "$TMP/bin/"*

export TMP WORK ISSUE=1202 REPO=Fortigi/IdentityAtlas URL=https://example.invalid HOST=sk-test
export RUNNER_TEMP="$TMP/runner" HOME="$TMP/home"
mkdir -p "$RUNNER_TEMP"
export GH_TOKEN=ghs_flow BOARD_TOKEN=ghs_board
unset DOR_CRED_DIR DOR_FLOW_MODE BOARD_TOKEN_MINTED_AT DOR_TOKEN_REFRESHES_LEFT
# shellcheck source=/dev/null
source "$LIB"
PATH="$TMP/bin:$PATH"
app_remote_url() { printf '%s' "file://$TMP/origin.git"; }

CKPT="$RUNNER_TEMP/dor-checkpoint"
remote_sha() { git -C "$TMP/origin.git" rev-parse --verify --quiet "refs/heads/$BRANCH" || true; }
ckpt_get() { sed -n "s/^$1=//p" "$CKPT" 2>/dev/null; }
now() { date +%s; }

echo "DoR build — BOT token checkpoint + continuation"
echo

# ── 1. Token age: unknown never checkpoints; the boundary sits at DOR_TOKEN_MAX_AGE ─────────────────
assert "the default safe age is 50 minutes" 3000 "$DOR_TOKEN_MAX_AGE"
unset BOARD_TOKEN_MINTED_AT
assert "no staged mint time → the age is unknown" no "$(yesno board_token_age)"
assert "…and an unknown age is never stale (the feedback flow keeps today's behaviour)" no "$(yesno board_token_stale)"
BOARD_TOKEN_MINTED_AT="12abc"
assert "a non-numeric mint time is unknown, not ancient" no "$(yesno board_token_stale)"
# One second either side of the limit. (A slow second between here and the check can only move the
# first case TOWARDS stale, so give it one second of slack rather than a flaky edge.)
BOARD_TOKEN_MINTED_AT=$(( $(now) - 2998 ))
assert "a 2998s-old token is fresh" no "$(yesno board_token_stale)"
BOARD_TOKEN_MINTED_AT=$(( $(now) - 3000 ))
assert "a 3000s-old token is stale" yes "$(yesno board_token_stale)"

# ── 2. push_or_checkpoint with a fresh token pushes ─────────────────────────────────────────────────
export DOR_TOKEN_REFRESHES_LEFT=3
BOARD_TOKEN_MINTED_AT=$(now)
commit fix-1
push_or_checkpoint verify 1206 1 >/dev/null 2>&1; rc=$?
assert "fresh token: the push succeeds" 0 "$rc"
assert "…and lands on the remote" "$(git -C "$WORK" rev-parse HEAD)" "$(remote_sha)"
assert "…and no checkpoint is written" no "$(yesno test -e "$CKPT")"

# ── 3. …with a stale token it does not even try ─────────────────────────────────────────────────────
BOARD_TOKEN_MINTED_AT=$(( $(now) - 3500 ))
commit fix-2
before="$(remote_sha)"
( push_or_checkpoint verify 1206 2 ) >/dev/null 2>&1; rc=$?
assert "stale token: exits with the needs-a-fresh-token code" 75 "$rc"
assert "…and pushes nothing" "$before" "$(remote_sha)"
assert "…and records the phase"   verify "$(ckpt_get phase)"
assert "…the PR"                  1206   "$(ckpt_get pr)"
assert "…the attempt already spent" 2    "$(ckpt_get attempt)"
assert "…the branch"              "$BRANCH" "$(ckpt_get branch)"
assert "…and the commit it left pending" "$(git -C "$WORK" rev-parse HEAD)" "$(ckpt_get head)"
assert "…and holds no token" no "$(yesno grep -q 'ghs_' "$CKPT")"

# ── 4. Reading a checkpoint: consumed, and only if it describes this checkout ───────────────────────
cp "$CKPT" "$TMP/ckpt.good"
assert "a valid checkpoint is read" yes "$(yesno read_checkpoint)"
read_checkpoint_into_shell() { cp "$TMP/ckpt.good" "$CKPT"; read_checkpoint; }
read_checkpoint_into_shell
assert "…into phase / PR / attempt" "verify 1206 2" "$CKPT_PHASE $CKPT_PR $CKPT_ATTEMPT"
assert "…and consumed, so it can steer only one continuation" no "$(yesno test -e "$CKPT")"
bad() { sed "$1" "$TMP/ckpt.good" > "$CKPT"; yesno read_checkpoint; }
assert "a checkpoint for another HEAD is refused"   no "$(bad 's/^head=.*/head=0000000/')"
assert "a checkpoint for another branch is refused" no "$(bad 's/^branch=.*/branch=dor\/issue-1/')"
assert "an unknown phase is refused"                no "$(bad 's/^phase=.*/phase=implement/')"
assert "a non-numeric attempt is refused"           no "$(bad 's/^attempt=.*/attempt=1;x/')"
assert "a verify checkpoint without a PR is refused" no "$(bad 's/^pr=.*/pr=/')"
{ grep -v '^reason=' "$TMP/ckpt.good"; printf 'reason=$(touch %s/pwned)\n' "$TMP"; } > "$CKPT"
read_checkpoint
assert "the file is parsed, never executed" no "$(yesno test -e "$TMP/pwned")"
assert "no checkpoint → nothing to read" no "$(yesno read_checkpoint)"

# ── 5. No refreshes left: bail, rather than exit into a step that does not exist ───────────────────
bail() { echo "$1" > "$TMP/bail.txt"; exit 1; }
rm -f "$CKPT" "$TMP/bail.txt"
( DOR_TOKEN_REFRESHES_LEFT=0 push_or_checkpoint verify 1206 5 ) >/dev/null 2>&1; rc=$?
assert "stale token with 0 refreshes left: bails (exit 1), not 75" 1 "$rc"
assert "…saying the token refreshes ran out" yes "$(yesno grep -q 'no token refreshes left' "$TMP/bail.txt")"
assert "…and leaves no checkpoint behind" no "$(yesno test -e "$CKPT")"
( unset DOR_TOKEN_REFRESHES_LEFT; push_or_checkpoint verify 1206 5 ) >/dev/null 2>&1; rc=$?
assert "an unset refresh count is treated as none left" 1 "$rc"

# ── 6. verify_loop resumes at the attempt it stopped at — MAX_ATTEMPTS bounds the whole build ───────
deploy_and_seed() { return 0; }
run_feature_e2e() { return 1; }
ci_state() { echo fail; }
BOARD_TOKEN_MINTED_AT=$(now)
MAX_ATTEMPTS=4
: > "$TMP/claude.log"
( verify_loop 1206 2 ) >/dev/null 2>&1; rc=$?
assert "resuming at attempt 2 of 4: exactly one more fix run" 1 "$(wc -l < "$TMP/claude.log" | tr -d ' ')"
assert "…then bails as out of attempts" yes "$(yesno grep -q 'still failing after 4 fix attempts' "$TMP/bail.txt")"
: > "$TMP/claude.log"
( verify_loop 1206 ) >/dev/null 2>&1
assert "a fresh verify_loop still gets its three fix runs" 3 "$(wc -l < "$TMP/claude.log" | tr -d ' ')"

# …and inside the loop, a fix whose token has gone stale is committed and checkpointed, not pushed.
BOARD_TOKEN_MINTED_AT=$(( $(now) - 3100 ))
before="$(remote_sha)"; rm -f "$CKPT"; : > "$TMP/claude.log"
( verify_loop 1206 1 ) >/dev/null 2>&1; rc=$?
assert "a stale token in verify_loop exits 75" 75 "$rc"
assert "…after one fix run" 1 "$(wc -l < "$TMP/claude.log" | tr -d ' ')"
assert "…with the fix committed locally" "fix: address e2e/CI failures (attempt 2, #1202)" "$(git -C "$WORK" log -1 --format=%s)"
assert "…not pushed" "$before" "$(remote_sha)"
assert "…and checkpointed at attempt 2" "verify 2" "$(ckpt_get phase) $(ckpt_get attempt)"
git -C "$WORK" reset --quiet --hard "$before"
unset -f deploy_and_seed run_feature_e2e ci_state
source "$LIB"   # put the real verify-loop helpers back for the flow runs below
app_remote_url() { printf '%s' "file://$TMP/origin.git"; }
bail() { echo "$1" > "$TMP/bail.txt"; exit 1; }

# ── 7. A usage-limit pause with a stale token hands over instead of losing its WIP ──────────────────
BOARD_TOKEN_MINTED_AT=$(( $(now) - 3100 ))
rm -f "$CKPT" "$RUNNER_TEMP/dor-paused"
echo wip >> "$WORK/f.txt"
before="$(remote_sha)"
( pause_and_exit "hit a usage limit during a fix attempt (attempt 3)" ) >/dev/null 2>&1; rc=$?
assert "pause with a stale token exits 75" 75 "$rc"
assert "…commits the WIP locally" "wip: paused on usage limit (#1202)" "$(git -C "$WORK" log -1 --format=%s)"
assert "…does not push it with the dead token" "$before" "$(remote_sha)"
assert "…leaves no pause marker yet (a later bail must not reconcile as paused)" no "$(yesno test -e "$RUNNER_TEMP/dor-paused")"
assert "…and keeps the reason" "pause|hit a usage limit during a fix attempt (attempt 3)" "$(ckpt_get phase)|$(ckpt_get reason)"
BOARD_TOKEN_MINTED_AT=$(now)
( resume_from_checkpoint ) >/dev/null 2>&1; rc=$?
assert "continuing a pause exits 0, as a pause does" 0 "$rc"
assert "…the WIP is pushed with the fresh token" "$(git -C "$WORK" rev-parse HEAD)" "$(remote_sha)"
assert "…and it is now marked paused" yes "$(yesno test -e "$RUNNER_TEMP/dor-paused")"
rm -f "$RUNNER_TEMP/dor-paused"

# ── 8. The credential hand-off: the mint time comes with the tokens, and every file is deleted ──────
export DOR_TOKEN_REFRESHES_LEFT=0
( export GH_TOKEN=ghs_stage_gh BOARD_TOKEN=ghs_stage_board; bash "$DOR_SCRIPTS/dor_stage_flow_credentials.sh" )
staged="$(cat "$RUNNER_TEMP/dor-cred/board-minted-at")"
assert "staging records a numeric mint time within a few seconds of now" yes \
  "$(yesno test $(( $(now) - staged )) -le 5)"
assert "…next to both tokens" "ghs_stage_gh ghs_stage_board" \
  "$(cat "$RUNNER_TEMP/dor-cred/gh") $(cat "$RUNNER_TEMP/dor-cred/board")"
loaded="$(DOR_CRED_DIR="$RUNNER_TEMP/dor-cred" bash -c 'source "$1/dor_agent_sandbox.sh"; load_flow_credentials; printf "%s %s" "$BOARD_TOKEN" "$BOARD_TOKEN_MINTED_AT"' _ "$DOR_SCRIPTS")"
assert "load_flow_credentials takes the token and its mint time" "ghs_stage_board $staged" "$loaded"
assert "…and deletes every staged file" no "$(yesno test -e "$RUNNER_TEMP/dor-cred")"

# ── 9. dor_flow_step.sh: 75 + a checkpoint is a hand-over; anything else passes through ─────────────
mkdir -p "$TMP/step"
cp "$DOR_SCRIPTS/dor_flow_step.sh" "$DOR_SCRIPTS/dor_token_checkpoint.sh" "$TMP/step/"
printf '#!/usr/bin/env bash\nprintf "phase=verify\\n" > "$RUNNER_TEMP/dor-checkpoint"; exit 75\n' > "$TMP/step/ckpt.sh"
printf '#!/usr/bin/env bash\nexit 75\n' > "$TMP/step/bare75.sh"
printf '#!/usr/bin/env bash\nexit 1\n'  > "$TMP/step/bail.sh"
printf '#!/usr/bin/env bash\nexit 0\n'  > "$TMP/step/done.sh"
step() { rm -f "$CKPT"; : > "$TMP/gh-output"; GITHUB_OUTPUT="$TMP/gh-output" bash "$TMP/step/dor_flow_step.sh" "$1" >/dev/null 2>&1; echo "$?|$(cat "$TMP/gh-output")"; }
assert "a checkpointed flow: the step succeeds and asks for a token" "0|needs-token=true" "$(step ckpt.sh)"
assert "exit 75 without a checkpoint is a failure, not a hand-over" "75|" "$(step bare75.sh)"
assert "a bail still fails the step (the backstop sees it)" "1|" "$(step bail.sh)"
assert "a finished flow asks for nothing" "0|" "$(step done.sh)"

# ── 10. The flow end to end, in continue mode ───────────────────────────────────────────────────────
# A checkpoint left by a run whose fix commit was not pushed; the next step runs the real flow.
flow_continue() {  # $1 = attempt in the checkpoint; env: CI_ROLLUP, MAX_ATTEMPTS
  git -C "$WORK" checkout --quiet "$BRANCH"
  commit "pending-$1"
  printf 'phase=verify\npr=1206\nattempt=%s\nbranch=%s\nhead=%s\nreason=\n' \
    "$1" "$BRANCH" "$(git -C "$WORK" rev-parse HEAD)" > "$CKPT"
  mkdir -p "$TMP/cred"
  printf 'ghs_fresh_gh\n' > "$TMP/cred/gh"; printf 'ghs_fresh_board\n' > "$TMP/cred/board"; now > "$TMP/cred/board-minted-at"
  : > "$TMP/gh.log"; : > "$TMP/claude.log"; rm -f "$RUNNER_TEMP"/dor-done "$RUNNER_TEMP"/dor-bailed
  ( unset GH_TOKEN BOARD_TOKEN BOARD_TOKEN_MINTED_AT
    export DOR_FLOW_MODE=continue DOR_CRED_DIR="$TMP/cred" DOR_TOKEN_REFRESHES_LEFT=2 WORK
    bash "$FLOW" ) > "$TMP/flow.out" 2>&1
}
MAX_ATTEMPTS=8 CI_ROLLUP='["SUCCESS"]' flow_continue 2; rc=$?
assert "continue mode, CI now green: the flow finishes (exit 0)" 0 "$rc"
assert "…having pushed the pending commit" "$(git -C "$WORK" rev-parse HEAD)" "$(remote_sha)"
assert "…without running the agent (no implement, no fix)" 0 "$(wc -l < "$TMP/claude.log" | tr -d ' ')"
assert "…without opening another PR" 0 "$(grep -c 'pr create' "$TMP/gh.log")"
assert "…without re-posting the start-of-build comment" 0 "$(grep -c 'Started' "$TMP/gh.log")"
assert "…without re-consuming the trigger label" 0 "$(grep -c 'remove-label ready-to-build' "$TMP/gh.log")"
assert "…and reports done" yes "$(yesno test -e "$RUNNER_TEMP/dor-done")"
assert "…with its staged credentials deleted" no "$(yesno test -e "$TMP/cred")"

MAX_ATTEMPTS=8 CI_ROLLUP='["FAILURE"]' flow_continue 7; rc=$?
assert "continue at attempt 7 of 8 with CI still red: bails (exit 1)" 1 "$rc"
assert "…without a single extra fix run" 0 "$(wc -l < "$TMP/claude.log" | tr -d ' ')"
assert "…as out of attempts" yes "$(yesno grep -q 'still failing after 8 fix attempts' "$TMP/flow.out")"

rm -f "$CKPT"; mkdir -p "$TMP/cred"; printf 'x\n' > "$TMP/cred/board"
( export DOR_FLOW_MODE=continue DOR_CRED_DIR="$TMP/cred"; bash "$FLOW" ) > "$TMP/flow.out" 2>&1; rc=$?
assert "continue mode without a checkpoint bails instead of starting a build" 1 "$rc"
assert "…saying why" yes "$(yesno grep -q 'found no valid checkpoint' "$TMP/flow.out")"
assert "…and never reaches the agent" 0 "$(wc -l < "$TMP/claude.log" | tr -d ' ')"

# ── 11. The workflow runs a continuation exactly when the step before asked ─────────────────────────
job_steps() { awk '/^  build:/{b=1;next} b && /^  [a-z]/{exit} b' "$AGENT"; }
steps="$(job_steps)"
slots="$(printf '%s\n' "$steps" | grep -cE '^ +id: flow_c[0-9]+$')"
assert "the build job has six continuation slots" 6 "$slots"
assert "the main flow step runs through dor_flow_step.sh" yes \
  "$(yesno grep -qE 'run: bash "\$RUNNER_TEMP/dor-flow/dor_flow_step.sh" dor_build_flow.sh' <<< "$steps")"
assert "the main flow step starts with as many refreshes as there are slots" yes \
  "$(yesno grep -q "DOR_TOKEN_REFRESHES_LEFT: '6'" <<< "$steps")"
chain_ok=yes
for k in 1 2 3 4 5 6; do
  prev=flow; [ "$k" -gt 1 ] && prev="flow_c$((k-1))"
  # All three steps of slot k (mint, stage, run) must be gated on the previous flow step's output.
  n="$(printf '%s\n' "$steps" | grep -cF "if: steps.${prev}.outputs.needs-token == 'true'")"
  [ "$n" = 3 ] || { chain_ok="no (slot $k gated $n times on $prev)"; break; }
  printf '%s\n' "$steps" | grep -A12 -E "^ +id: flow_c${k}\$" | grep -q "DOR_TOKEN_REFRESHES_LEFT: '$((6-k))'" \
    || { chain_ok="no (slot $k refresh count)"; break; }
  printf '%s\n' "$steps" | grep -A12 -E "^ +id: flow_c${k}\$" | grep -q 'DOR_FLOW_MODE: continue' \
    || { chain_ok="no (slot $k not in continue mode)"; break; }
done
assert "each slot is gated on the step before it, counts down, and continues" yes "$chain_ok"
perms() { printf '%s\n' "$steps" | grep -A9 -E "^ +id: $1\$" | grep -E '^ +permission-' | sed 's/ *#.*//; s/^ *//' | sort | tr '\n' ' '; }
same=yes
for k in 1 2 3 4 5 6; do [ "$(perms "bot_c$k")" = "$(perms bot)" ] || { same="no (bot_c$k: $(perms "bot_c$k"))"; break; }; done
assert "every refresh mints with exactly the first token's permissions" yes "$same"
assert "no local action in the build job receives the private key" 0 \
  "$(printf '%s\n' "$steps" | grep -c 'uses: \./')"
assert "the staged-token cleanup runs after the last slot" yes \
  "$(yesno awk '/id: flow_c6/{s=1} s && /Remove any staged token/{f=1} END{exit !f}' <<< "$steps")"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

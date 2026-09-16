#!/usr/bin/env bash
# Keep a long build alive past the 1-hour life of its BOT app token, without bringing the app's
# private key onto the sidekick.
#
# Sourced by dor_build_lib.sh and dor_flow_step.sh; do NOT execute it. The workflow mints BOARD_TOKEN
# (the only credential that can push the branch, open the PR and move the board) and stages it as a
# file together with the time it was minted. An installation token lives one hour, and a build whose
# verify/fix loop ran past that failed its next push with `Invalid username or token` and
# dead-lettered to Exceptions (run 34821100296, #1202). Minting a new one needs the private key, and
# the agent runs as the same unix user as this flow (dor_agent_sandbox.sh is not a kernel boundary):
# a leaked 1-hour token is bounded, a leaked key is not. So the key stays in the workflow.
#
# Instead, before an action that needs the token, the flow checks its age. Past DOR_TOKEN_MAX_AGE
# it does not try: the work is already committed locally, so it writes a checkpoint under
# RUNNER_TEMP (where to resume — nothing secret) and exits DOR_NEEDS_TOKEN_RC. The workflow then
# mints a fresh token in a new step and re-runs the flow with DOR_FLOW_MODE=continue, which pushes
# the pending commit and picks up where it stopped. DOR_TOKEN_REFRESHES_LEFT is how many such steps
# the workflow still has; at 0 there is nobody to continue, so the flow bails instead of exiting
# into nothing.
#
# Opt-in by construction: without a staged mint time (the feedback flow, a direct invocation) the
# token's age is unknown and nothing here ever checkpoints — behaviour is exactly as before.

DOR_NEEDS_TOKEN_RC=75                              # EX_TEMPFAIL: "run me again with a fresh token"
DOR_TOKEN_MAX_AGE="${DOR_TOKEN_MAX_AGE:-3000}"     # 50 min: a 10-minute margin under the 1h expiry

dor_checkpoint_file()   { printf '%s' "${RUNNER_TEMP:-/tmp}/dor-checkpoint"; }
dor_supply_flags_file() { printf '%s' "${RUNNER_TEMP:-/tmp}/dor-supply-flags"; }
continue_mode()         { [ "${DOR_FLOW_MODE:-}" = continue ]; }

# Seconds since BOARD_TOKEN was minted. Fails when that is not known (no staged, numeric mint time).
board_token_age() {
  local minted="${BOARD_TOKEN_MINTED_AT:-}"
  case "$minted" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s' "$(( $(date +%s) - minted ))"
}

board_token_stale() {
  local age
  age="$(board_token_age)" || return 1
  [ "$age" -ge "$DOR_TOKEN_MAX_AGE" ]
}

# Record where to resume, then stop so the workflow can hand over a fresh token.
#   $1 = phase: push (the branch's first push, PR not opened yet) · verify (a fix commit inside
#        verify_loop) · pause (pause_and_exit's WIP push)   $2 = PR number   $3 = attempt   $4 = reason
# One key per line; values are single-line by construction (the reason is flattened).
checkpoint_and_exit() {
  local phase="$1" pr="${2:-}" attempt="${3:-0}" reason="${4:-}"
  if [ "${DOR_TOKEN_REFRESHES_LEFT:-0}" -le 0 ]; then
    bail "the BOT token expired and this run has no token refreshes left (phase ${phase}, attempt ${attempt}). The work up to here is committed on the sidekick but not pushed; re-dispatch the build to continue."
  fi
  {
    printf 'phase=%s\n'   "$phase"
    printf 'pr=%s\n'      "$pr"
    printf 'attempt=%s\n' "$attempt"
    printf 'branch=%s\n'  "$BRANCH"
    printf 'head=%s\n'    "$(git -C "$WORK" rev-parse HEAD 2>/dev/null)"
    printf 'reason=%s\n'  "$(printf '%s' "$reason" | tr '\r\n' '  ')"
  } > "$(dor_checkpoint_file)"
  echo "::notice::the BOT token is $(board_token_age)s old — checkpointed (${phase}, attempt ${attempt}) for a fresh token"
  exit "$DOR_NEEDS_TOKEN_RC"
}

# The branch push the flows make, refusing to spend a stale token on it. $1..$3 as checkpoint_and_exit.
push_or_checkpoint() {
  board_token_stale && checkpoint_and_exit "$1" "${2:-}" "${3:-0}"
  push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH"
}

# Read and CONSUME the checkpoint into CKPT_PHASE CKPT_PR CKPT_ATTEMPT CKPT_REASON. Parsed, never
# sourced — it is a file a same-user process could have written. Fails when it is missing, malformed,
# or does not describe this checkout's branch and HEAD.
read_checkpoint() {
  local file key value branch="" head=""
  file="$(dor_checkpoint_file)"
  [ -f "$file" ] || return 1
  CKPT_PHASE=""; CKPT_PR=""; CKPT_ATTEMPT=""; CKPT_REASON=""
  while IFS='=' read -r key value; do
    case "$key" in
      phase)   CKPT_PHASE="$value" ;;
      pr)      CKPT_PR="$value" ;;
      attempt) CKPT_ATTEMPT="$value" ;;
      branch)  branch="$value" ;;
      head)    head="$value" ;;
      reason)  CKPT_REASON="$value" ;;
    esac
  done < "$file"
  rm -f "$file"
  case "$CKPT_PHASE" in push|verify|pause) : ;; *) return 1 ;; esac
  case "$CKPT_ATTEMPT" in ''|*[!0-9]*) return 1 ;; esac
  case "$CKPT_PR" in *[!0-9]*) return 1 ;; esac
  [ "$CKPT_PHASE" != verify ] || [ -n "$CKPT_PR" ] || return 1
  [ "$branch" = "$BRANCH" ] || return 1
  [ "$head" = "$(git -C "$WORK" rev-parse HEAD 2>/dev/null)" ] || return 1
  return 0
}

# Continue mode: take the checkpoint and push what was left pending, with the fresh token. A `pause`
# checkpoint re-enters pause_and_exit, which pushes the WIP and exits. Otherwise returns with
# CKPT_PR / CKPT_ATTEMPT set for the caller to resume from; implement never runs again.
resume_from_checkpoint() {
  read_checkpoint || bail "a token-refresh continuation found no valid checkpoint for ${BRANCH} at $(git -C "$WORK" rev-parse --short HEAD 2>/dev/null) — cannot tell where the ${FLOW_NOUN} stopped"
  echo "::notice::continuing the ${FLOW_NOUN} with a fresh BOT token (phase ${CKPT_PHASE}, attempt ${CKPT_ATTEMPT}${CKPT_PR:+, PR #${CKPT_PR}})"
  [ "$CKPT_PHASE" = pause ] && pause_and_exit "$CKPT_REASON"
  guard_protected_paths
  push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH" \
    || bail "could not push ${BRANCH} after refreshing the BOT token (phase ${CKPT_PHASE}, attempt ${CKPT_ATTEMPT})"
  return 0
}

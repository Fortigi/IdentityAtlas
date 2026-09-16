#!/usr/bin/env bash
# Stage the DoR build flow's GitHub tokens as files, for load_flow_credentials (dor_agent_sandbox.sh).
#
# A step's env is the flow process's initial environment, which the agent it starts could read back
# from /proc; the flow loads these files into memory and deletes them before any agent runs. Run once
# before the flow, and again before each token-refresh continuation (dor_token_checkpoint.sh) — so
# the mint time recorded here is how old THAT step's BOARD_TOKEN is. It is taken right after the mint
# step, which errs young by the few seconds in between; the flow's 10-minute margin under the 1h
# expiry absorbs that.
#
#   Env: GH_TOKEN BOARD_TOKEN RUNNER_TEMP
set -euo pipefail
umask 077
d="$RUNNER_TEMP/dor-cred"; rm -rf "$d"; mkdir -p "$d"
printf '%s\n' "$GH_TOKEN" > "$d/gh"
printf '%s\n' "$BOARD_TOKEN" > "$d/board"
date +%s > "$d/board-minted-at"

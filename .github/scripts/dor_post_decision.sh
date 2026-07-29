#!/usr/bin/env bash
# Deterministic POST step shared by the DoR agents (feature + bug) — the ONLY place an agent's
# output reaches GitHub. It validates the model-chosen route against a fixed allow-list, scans the
# output for any leaked token (egress filter), then posts the comment, sets exactly one state:*
# label (removing the others), and syncs the board Status via dor_set_status.sh (board-scoped BOT
# token, never the model's).
#
# MUST run AFTER `git restore --source=HEAD … .github`, so this file and dor_set_status.sh are the
# committed versions — closing the "model overwrites the helper, post step executes it" escalation.
#
#   Env (required): GH_TOKEN     — github.token; posts the comment + sets the label.
#                   BOARD_TOKEN  — a token with org Projects: write; used ONLY for the board sync.
#                   ISSUE, REPO  — the target issue number and owner/repo.
#   Env (optional): OAUTH_TOKEN  — the model's subscription token; scanned for, never used to auth.
#                   PROJECT_ID / STATUS_FIELD_ID / REQ_* — pass through to dor_set_status.sh; default
#                   to the Feature board, override for the Bug board.
set -euo pipefail

: "${ISSUE:?dor_post_decision: ISSUE required}"
: "${REPO:?dor_post_decision: REPO required}"
: "${GH_TOKEN:?dor_post_decision: GH_TOKEN required}"
: "${BOARD_TOKEN:?dor_post_decision: BOARD_TOKEN required}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
comment=".dor/out/comment.md"
routefile=".dor/out/route.txt"
route="$(tr -d '[:space:]' < "$routefile" 2>/dev/null || true)"

# 1. Route must be exactly one allowed state label (or 'none' = take no action this run).
case "$route" in
  none|"")
    echo "::notice::Agent chose no action this run."; exit 0 ;;
  state:awaiting-requestor|state:awaiting-design|state:decompose|state:blocked-external|state:out-of-pipeline|state:awaiting-approval)
    : ;;
  *)
    echo "::error::Agent returned an invalid route '${route}' — refusing to act."; exit 1 ;;
esac

# 2. Egress filter: never post if the agent output contains ANY live token reachable in the
#    reasoning step's env — the subscription token OR the injected github.token.
for secret in "${OAUTH_TOKEN:-}" "${GH_TOKEN:-}"; do
  [ -n "$secret" ] || continue
  if grep -qF -- "$secret" "$comment" "$routefile" 2>/dev/null; then
    echo "::error::Agent output contains a live token — aborting (possible injection)."; exit 1
  fi
done

if [ ! -s "$comment" ]; then echo "::error::No comment body produced."; exit 1; fi

# 3. Post the comment, then set exactly one state:* label (remove all the others).
gh issue comment "$ISSUE" --repo "$REPO" --body-file "$comment"
all="state:awaiting-requestor state:awaiting-design state:ready-to-probe state:awaiting-approval state:decompose state:blocked-external state:out-of-pipeline"
remove=""
for l in $all; do [ "$l" != "$route" ] && remove="${remove:+$remove,}$l"; done
gh issue edit "$ISSUE" --repo "$REPO" --add-label "$route" --remove-label "$remove"

# Sync the board Status to the chosen route (board-scoped BOT token, NOT the model's). The target
# board is whichever PROJECT_ID / STATUS_FIELD_ID are in env (Feature board by default).
GH_TOKEN="$BOARD_TOKEN" bash "$here/dor_set_status.sh" "$ISSUE" "$route"

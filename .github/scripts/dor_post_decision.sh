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
#                   BOARD_TOKEN  — a BOT app token with org Projects: write + Issues: write; used for
#                                  the board sync, and for the one label write that must cascade (below).
#                   ISSUE, REPO  — the target issue number and owner/repo.
#   Env (optional): OAUTH_TOKEN  — the model's subscription token; scanned for, never used to auth.
#                   PROJECT_ID / STATUS_FIELD_ID / REQ_* — pass through to dor_set_status.sh. Leave
#                   unset: it picks the board from the issue's own labels (bug → Bug Pipeline).
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
contract=".dor/out/contract.json"
for secret in "${OAUTH_TOKEN:-}" "${GH_TOKEN:-}"; do
  [ -n "$secret" ] || continue
  if grep -qF -- "$secret" "$comment" "$routefile" "$contract" 2>/dev/null; then
    echo "::error::Agent output contains a live token — aborting (possible injection)."; exit 1
  fi
done

# 2b. Certifying a bug means the next thing that happens is a machine changing code, so the verdict
# has to be checkable, not just readable. Require the repro contract on that route and validate its
# shape here — a malformed one fails the run rather than certifying on prose alone.
if [ "${REQUIRE_CONTRACT:-}" = true ] && [ "$route" = state:awaiting-approval ]; then
  [ -s "$contract" ] || { echo "::error::certified #$ISSUE without .dor/out/contract.json — refusing to certify on prose alone."; exit 1; }
  jq -e '
    (.symptom      | type == "string" and (length > 0)) and
    (.assertion    | type == "string" and (length > 0)) and
    (.root_cause   | type == "string" and (length > 0)) and
    (.repro_path   | type == "string" and (length > 0)) and
    (.blast_radius | type == "array"  and (length > 0) and all(.[]; type == "string" and (length > 0))) and
    (.test_tier    | . == "unit" or . == "api" or . == "e2e") and
    (.confidence   | . == "certain" or . == "likely")
  ' "$contract" >/dev/null 2>&1 \
    || { echo "::error::contract.json is malformed — see the schema in the agent prompt."; jq -c . "$contract" 2>/dev/null; exit 1; }

  # Carry it in the comment: the build side's only input is the issue thread, and a human reading the
  # verdict should be able to see exactly what the build will be held to.
  { printf '\n\n<details><summary>🔒 Repro contract — the build is measured against this</summary>\n\n```json\n'
    jq -S . "$contract"
    printf '```\n\n</details>\n'
  } >> "$comment"
fi

if [ ! -s "$comment" ]; then echo "::error::No comment body produced."; exit 1; fi

# 3. Post the comment, then set exactly one state:* label (remove all the others).
gh issue comment "$ISSUE" --repo "$REPO" --body-file "$comment"
all="state:awaiting-requestor state:awaiting-design state:ready-to-probe state:awaiting-approval state:decompose state:blocked-external state:out-of-pipeline"
remove=""
for l in $all; do [ "$l" != "$route" ] && remove="${remove:+$remove,}$l"; done
# `state:awaiting-approval` is the ONE route that must cascade: it triggers dor-propose-build.yml,
# which applies `ready-to-build` → dor-build-agent posts the "Review & approve to build" link and
# parks on the value gate. GitHub suppresses workflow triggers for events caused by GITHUB_TOKEN, so
# writing that label with github.token left the whole chain inert — certified issues (feature AND
# bug) sat in "Awaiting approval" with no way to approve. Write it as the BOT app so it fires.
# Every other route keeps github.token — nothing downstream listens for them, so there is no reason
# to widen who writes them. (dor-board-sync skips Bot senders, so this write never double-syncs.)
if [ "$route" = state:awaiting-approval ]; then
  GH_TOKEN="$BOARD_TOKEN" gh issue edit "$ISSUE" --repo "$REPO" --add-label "$route" --remove-label "$remove"
else
  gh issue edit "$ISSUE" --repo "$REPO" --add-label "$route" --remove-label "$remove"
fi

# Sync the board Status to the chosen route (board-scoped BOT token, NOT the model's). The target
# board is whichever PROJECT_ID / STATUS_FIELD_ID are in env (Feature board by default).
GH_TOKEN="$BOARD_TOKEN" bash "$here/dor_set_status.sh" "$ISSUE" "$route"

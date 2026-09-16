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
# 2>/dev/null on tr does not cover a missing routefile: the failed *redirect* is reported by the
# shell, not by tr, so an absent file printed a bare "line 28: .dor/out/route.txt: No such file or
# directory" into the run log. That line was the only visible trace of the #1132 class of failure,
# and it reads like a bug in this script rather than a missing agent decision. Test for the file.
route=""
[ -f "$routefile" ] && route="$(tr -d '[:space:]' < "$routefile")"

# 1. Route must be exactly one allowed state label (or 'none' = take no action this run).
case "$route" in
  none)
    echo "::notice::Agent chose no action this run."; exit 0 ;;
  "")
    # NOT the same as `none`. `none` is a decision the model wrote down; an empty or missing
    # route.txt means the reasoning step finished WITHOUT writing one. The two used to share this
    # branch, so a run that reasoned for 12 turns and $3.64 (#1132) exited 0 with a notice: green
    # check, no comment, no label, and an issue left in its entry column looking as though a human
    # had been asked something. The hourly sweep then reported it as "the agent likely never ran".
    # The reasoning is lost either way; only a red run says so.
    echo "::error::Agent wrote no .dor/out/route.txt — the reasoning step produced no decision for #${ISSUE}. Nothing was posted; re-run it by editing the issue or commenting on it."
    exit 1 ;;
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

# Mark every agent comment invisibly first. Any sweep that wants to tell "still waiting on a person"
# apart from "the pipeline dropped this thread" has to answer "did the AGENT speak last, or a human?"
# — and authorship cannot answer it. This posts under whichever account owns GH_TOKEN, and for most
# of the pipeline's life that was a maintainer's own: the last comments on #762 and #680 read as
# WimvandenHeijkant and are agent output. An HTML comment renders as nothing, survives edits, and is
# the same trick the health issue's dor-fingerprint already uses.
printf '\n\n<!-- dor-agent-comment route:%s -->\n' "$route" >> "$comment"

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
  # Adding a label the issue ALREADY carries is a no-op: GitHub emits no `labeled` event, so the
  # cascade never fires and the pipeline silently dead-ends. That is exactly what a RE-certification
  # looks like — the issue is already awaiting approval, the probe confirms it again, and nothing
  # happens (it stranded #927 and #943). Force the transition so the event always exists.
  # `// empty` matters: gh prints a bare newline for a null jq result, so a "not null" text test
  # reports every issue as already-labelled.
  if [ -n "$(gh issue view "$ISSUE" --repo "$REPO" --json labels \
             --jq '[.labels[].name] | index("'"$route"'") // empty' 2>/dev/null)" ]; then
    GH_TOKEN="$BOARD_TOKEN" gh issue edit "$ISSUE" --repo "$REPO" --remove-label "$route" >/dev/null 2>&1 || true
    echo "::notice::#$ISSUE was already $route — re-applying it so the value-gate cascade fires"
  fi
  GH_TOKEN="$BOARD_TOKEN" gh issue edit "$ISSUE" --repo "$REPO" --add-label "$route" --remove-label "$remove"
else
  gh issue edit "$ISSUE" --repo "$REPO" --add-label "$route" --remove-label "$remove"
fi

# Consume the reconcile re-dispatch marker — the agent has produced a decision, so this retry is
# over. Left in place when the run FAILS, on purpose: it is then both the visible record that the
# issue is being re-driven and, through its timeline events, the budget that stops it being
# re-driven for ever. Removing a label that is not there is a no-op.
gh issue edit "$ISSUE" --repo "$REPO" --remove-label dor-retry >/dev/null 2>&1 || true

# Sync the board Status to the chosen route (board-scoped BOT token, NOT the model's). The target
# board is whichever PROJECT_ID / STATUS_FIELD_ID are in env (Feature board by default).
GH_TOKEN="$BOARD_TOKEN" bash "$here/dor_set_status.sh" "$ISSUE" "$route"

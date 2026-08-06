#!/usr/bin/env bash
# Set the board Status for an issue on the right DoR pipeline board, from a state:* label or a
# build-side phase token. Idempotent — adds the issue to the board if it isn't there yet.
#
#   Usage:  dor_set_status.sh <issue-number> <state-label>
#   Env:    GH_TOKEN  — a token with Organization Projects: write (mint from the fortigi-ci-bot app).
#           REQ_BY_ACTOR (optional) — a GitHub login; if it matches a "Requested by" option, set it.
#           OWNER / REPO have working defaults.
#           PROJECT_ID (optional) — pin ONE board regardless of the issue. Only a caller that sweeps
#           a board (dor_reconcile.sh) should set it; everyone else lets the issue choose.
#           STATUS_FIELD_ID / REQ_FIELD_ID (optional) — pin a field id instead of resolving it.
#
# THE BOARD FOLLOWS THE ISSUE. Bugs live on the Bug Pipeline (#3), everything else on the Feature
# Pipeline (#2), and this script reads the issue's own labels to decide. That resolution lives here,
# at the source, because it is otherwise needed at ~9 call sites across the build, feedback,
# acceptance and reset flows — none of which had it, so every build-side move went to the Feature
# board and would have silently ADDED a bug to the wrong board (the item lookup below creates one).
#
# Nothing per-board is pinned except the two project ids: single-select FIELD ids and OPTION ids
# both differ per board and regenerate when a field is edited, so both are resolved by NAME at
# runtime. A pinned STATUS_FIELD_ID is exactly how a caller ends up writing the Feature board's
# field onto a Bug board item.
set -euo pipefail

ISSUE="${1:?usage: dor_set_status.sh <issue-number> <state-label>}"
LABEL="${2:?usage: dor_set_status.sh <issue-number> <state-label>}"
OWNER="${OWNER:-Fortigi}"
REPO="${REPO:-IdentityAtlas}"
# Accept an owner-qualified REPO (GitHub Actions' github.repository is "owner/name"). Callers that
# also `gh --repo "$REPO"` pass the qualified form, so split it — otherwise the GraphQL
# repository(owner,name) lookup below gets name="owner/name" and 404s ("owner/owner/name").
if [[ "$REPO" == */* ]]; then OWNER="${REPO%%/*}"; REPO="${REPO##*/}"; fi

FEATURE_PROJECT_ID="PVT_kwDOAhfTz84Bern-"   # IdentityAtlas — Feature Pipeline (org project #2)
BUG_PROJECT_ID="PVT_kwDOAhfTz84BezXo"       # IdentityAtlas — Bug Pipeline   (org project #3)

# state:* label (spec side) OR a build-side phase token -> board Status column name.
case "$LABEL" in
  state:awaiting-requestor) STATUS_NAME="Awaiting requestor" ;;
  state:awaiting-design)    STATUS_NAME="Awaiting design" ;;
  state:ready-to-probe)     STATUS_NAME="Ready for AI probe" ;;
  state:awaiting-approval)  STATUS_NAME="Awaiting approval" ;;
  state:decompose)          STATUS_NAME="Decompose" ;;
  state:blocked-external)   STATUS_NAME="Blocked (external)" ;;
  state:out-of-pipeline)    STATUS_NAME="Out of pipeline" ;;
  # Build side (set directly by the build workflows, not via a state:* label):
  building)                 STATUS_NAME="Building" ;;
  build-done)               STATUS_NAME="Awaiting functional acceptance" ;;
  awaiting-merge)           STATUS_NAME="Awaiting merge" ;;
  done)                     STATUS_NAME="Done" ;;
  paused)                   STATUS_NAME="Paused" ;;       # hit a usage limit; dor-resume re-dispatches
  exception)                STATUS_NAME="Exceptions" ;;   # dead-letter: broke somewhere in the pipeline
  *) echo "::error::dor_set_status: unknown phase token '$LABEL'"; exit 1 ;;
esac

# Issue node id + "is it a bug?" in ONE call — the labels choose the board. Everything here goes
# through gh's built-in --jq, so the script keeps its zero external dependencies (no `jq` binary).
# (Command substitution, not process substitution: `set -e` must still abort on a failed gh call.)
issue_row="$(gh api graphql \
  -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ id labels(first:50){ nodes{ name } } } } }' \
  -f o="$OWNER" -f r="$REPO" -F n="$ISSUE" \
  --jq '.data.repository.issue | [(.id // ""), (([.labels.nodes[].name] | index("bug")) != null)] | @tsv')"
IFS=$'\t' read -r issue_node is_bug <<<"$issue_row"
[ -n "${issue_node:-}" ] || { echo "::error::issue #$ISSUE not found"; exit 1; }

if [ -n "${PROJECT_ID:-}" ]; then
  BOARD="pinned board"
elif [ "$is_bug" = true ]; then
  PROJECT_ID="$BUG_PROJECT_ID"; BOARD="Bug Pipeline"
else
  PROJECT_ID="$FEATURE_PROJECT_ID"; BOARD="Feature Pipeline"
fi

# Resolve a single-select field id + one of its option ids, both by NAME, on the chosen board.
# Deliberately lists the fields and selects by name in jq rather than asking for field(name:) —
# GitHub answers a *missing* named field with a NOT_FOUND GraphQL error (non-zero exit, raw error
# body on stdout), which under `set -e` would abort the run. Listing turns "this board has no such
# field" into an ordinary empty result, which is what the Bug board's absent "Requested by" is.
field_and_option() {  # $1 = field name, $2 = option name -> "<field-id>\t<option-id>"
  gh api graphql \
    -f query='query($p:ID!){ node(id:$p){ ... on ProjectV2 { fields(first:50){ nodes{ ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }' \
    -f p="$PROJECT_ID" \
    --jq "([.data.node.fields.nodes[]? | select(.name==\"$1\")][0] // {}) | [(.id // \"\"), (([.options[]? | select(.name==\"$2\")][0].id) // \"\")] | @tsv"
}

status_row="$(field_and_option "Status" "$STATUS_NAME")"
IFS=$'\t' read -r status_field status_opt <<<"$status_row"
status_field="${STATUS_FIELD_ID:-$status_field}"
[ -n "${status_field:-}" ] || { echo "::error::no Status field on the $BOARD"; exit 1; }
[ -n "${status_opt:-}" ] || { echo "::error::no Status option named '$STATUS_NAME' on the $BOARD"; exit 1; }

item_id="$(gh api graphql \
  -f query='query($id:ID!){ node(id:$id){ ... on Issue { projectItems(first:50){ nodes{ id project{ id } } } } } }' \
  -f id="$issue_node" \
  --jq "[.data.node.projectItems.nodes[] | select(.project.id==\"$PROJECT_ID\") | .id][0] // empty")"

if [ -z "$item_id" ]; then
  item_id="$(gh api graphql \
    -f query='mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }' \
    -f p="$PROJECT_ID" -f c="$issue_node" --jq '.data.addProjectV2ItemById.item.id')"
fi

# Set a single-select field value on the item.
set_field() {  # $1 = field id, $2 = option id
  gh api graphql \
    -f query='mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }' \
    -f p="$PROJECT_ID" -f i="$item_id" -f f="$1" -f o="$2" >/dev/null
}

set_field "$status_field" "$status_opt"
echo "::notice::issue #$ISSUE Status → '$STATUS_NAME' (${BOARD})"

# Optional: set "Requested by" if provided and it matches an existing option (D2 — only 5 exist).
if [ -n "${REQ_BY_ACTOR:-}" ]; then
  req_row="$(field_and_option "Requested by" "$REQ_BY_ACTOR")"   # field absent on a board → empty
  IFS=$'\t' read -r req_field req_opt <<<"$req_row"
  req_field="${REQ_FIELD_ID:-$req_field}"
  if [ -n "${req_field:-}" ] && [ -n "${req_opt:-}" ]; then
    set_field "$req_field" "$req_opt"
    echo "::notice::issue #$ISSUE Requested by → '$REQ_BY_ACTOR'"
  else
    echo "::notice::no 'Requested by' option for '$REQ_BY_ACTOR' on the $BOARD — left blank (D2)."
  fi
fi

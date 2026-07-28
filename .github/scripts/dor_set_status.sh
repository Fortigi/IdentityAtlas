#!/usr/bin/env bash
# Set the board Status for an issue on the "IdentityAtlas — Feature Pipeline" org project (#2),
# from a state:* label. Idempotent — adds the issue to the board if it isn't there yet.
#
#   Usage:  dor_set_status.sh <issue-number> <state-label>
#   Env:    GH_TOKEN  — a token with Organization Projects: write (mint from the fortigi-ci-bot app).
#           REQ_BY_ACTOR (optional) — a GitHub login; if it matches a "Requested by" option, set it.
#           OWNER / REPO / PROJECT_ID / STATUS_FIELD_ID / REQ_FIELD_ID have working defaults.
#
# Single-select OPTION ids regenerate whenever the field's options are edited, so we resolve them
# by NAME at runtime. PROJECT_ID and the FIELD ids are stable and safe to pin.
set -euo pipefail

ISSUE="${1:?usage: dor_set_status.sh <issue-number> <state-label>}"
LABEL="${2:?usage: dor_set_status.sh <issue-number> <state-label>}"
OWNER="${OWNER:-Fortigi}"
REPO="${REPO:-IdentityAtlas}"
PROJECT_ID="${PROJECT_ID:-PVT_kwDOAhfTz84Bern-}"
STATUS_FIELD_ID="${STATUS_FIELD_ID:-PVTSSF_lADOAhfTz84Bern-zhZEAac}"
REQ_FIELD_ID="${REQ_FIELD_ID:-PVTSSF_lADOAhfTz84Bern-zhZEFTM}"

# state:* label -> board Status column name.
case "$LABEL" in
  state:awaiting-requestor) STATUS_NAME="Awaiting requestor" ;;
  state:awaiting-design)    STATUS_NAME="Awaiting design" ;;
  state:ready-to-probe)     STATUS_NAME="Ready for AI probe" ;;
  state:awaiting-approval)  STATUS_NAME="Awaiting approval" ;;
  state:decompose)          STATUS_NAME="Decompose" ;;
  state:blocked-external)   STATUS_NAME="Blocked (external)" ;;
  state:out-of-pipeline)    STATUS_NAME="Out of pipeline" ;;
  *) echo "::error::dor_set_status: unknown state label '$LABEL'"; exit 1 ;;
esac

# Resolve a single-select option id by field name + option name.
option_id_for() {  # $1 = field name, $2 = option name
  gh api graphql \
    -f query='query($p:ID!,$f:String!){ node(id:$p){ ... on ProjectV2 { field(name:$f){ ... on ProjectV2SingleSelectField { options { id name } } } } } }' \
    -f p="$PROJECT_ID" -f f="$1" \
    --jq "(.data.node.field.options // [])[] | select(.name==\"$2\") | .id"
}

status_opt="$(option_id_for "Status" "$STATUS_NAME")"
[ -n "$status_opt" ] || { echo "::error::no Status option named '$STATUS_NAME'"; exit 1; }

issue_node="$(gh api graphql \
  -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ id } } }' \
  -f o="$OWNER" -f r="$REPO" -F n="$ISSUE" --jq '.data.repository.issue.id')"
[ -n "$issue_node" ] || { echo "::error::issue #$ISSUE not found"; exit 1; }

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

set_field "$STATUS_FIELD_ID" "$status_opt"
echo "::notice::issue #$ISSUE Status → '$STATUS_NAME'"

# Optional: set "Requested by" if provided and it matches an existing option (D2 — only 5 exist).
if [ -n "${REQ_BY_ACTOR:-}" ]; then
  req_opt="$(option_id_for "Requested by" "$REQ_BY_ACTOR" || true)"   # best-effort (D2); never fail the run
  if [ -n "$req_opt" ]; then
    set_field "$REQ_FIELD_ID" "$req_opt"
    echo "::notice::issue #$ISSUE Requested by → '$REQ_BY_ACTOR'"
  else
    echo "::notice::no 'Requested by' option for '$REQ_BY_ACTOR' — left blank (D2)."
  fi
fi

#!/usr/bin/env bash
# Move every pipeline issue a MERGED PR closes to Done, whatever branch the PR came from.
#
#   Usage:  dor_finalize_merged_pr.sh <pr-number>
#   Env:    GH_TOKEN — a token that can READ org projects and WRITE board Status (the BOT app token).
#           OWNER / REPO have working defaults; REPO may be owner-qualified.
#           SET_STATUS (optional) — the status writer to call; defaults to dor_set_status.sh.
#
# dor-reset's finalize job only knows the build's own `dor/issue-N` head branch. A fix that lands
# through any other branch — a hand-made `bugfixes/*` PR saying "Closes #N" — closed the issue but
# left its card at "Awaiting merge": #1046, #1047 and #1162 all sat there after their PRs merged.
# GitHub already records which issues a PR closes, so ask it instead of parsing a branch name.
#
# Only issues ALREADY on a DoR board are moved. dor_set_status.sh adds an issue to the board when it
# is missing, and a merged PR closing some unrelated housekeeping issue must not drop it onto one.
set -euo pipefail

PR="${1:?usage: dor_finalize_merged_pr.sh <pr-number>}"
OWNER="${OWNER:-Fortigi}"
REPO="${REPO:-IdentityAtlas}"
if [[ "$REPO" == */* ]]; then OWNER="${REPO%%/*}"; REPO="${REPO##*/}"; fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SET_STATUS="${SET_STATUS:-$SCRIPT_DIR/dor_set_status.sh}"

# Must match dor_set_status.sh's FEATURE_PROJECT_ID / BUG_PROJECT_ID.
DOR_BOARDS='["PVT_kwDOAhfTz84Bern-","PVT_kwDOAhfTz84BezXo"]'

# One issue number per line: closed by this PR, on a DoR board, and not yet Done there.
pending="$(gh api graphql \
  -f query='query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){
      closingIssuesReferences(first:25){ nodes{ number
        projectItems(first:20){ nodes{ project{ id }
          status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } } } }' \
  -f o="$OWNER" -f r="$REPO" -F n="$PR" \
  --jq "${DOR_BOARDS} as \$boards
        | .data.repository.pullRequest.closingIssuesReferences.nodes[]
        | select([.projectItems.nodes[] | select(.project.id as \$p | any(\$boards[]; . == \$p))
                  | select((.status.name // \"\") != \"Done\")] | length > 0)
        | .number")"

if [ -z "$pending" ]; then
  echo "::notice::PR #${PR} closes no pipeline issue that still needs moving to Done."
  exit 0
fi

rc=0
while IFS= read -r issue; do
  [ -n "$issue" ] || continue
  if bash "$SET_STATUS" "$issue" done; then
    echo "::notice::issue #${issue} → Done (PR #${PR} merged)."
  else
    echo "::warning::could not move issue #${issue} to Done — the reconcile sweep will flag it."
    rc=1
  fi
done <<<"$pending"
exit "$rc"

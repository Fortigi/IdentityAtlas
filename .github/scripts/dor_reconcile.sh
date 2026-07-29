#!/usr/bin/env bash
# DoR pipeline reconcile sweep — the level-triggered backstop for the event-based DoR automation.
# Re-derives desired state from actual state: HEALS the unambiguous cases (an open feature not on the
# board) and FLAGS everything else (drift, un-routed, stale, backlog, closed-but-active) into a single
# "DoR pipeline health" issue. Deterministic — no LLM. Idempotent. Exception-only (silent when healthy).
#
#   Env: GH_TOKEN — a token with org Projects: write + Issues: write (mint from fortigi-ci-bot).
#        OWNER / REPO / PROJECT_ID and the day/hour thresholds have working defaults.
#
# NOTE: Status is the canonical phase (D3), so this sweep never overwrites a human's Status from a
# (possibly stale) label — a Status≠label disagreement is FLAGGED for a human, not auto-"healed".
set -euo pipefail

OWNER="${OWNER:-Fortigi}"
REPO="${REPO:-IdentityAtlas}"
# Accept an owner-qualified REPO (github.repository = "owner/name"); split so `--repo "$OWNER/$REPO"`
# below doesn't become "owner/owner/name". Same guard as dor_set_status.sh.
if [[ "$REPO" == */* ]]; then OWNER="${REPO%%/*}"; REPO="${REPO##*/}"; fi
PROJECT_ID="${PROJECT_ID:-PVT_kwDOAhfTz84Bern-}"
UNROUTED_HOURS="${UNROUTED_HOURS:-6}"
STALE_FLAG_DAYS="${STALE_FLAG_DAYS:-14}"
HEALTH_TITLE="${HEALTH_TITLE:-DoR pipeline health}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
now="$(date -u +%s)"
exceptions=""   # markdown bullet lines
add_ex() { exceptions="${exceptions}- ${1}"$'\n'; }

# state:* label -> Status column name (must match dor_set_status.sh + the board options).
label_to_status() {
  case "$1" in
    state:awaiting-requestor) echo "Awaiting requestor" ;;
    state:awaiting-design)    echo "Awaiting design" ;;
    state:ready-to-probe)     echo "Ready for AI probe" ;;
    state:awaiting-approval)  echo "Awaiting approval" ;;
    state:decompose)          echo "Decompose" ;;
    state:blocked-external)   echo "Blocked (external)" ;;
    state:out-of-pipeline)    echo "Out of pipeline" ;;
    *) echo "" ;;
  esac
}

# 1. Board snapshot: one TSV line per item -> "<issue-number>\t<CLOSED|OPEN>\t<Status name>".
#    65 items today; first:100 covers it. Warn (don't silently truncate) if it ever overflows.
board="$(gh api graphql \
  -f query='query($p:ID!){ node(id:$p){ ... on ProjectV2 { items(first:100){
      pageInfo{ hasNextPage }
      nodes{ content{ ... on Issue { number state } }
             status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }' \
  -f p="$PROJECT_ID" \
  --jq '.data.node.items as $i
        | (if $i.pageInfo.hasNextPage then "::warn-truncated::\t\t\n" else "" end)
        + ([$i.nodes[] | select(.content.number != null)
            | [(.content.number|tostring), .content.state, (.status.name // "")] | @tsv] | join("\n"))')"

if printf '%s\n' "$board" | grep -q '^::warn-truncated::'; then
  add_ex "⚠️ Board has >100 items — reconcile only inspected the first 100. Add pagination."
  board="$(printf '%s\n' "$board" | grep -v '^::warn-truncated::')"
fi

# Look up an issue's board Status by number (empty if not on the board).
board_status_of() { printf '%s\n' "$board" | awk -F'\t' -v n="$1" '$1==n {print $3; found=1} END{exit !found}' 2>/dev/null || true; }
on_board()        { printf '%s\n' "$board" | awk -F'\t' -v n="$1" '$1==n {f=1} END{exit !f}'; }

# 2. Walk every OPEN enhancement issue. Capture the list first so a transient failure aborts under
#    set -e rather than silently reporting "healthy"; state_label is LAST so an empty label (the
#    common case) is a trailing field that `read` strips cleanly instead of shifting the columns.
issues_tsv="$(gh issue list --repo "$OWNER/$REPO" --state open --label enhancement --limit 201 \
  --json number,labels,createdAt,updatedAt \
  --jq '.[] | [(.number|tostring),
               (.createdAt | fromdateiso8601 | tostring),
               (.updatedAt | fromdateiso8601 | tostring),
               ([.labels[].name | select(startswith("state:"))][0] // "")] | @tsv')"
if [ "$(printf '%s' "$issues_tsv" | grep -c .)" -ge 201 ]; then
  add_ex "⚠️ Over 200 open enhancement issues — reconcile inspected only the first 200; add pagination."
  issues_tsv="$(printf '%s\n' "$issues_tsv" | head -n 200)"
fi
approval_backlog=0
while IFS=$'\t' read -r num created_epoch updated_epoch state_label; do
  [ -n "$num" ] || continue
  status="$(board_status_of "$num")"

  if ! on_board "$num"; then
    # HEAL: a feature issue that never made it onto the board (triage missed / failed).
    target_label="${state_label:-state:awaiting-requestor}"
    if REQ_BY_ACTOR="" bash "$SCRIPT_DIR/dor_set_status.sh" "$num" "$target_label" >/dev/null 2>&1; then
      add_ex "🩹 Healed: added #${num} to the board (Status → $(label_to_status "$target_label"))."
    else
      add_ex "❌ #${num} is missing from the board and could not be added automatically — add it by hand."
    fi
    continue
  fi

  if [ -z "$state_label" ]; then
    # FLAG: on the board but never routed. If old enough, the agent probably never ran.
    age_h=$(( (now - created_epoch) / 3600 ))
    if [ "$age_h" -ge "$UNROUTED_HOURS" ]; then
      add_ex "🕳️ #${num} is on the board (Status: ${status:-none}) with no \`state:*\` label after ${age_h}h — the agent likely never ran."
    fi
    continue
  fi

  # FLAG: Status ≠ label (human moved one, not the other; or a write failed). Human resolves.
  # (blank $status with a label set is the "Status write failed" case — flag it too.)
  expected="$(label_to_status "$state_label")"
  if [ -n "$expected" ] && [ "$status" != "$expected" ]; then
    add_ex "🔀 #${num} drift: label \`${state_label}\` (→ ${expected}) but board Status is **${status:-<unset>}**."
  fi

  # FLAG: stale waiting on a human.
  case "$status" in
    "Awaiting requestor"|"Awaiting design")
      age_d=$(( (now - updated_epoch) / 86400 ))
      [ "$age_d" -ge "$STALE_FLAG_DAYS" ] && add_ex "⏳ #${num} has sat in **${status}** for ${age_d}d with no update."
      ;;
    "Awaiting approval") approval_backlog=$(( approval_backlog + 1 )) ;;
  esac
done < <(printf '%s\n' "$issues_tsv")

[ "$approval_backlog" -gt 0 ] && add_ex "🚦 ${approval_backlog} issue(s) waiting in **Awaiting approval** — the Product board's value gate."

# 3. Closed issues still parked in a non-terminal board Status.
while IFS=$'\t' read -r num istate status; do
  [ "$istate" = "CLOSED" ] || continue
  case "$status" in ""|"Done") : ;; *) add_ex "🔚 #${num} is CLOSED but still on the board as **${status}** — move it to Done or off the board." ;; esac
done < <(printf '%s\n' "$board")

# 4. Publish the health report (exception-only): find or create the tracking issue, update its body.
# Immediately-consistent REST list (NOT --search, whose index lag would spawn duplicate health issues).
health_num="$(gh issue list --repo "$OWNER/$REPO" --state all --limit 100 \
  --json number,title --jq "[.[] | select(.title==\"$HEALTH_TITLE\") | .number][0] // empty")"

stamp="$(date -u +'%Y-%m-%d %H:%M UTC')"
if [ -z "$exceptions" ]; then
  body="_Last swept ${stamp}: ✅ pipeline healthy — nothing stuck or drifted._"
else
  body="$(printf '_Last swept %s — %s item(s) need attention:_\n\n%s' "$stamp" "$(printf '%s' "$exceptions" | grep -c '^- ')" "$exceptions")"
fi

if [ -n "$health_num" ]; then
  gh issue edit "$health_num" --repo "$OWNER/$REPO" --body "$body" >/dev/null
  if [ -n "$exceptions" ]; then
    # Something to act on — surface it (reopen if closed, comment so it hits notifications).
    gh issue reopen "$health_num" --repo "$OWNER/$REPO" >/dev/null 2>&1 || true
    gh issue comment "$health_num" --repo "$OWNER/$REPO" --body "$body" >/dev/null
  else
    # Healthy — close it so it stays out of the way until the next issue arises.
    gh issue close "$health_num" --repo "$OWNER/$REPO" >/dev/null 2>&1 || true
  fi
  echo "::notice::updated health issue #${health_num}"
elif [ -n "$exceptions" ]; then
  # No state:* / enhancement label — this meta issue must not enter the pipeline or the board.
  gh issue create --repo "$OWNER/$REPO" --title "$HEALTH_TITLE" --body "$body" >/dev/null
  echo "::notice::created health issue"
else
  echo "::notice::pipeline healthy; no health issue needed yet"
fi

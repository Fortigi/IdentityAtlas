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
LABEL="${LABEL:-enhancement}"                 # gate label for this pipeline (enhancement | bug)
UNROUTED_HOURS="${UNROUTED_HOURS:-6}"
STALE_FLAG_DAYS="${STALE_FLAG_DAYS:-14}"
# An ACTIVE phase is measured in minutes, not days. A build that dies 15 minutes in used to be
# invisible for a fortnight, because STALE_FLAG_DAYS was the only staleness check and the two records
# this sweep compares — issue labels and board Status — agreed with each other perfectly while the
# actual work was dead. The grace window only has to outlast the gap between the trigger event and a
# runner picking the job up.
ACTIVE_STALL_MIN="${ACTIVE_STALL_MIN:-20}"
HEALTH_TITLE="${HEALTH_TITLE:-DoR pipeline health}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
now="$(date -u +%s)"
exceptions=""   # markdown bullet lines
stalled=""      # issue numbers whose "Building" has no live run behind it
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

# Every DoR workflow run that is still alive (queued / in_progress / waiting-on-a-gate). For an
# `issues`-triggered run, display_title IS the issue title — the only correlation GitHub exposes
# between a run and the issue that started it. Fetched once; the lookup below is a string match.
# Reading Actions needs `actions: read`, which the BOT app is not granted — the job's own
# GITHUB_TOKEN carries it instead (RUNS_TOKEN), falling back to GH_TOKEN when run by hand.
# Query BY STATUS, never "the latest 100 runs then filter": a run parked at the value gate can be
# hours old and would fall out of that window, so a perfectly healthy build reads as dead. Waiting on
# a human IS alive — that is a gate, not a stall.
live_titles=""; live_ok=1
for st in in_progress queued waiting; do
  if t="$(GH_TOKEN="${RUNS_TOKEN:-$GH_TOKEN}" gh api "repos/$OWNER/$REPO/actions/runs?status=${st}&per_page=100" \
       --jq '.workflow_runs[]? | select(.path | test("dor-")) | .display_title' 2>/dev/null)"; then
    live_titles="${live_titles}${t}"$'\n'
  else
    live_ok=0
  fi
done
[ "$live_ok" = 1 ] || add_ex "⚠️ Could not read Actions runs — the liveness check was skipped this sweep, so a dead build would go unnoticed."

# Is anything actually running for this issue? Fails SAFE in every direction: if the run list or the
# title lookup is unavailable we answer "alive", because a false "your build is dead" alarm on a
# healthy build costs more trust than one late alarm on a dead one.
has_live_run() {  # $1 = issue number
  local title
  [ "$live_ok" = 1 ] || return 0
  title="$(gh issue view "$1" --repo "$OWNER/$REPO" --json title --jq .title 2>/dev/null)" || return 0
  [ -n "$title" ] || return 0
  printf '%s\n' "$live_titles" | grep -qxF "$title"
}

# Look up an issue's board Status by number (empty if not on the board).
board_status_of() { printf '%s\n' "$board" | awk -F'\t' -v n="$1" '$1==n {print $3; found=1} END{exit !found}' 2>/dev/null || true; }
on_board()        { printf '%s\n' "$board" | awk -F'\t' -v n="$1" '$1==n {f=1} END{exit !f}'; }

# Is this board Status one the BUILD side owns? Those phases are tracked on the board alone — the
# build drops the issue's `state:*` label (dor_build_flow.sh) and never restores it — so a
# label-less issue sitting in one of them is routed, not forgotten, and must still be liveness-
# checked. Names must match dor_set_status.sh's STATUS_NAME map.
build_phase() {
  case "$1" in
    "Building"|"Awaiting functional acceptance"|"Awaiting merge"|"Exceptions") return 0 ;;
    *) return 1 ;;
  esac
}

# 2. Walk every OPEN enhancement issue. Capture the list first so a transient failure aborts under
#    set -e rather than silently reporting "healthy".
#
#    Records are joined on US (\x1f), NOT tabs. Tab is an *IFS whitespace* character, so under
#    `IFS=$'\t'` bash collapses a run of tabs into ONE delimiter and an empty field in the middle of
#    the record silently shifts every field after it left. `sk_label` is empty on almost every issue
#    (only a live build holds a sidekick), so the overwhelmingly common record —
#    `…<TAB><TAB>state:decompose` — parsed as sk_label='state:decompose', state_label='' and made
#    every correctly-routed issue look un-routed. US is not IFS whitespace, so empty fields survive.
#    Neither an issue number nor a GitHub label name can contain a control character.
issues_rows="$(gh issue list --repo "$OWNER/$REPO" --state open --label "$LABEL" --limit 201 \
  --json number,labels,createdAt,updatedAt \
  --jq '.[] | [(.number|tostring),
               (.createdAt | fromdateiso8601 | tostring),
               (.updatedAt | fromdateiso8601 | tostring),
               ((([.labels[].name] | index("needs-vouch")) != null) | tostring),
               ([.labels[].name | select(startswith("sk:"))][0] // ""),
               ([.labels[].name | select(startswith("state:"))][0] // "")] | join("\u001f")')"
if [ "$(printf '%s' "$issues_rows" | grep -c .)" -ge 201 ]; then
  add_ex "⚠️ Over 200 open ${LABEL} issues — reconcile inspected only the first 200; add pagination."
  issues_rows="$(printf '%s\n' "$issues_rows" | head -n 200)"
fi
approval_backlog=0
while IFS=$'\x1f' read -r num created_epoch updated_epoch needs_vouch sk_label state_label; do
  [ -n "$num" ] || continue
  status="$(board_status_of "$num")"

  # An external request nobody has accepted yet. Do NOT heal it onto the board: it has no requestor
  # of record, so parking it at "Awaiting requestor" would read as "waiting on the reporter" when
  # it is really waiting on us. Flag it every sweep instead — an unanswered customer request should
  # keep nagging until a maintainer either vouches for it or closes it.
  if [ "$needs_vouch" = "true" ]; then
    age_d=$(( (now - created_epoch) / 86400 ))
    add_ex "🎟️ #${num} is an external request awaiting a maintainer vouch (${age_d}d old) — apply \`dor-vouched\` to accept it (you become the requestor of record), or close it."
    continue
  fi

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

  # FLAG: on the board but never routed. If old enough, the agent probably never ran.
  #
  # "No `state:*` label" does NOT mean un-routed. The BUILD side deliberately runs without one:
  # dor_build_flow.sh drops `state:awaiting-approval` when it applies `build-done`, and nothing
  # re-adds a state label afterwards — the phase lives on the board from then on. So every issue
  # in the build/feedback phase reaches here label-less, and until #995 this branch `continue`d,
  # which made the whole `case "$status"` below unreachable for them. That is exactly the
  # population the 💀 liveness arm was written for (#963): every dead build was found by a human
  # watching, never by this sweep, because control flow never got that far. Ask the BOARD whether
  # something owns the issue, and fall through when it does.
  #
  # Age is measured from `updated_epoch`, not `created_epoch`: a build that died 18 minutes ago was
  # reported as "after 1151h" (#370, opened in June), which reads as ancient backlog noise rather
  # than something that just broke.
  if [ -z "$state_label" ] && ! build_phase "$status"; then
    age_h=$(( (now - updated_epoch) / 3600 ))
    if [ "$age_h" -ge "$UNROUTED_HOURS" ]; then
      add_ex "🕳️ #${num} is on the board (Status: ${status:-none}) with no \`state:*\` label and untouched for ${age_h}h — the agent likely never ran."
    fi
    continue
  fi

  # FLAG: Status ≠ label (human moved one, not the other; or a write failed). Human resolves.
  # (blank $status with a label set is the "Status write failed" case — flag it too.)
  # Needs a label by definition — a build-phase issue reaching here has none, and `label_to_status ""`
  # is empty, so the guard below already skips it. Kept explicit so that stays true if either changes.
  if [ -n "$state_label" ]; then
    expected="$(label_to_status "$state_label")"
    if [ -n "$expected" ] && [ "$status" != "$expected" ]; then
      add_ex "🔀 #${num} drift: label \`${state_label}\` (→ ${expected}) but board Status is **${status:-<unset>}**."
    fi
  fi

  # FLAG: stale waiting on a human.
  case "$status" in
    "Awaiting requestor"|"Awaiting design")
      age_d=$(( (now - updated_epoch) / 86400 ))
      [ "$age_d" -ge "$STALE_FLAG_DAYS" ] && add_ex "⏳ #${num} has sat in **${status}** for ${age_d}d with no update."
      ;;
    "Awaiting approval") approval_backlog=$(( approval_backlog + 1 )) ;;
    # LIVENESS: "Building" asserts that a build or a feedback adjustment is running RIGHT NOW. When
    # a sidekick dies mid-flight the flow dies with it, so bail() never runs: no Exceptions, no
    # comment, no mention — the board simply keeps saying Building. Three builds died this way in a
    # single day and every one of them was found by a human watching, not by this sweep.
    "Building")
      age_m=$(( (now - updated_epoch) / 60 ))
      if [ "$age_m" -ge "$ACTIVE_STALL_MIN" ] && ! has_live_run "$num"; then
        add_ex "💀 #${num} says **Building** but no DoR workflow run is alive for it (${age_m}m since its last update) — its sidekick almost certainly died mid-flight. It will not move on its own; re-dispatch it."
        stalled="${stalled}${num} "
      fi
      ;;
  esac

  # FLAG: still claims a sidekick with nothing in flight to justify it. During a build the claim is
  # legitimate (the PR does not exist until part-way through), hence the Building exemption.
  # A failed PR lookup must SKIP this check, never satisfy it — otherwise one API hiccup reports
  # every claimed sidekick as a zombie.
  if [ -n "$sk_label" ] && [ "$status" != "Building" ]; then
    if open_pr="$(gh pr list --repo "$OWNER/$REPO" --head "dor/issue-${num}" --state open --json number --jq '.[0].number // empty' 2>/dev/null)"; then
      [ -z "$open_pr" ] && add_ex "🧟 #${num} still claims \`${sk_label}\` with no open PR — that box is probably holding a stale env. Release it, or drop the label if it already was."
    fi
  fi
done < <(printf '%s\n' "$issues_rows")

[ "$approval_backlog" -gt 0 ] && add_ex "🚦 ${approval_backlog} issue(s) waiting in **Awaiting approval** — the Product board's value gate."

# 3. Closed issues still parked in a non-terminal board Status.
# "Out of pipeline" is NOT terminal here, deliberately: an issue that left the pipeline and has since
# been closed still has to be walked over to Done, and this line is the only reminder that it is
# sitting there. Done is the single resting state on the board.
while IFS=$'\t' read -r num istate status; do
  [ "$istate" = "CLOSED" ] || continue
  case "$status" in ""|"Done") : ;; *) add_ex "🔚 #${num} is CLOSED but still on the board as **${status}** — move it to Done or off the board." ;; esac
done < <(printf '%s\n' "$board")

# 3b. Closed issues that still claim a sidekick: the release never ran, or ran against the wrong box
# (a re-dispatched build can land elsewhere). That box is out of the pool until someone clears it.
while IFS=$'\t' read -r num sk; do
  [ -n "$num" ] || continue
  add_ex "🧟 #${num} is CLOSED but still claims \`${sk}\` — release that box by hand (\`~/.dor-reservation\` + \`~/stacks/dor-${num}\`), then drop the label."
done < <(gh issue list --repo "$OWNER/$REPO" --state closed --label "$LABEL" --limit 50 \
  --json number,labels \
  --jq '.[] | select([.labels[].name] | any(startswith("sk:"))) | [(.number|tostring), ([.labels[].name | select(startswith("sk:"))][0])] | @tsv' 2>/dev/null || true)

# 3c. A health issue nobody opens is still silence, and a stalled build has no other signal at all —
# the flow died before it could say anything. Comment ONCE on the issue itself and mark it, so it
# reaches notifications without re-nagging every hour; clear the mark as soon as it recovers.
marked="$(gh issue list --repo "$OWNER/$REPO" --state open --label dor-stuck --label "$LABEL" --limit 50 \
  --json number --jq '.[].number' 2>/dev/null || true)"
for num in $stalled; do
  case " $(printf '%s ' $marked)" in *" $num "*) continue ;; esac
  gh issue edit "$num" --repo "$OWNER/$REPO" --add-label dor-stuck >/dev/null 2>&1 || true
  gh issue comment "$num" --repo "$OWNER/$REPO" --body "💀 @WimvandenHeijkant @TaekeK — this issue says **Building**, but no workflow run is alive for it. Its sidekick died mid-flight, so the flow never reached its own error handling: no Exceptions, no mention, nothing. It will not move on its own — re-dispatch by removing and re-applying \`ready-to-build\`." >/dev/null 2>&1 || true
done
for num in $marked; do
  case " $(printf '%s ' $stalled)" in *" $num "*) continue ;; esac
  gh issue edit "$num" --repo "$OWNER/$REPO" --remove-label dor-stuck >/dev/null 2>&1 || true
done

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

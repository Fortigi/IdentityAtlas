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

# Field separator for every multi-field record this script builds. US, not tab: tab is an *IFS
# whitespace* character, so `read`/`awk` collapse a run of tabs into ONE delimiter and an empty field
# in the middle of a record silently shifts every field after it left. Most records here have two
# optional label fields, so that is the common case, not the corner case. Neither an issue number,
# a board Status nor a GitHub label name can contain a control character.
US=$'\x1f'

exceptions=""   # markdown bullet lines
ex_keys=""      # one stable identity per exception — see the fingerprint in §4
stalled=""      # issue numbers whose "Building" has no live run behind it

# Record an exception, and alongside it a STABLE identity for that exception. The report re-states
# the same findings every sweep and most lines carry a moving age ("untouched for 17h"), so the text
# itself cannot answer "has anything actually changed?" — which is what decides whether to notify.
# Identity is the marker plus the issue the line is about: "🕳️#941". A line naming no issue (🚦, ⚠️)
# is identified by its marker plus every number in it, because for those the count IS the finding —
# "🚦3" must read as different from "🚦2", while the timestamps around it must not.
add_ex() {
  local msg="$1" num
  exceptions="${exceptions}- ${msg}"$'\n'
  num="$(printf '%s' "$msg" | grep -oE '#[0-9]+' | head -n 1 || true)"
  [ -n "$num" ] || num="$(printf '%s' "$msg" | grep -oE '[0-9]+' | tr -d '\n' || true)"
  ex_keys="${ex_keys}${msg%% *}${num}"$'\n'
}

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

# 1. Board snapshot: one US-separated record per item —
#      number, OPEN|CLOSED, Status, created epoch, updated epoch, needs-vouch, sk label, state label, is-bug
#    The issue's own metadata rides along so §2 can walk BOARD MEMBERSHIP instead of a label query.
#    74 items today; first:100 covers it. Warn (don't silently truncate) if it ever overflows.
board="$(gh api graphql \
  -f query='query($p:ID!){ node(id:$p){ ... on ProjectV2 { items(first:100){
      pageInfo{ hasNextPage }
      nodes{ content{ ... on Issue { number state createdAt updatedAt labels(first:50){ nodes{ name } } } }
             status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } }' \
  -f p="$PROJECT_ID" \
  --jq '.data.node.items as $i
        | (if $i.pageInfo.hasNextPage then "::warn-truncated::\n" else "" end)
        + ([$i.nodes[] | select(.content.number != null)
            | [.content.labels.nodes[].name] as $l
            | [(.content.number|tostring),
               .content.state,
               (.status.name // ""),
               (.content.createdAt | fromdateiso8601 | tostring),
               (.content.updatedAt | fromdateiso8601 | tostring),
               (($l | index("needs-vouch")) != null | tostring),
               ([$l[] | select(startswith("sk:"))][0] // ""),
               ([$l[] | select(startswith("state:"))][0] // ""),
               (($l | index("bug")) != null | tostring)]
              | join("'"$US"'")] | join("\n"))')"

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
board_status_of() { printf '%s\n' "$board" | awk -F"$US" -v n="$1" '$1==n {print $3; found=1} END{exit !found}' 2>/dev/null || true; }
on_board()        { printf '%s\n' "$board" | awk -F"$US" -v n="$1" '$1==n {f=1} END{exit !f}'; }

# Which board owns an issue is decided by its labels, exactly as dor_set_status.sh decides where to
# write: `bug` -> Bug Pipeline, everything else -> Feature Pipeline. Mirrored here rather than
# re-derived, so the two cannot drift. $LABEL says which pipeline this sweep is running for.
belongs_here() {  # $1 = "true" when the issue carries the `bug` label
  if [ "$LABEL" = bug ]; then [ "$1" = true ]; else [ "$1" != true ]; fi
}

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

# 2. Walk every OPEN issue THIS BOARD carries, plus every open `$LABEL` issue missing from it.
#
#    MEMBERSHIP decides what gets swept, not the gate label. Status is the canonical phase (D3), yet
#    the walk used to start from `gh issue list --label "$LABEL"`, so an issue could sit on the board
#    in any phase and be invisible to every check below. That was not a corner case: 42 of the
#    Feature board's 74 items carried no `enhancement` label — a whole UI cohort parked in "Awaiting
#    design", most of the "Out of pipeline" column, and an "Awaiting approval" item that the 🚦 count
#    therefore under-reported (2 where a human counted 3). The label query survives for the one thing
#    the board cannot show us: an issue that ought to be on it and is not.
#
#    Capture both lists first so a transient failure aborts under set -e rather than silently
#    reporting "healthy".
issues_rows="$(gh issue list --repo "$OWNER/$REPO" --state open --label "$LABEL" --limit 201 \
  --json number,labels,createdAt,updatedAt \
  --jq '.[] | [.labels[].name] as $l
      | [(.number|tostring),
         (.createdAt | fromdateiso8601 | tostring),
         (.updatedAt | fromdateiso8601 | tostring),
         (($l | index("needs-vouch")) != null | tostring),
         ([$l[] | select(startswith("sk:"))][0] // ""),
         ([$l[] | select(startswith("state:"))][0] // ""),
         (($l | index("bug")) != null | tostring)] | join("'"$US"'")')"
if [ "$(printf '%s' "$issues_rows" | grep -c .)" -ge 201 ]; then
  add_ex "⚠️ Over 200 open ${LABEL} issues — reconcile inspected only the first 200; add pagination."
  issues_rows="$(printf '%s\n' "$issues_rows" | head -n 200)"
fi

# Board rows first — they already carry the Status — then any labelled issue the board is missing.
# First occurrence of an issue number wins, so an issue in both lists is walked exactly once.
walk_rows="$( { printf '%s\n' "$board" | awk -F"$US" 'BEGIN{OFS=FS} $2=="OPEN" {print $1,$4,$5,$6,$7,$8,$9}'
                printf '%s\n' "$issues_rows"; } | awk -F"$US" '$1 != "" && !seen[$1]++')"

approval_backlog=0
while IFS="$US" read -r num created_epoch updated_epoch needs_vouch sk_label state_label is_bug; do
  [ -n "$num" ] || continue
  status="$(board_status_of "$num")"

  # SKIP/FLAG: this board does not own the issue. An item filed on the wrong board is a leftover —
  # #819 sat on the Feature board at "Blocked (external)" while the Bug board had it at "Awaiting
  # functional acceptance", and neither sweep could see the disagreement. Caught here because, with
  # the walk now driven by membership, it would otherwise fall through and be reported as un-routed
  # — "the agent likely never ran", when the real fault is where it is filed. If it is not on this
  # board either, stay quiet: the other pipeline's sweep owns it.
  if ! belongs_here "$is_bug"; then
    if on_board "$num"; then
      add_ex "🧭 #${num} sits on this board but its labels route it to the other one (\`bug\` → Bug Pipeline, otherwise → Feature Pipeline) — remove the stale board item, or fix the labels."
    fi
    continue
  fi

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
done < <(printf '%s\n' "$walk_rows")

[ "$approval_backlog" -gt 0 ] && add_ex "🚦 ${approval_backlog} issue(s) waiting in **Awaiting approval** — the Product board's value gate."

# 3. Closed issues still parked in a non-terminal board Status.
# "Out of pipeline" is NOT terminal here, deliberately: an issue that left the pipeline and has since
# been closed still has to be walked over to Done, and this line is the only reminder that it is
# sitting there. Done is the single resting state on the board.
while IFS="$US" read -r num istate status _rest; do
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

# WHICH exceptions are open, independent of how they are worded. Sorted, so a reordering is not
# "news". Carried in the body as an HTML comment (invisible when rendered) so the next sweep can read
# back what the last one found without a second store. This is what lets the report notify on CHANGE
# rather than on schedule: the body is refreshed every sweep — editing it does not notify — but a
# comment, which does, is only posted when this string differs from last time. A standing backlog
# then costs one notification instead of one per hour, which is the whole complaint.
fingerprint="$(printf '%s' "$ex_keys" | grep . | LC_ALL=C sort | tr '\n' ' ' || true)"
fingerprint="${fingerprint% }"

stamp="$(date -u +'%Y-%m-%d %H:%M UTC')"
if [ -z "$exceptions" ]; then
  body="_Last swept ${stamp}: ✅ pipeline healthy — nothing stuck or drifted._"
else
  body="$(printf '_Last swept %s — %s item(s) need attention:_\n\n%s\n<!-- dor-fingerprint: %s -->' \
    "$stamp" "$(printf '%s' "$exceptions" | grep -c '^- ')" "$exceptions" "$fingerprint")"
fi

if [ -n "$health_num" ]; then
  # What did the last sweep leave behind? Its state decides whether we have to reopen; its
  # fingerprint decides whether any of this is news. GitHub stores bodies with CRLF, so strip the
  # carriage returns before matching the line.
  prev="$(gh issue view "$health_num" --repo "$OWNER/$REPO" --json state,body \
    --jq '.state + "'"$US"'" + (.body // "")' 2>/dev/null || true)"
  prev_state="${prev%%"$US"*}"
  prev_fp="$(printf '%s' "${prev#*"$US"}" | tr -d '\r' \
    | sed -n 's/^<!-- dor-fingerprint: \(.*\) -->$/\1/p' | head -n 1 || true)"

  gh issue edit "$health_num" --repo "$OWNER/$REPO" --body "$body" >/dev/null
  if [ -n "$exceptions" ]; then
    # Something to act on — surface it. A closed health issue is out of sight, so reopening always
    # warrants the comment that goes with it.
    if [ "$prev_state" = "CLOSED" ]; then
      gh issue reopen "$health_num" --repo "$OWNER/$REPO" >/dev/null 2>&1 || true
    fi
    if [ "$prev_state" = "CLOSED" ] || [ "$fingerprint" != "$prev_fp" ]; then
      gh issue comment "$health_num" --repo "$OWNER/$REPO" --body "$body" >/dev/null
      echo "::notice::health issue #${health_num}: exception set changed — commented"
    else
      echo "::notice::health issue #${health_num}: same exceptions as last sweep — body refreshed silently"
    fi
  else
    # Healthy — close it so it stays out of the way until the next issue arises.
    gh issue close "$health_num" --repo "$OWNER/$REPO" >/dev/null 2>&1 || true
    echo "::notice::health issue #${health_num}: healthy — closed"
  fi
elif [ -n "$exceptions" ]; then
  # No state:* / enhancement label — this meta issue must not enter the pipeline or the board.
  gh issue create --repo "$OWNER/$REPO" --title "$HEALTH_TITLE" --body "$body" >/dev/null
  echo "::notice::created health issue"
else
  echo "::notice::pipeline healthy; no health issue needed yet"
fi

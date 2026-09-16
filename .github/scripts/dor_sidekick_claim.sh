#!/usr/bin/env bash
# Which sidekick a DoR build may use, and how it takes one. Sourced by dor_build_lib.sh (on the box)
# and by the hosted `pick` job in dor-build-agent.yml (off it); do NOT execute it. Needs ISSUE and REPO.
#
# A box holds ONE issue's functional-test env, from build until its PR closes — often for weeks. Two
# records say who that is:
#   ~/.dor-reservation      "<PR> <ISSUE>" on the box: the authority, readable only once a job is on it;
#   sk:<label> on the ISSUE the GitHub-readable mirror, which routes reset/feedback to the holder.
#
# Builds used to be scheduled by POOL label with nothing checking either record, so an idle box that
# was still parking an env could be handed a new build, which overwrote the reservation and then
# stripped the holder's label as "stale". #1049 lost its env on sk5 exactly that way: #1125 landed on
# it a month into #1049's acceptance, and nothing said a word. Three layers now stop that:
#   pick_sidekick          (hosted)   route the build to a box no open issue claims;
#   require_free_sidekick  (on box)   if it lands on a held box anyway, park the build and leave;
#   claim_sidekick         (on box)   never overwrite another open issue's reservation.

# This sidekick's stable runner label, derived from its hostname: dev-docker-08 -> sk8 (10# strips
# the leading zero, so 03 -> sk3 and 10 -> sk10 both work).
sk_label() { local n; n="$(hostname)"; n="${n##*-}"; printf 'sk%d' "$((10#$n))"; }

# Who, other than this issue, holds THIS box? Prints "#<issue>" or "PR #<n>", or nothing when the box
# is ours to take. A reservation is stale — and the box free — when its issue or PR is closed, or when
# its issue's claim label has since moved to another box (a re-dispatched build that landed elsewhere
# leaves its old lock behind). Anything we cannot read counts as HELD: guessing "free" is what wipes
# somebody's env, guessing "held" only delays a build.
sidekick_holder() {
  local lock="$HOME/.dor-reservation" plock="" pissue=""
  [ -f "$lock" ] && read -r plock pissue < "$lock"
  [ -n "$plock" ] || return 0
  if [ -z "$pissue" ]; then
    # A `deploy-to-sidekick` of a PR with no DoR issue behind it.
    pr_is_done "$plock" || echo "PR #$plock"
    return 0
  fi
  [ "$pissue" = "$ISSUE" ] && return 0
  issue_env_is_stale "$pissue" || echo "#$pissue"
}

# Is an env on THIS box for issue $1 left over? Yes when the issue is closed, or when its claim label
# names another box. No — kept — when it is open and claims this box or nothing, or cannot be read.
issue_env_is_stale() {
  local state="" claims=""
  read -r state claims < <(gh issue view "$1" --repo "$REPO" --json state,labels \
    --jq '.state + " " + ([.labels[].name | select(startswith("sk:"))] | join(","))' 2>/dev/null) || true
  [ "$state" = CLOSED ] && return 0
  [ "$state" = OPEN ] && [ -n "$claims" ] && [[ ",$claims," != *",sk:$(sk_label),"* ]]
}

pr_is_done() {  # $1 = PR number; an unreadable PR is NOT done
  case "$(gh pr view "$1" --repo "$REPO" --json state --jq .state 2>/dev/null || true)" in
    MERGED|CLOSED) return 0 ;;
  esac
  return 1
}

# ── The hourly sweep (dor-reconcile.yml, one job per DOR_POOL box) ───────────────────────────────────
# The reset on PR close only reaches the box the issue's label names, and the label is a mirror that
# drifts: a claim that moved boxes leaves its old lock behind, and a label dropped before the merge
# leaves the reset nowhere to go. sk3, sk6, sk7 and sk8 were all parked on closed or moved issues at
# once, out of the pool for nobody. The sweep asks each box itself.

drop_stack() {  # $1 = stack dir: stack down with its volumes, then the dir
  ( cd "$1" && { docker compose -f docker-compose.yml -f dor-tls.override.yml down -v 2>/dev/null \
                 || docker compose down -v 2>/dev/null || true; } )
  rm -rf "$1"
}

# Release what this box holds for nobody: a stale reservation (with its stack), and any dor-N / pr-N
# stack dir left behind by an issue or PR that no longer owns it. The live holder's stack, and any
# dir that is not dor-N / pr-N (edge, hand-made stacks), are never touched.
sweep_sidekick() {
  local ISSUE="" lock="$HOME/.dor-reservation" plock="" pissue="" d name n released=0
  [ -f "$lock" ] && read -r plock pissue < "$lock"
  if [ -n "$plock" ] && [ -z "$(sidekick_holder)" ]; then
    echo "::notice::$(hostname): releasing the stale reservation for ${pissue:+#$pissue / }PR #$plock"
    if [ -n "$pissue" ]; then d="$HOME/stacks/dor-$pissue"; else d="$HOME/stacks/pr-$plock"; fi
    [ -d "$d" ] && drop_stack "$d"
    rm -f "$lock"
    [ -n "$pissue" ] && gh issue edit "$pissue" --repo "$REPO" --remove-label "sk:$(sk_label)" >/dev/null 2>&1
    plock=""; pissue=""; released=1
  fi
  for d in "$HOME"/stacks/dor-* "$HOME"/stacks/pr-*; do
    [ -d "$d" ] || continue
    name="${d##*/}"; n="${name#*-}"
    case "$n" in ''|*[!0-9]*) continue ;; esac
    case "$name" in
      dor-*) [ "$n" = "$pissue" ] && continue; issue_env_is_stale "$n" || continue ;;
      pr-*)  [ "$n" = "$plock" ]  && continue; pr_is_done "$n"        || continue ;;
    esac
    echo "::notice::$(hostname): removing the leftover $name stack"
    drop_stack "$d"; released=1
  done
  [ "$released" = 1 ] || { echo "$(hostname): nothing stale"; return 0; }
  docker image prune -f >/dev/null 2>&1 || true
  # A box that now holds nothing serves the empty edge placeholder again, as after a reset.
  if [ ! -f "$lock" ] && [ -d "$HOME/stacks/edge" ]; then
    ( cd "$HOME/stacks/edge" && docker compose -f docker-compose.prod.yml up -d 2>/dev/null || true )
  fi
  return 0
}

# The hosted half: which box should this build run on? Prints an sk label, or nothing to fall back to
# the whole pool (where require_free_sidekick is the backstop). The pool is the DOR_POOL repo variable
# ("sk3 sk5 …") rather than the runner list, which needs an Administration credential we do not hold —
# so an offline box has to be taken out of DOR_POOL by hand, or a build routed to it will queue.
# An issue that already claims a pool box goes back to it: its env is there.
pick_sidekick() {
  local pool="${DOR_POOL:-}" search claims sk
  [ -n "${pool// }" ] || return 0
  search="$(printf 'sk:%s,' $pool)"
  # "<issue> <label>" for every claim an OPEN issue holds. A closed issue's leftover claim does not
  # count: its reservation is stale, and the box will say so when the build lands.
  claims="$(gh issue list --repo "$REPO" --state open --search "label:${search%,}" --limit 100 \
    --json number,labels \
    --jq '.[] | .number as $n | .labels[].name | select(startswith("sk:")) | "\($n) \(ltrimstr("sk:"))"' \
    2>/dev/null)" || return 0
  for sk in $pool; do
    printf '%s\n' "$claims" | grep -qx "$ISSUE $sk" && { echo "$sk"; return 0; }
  done
  for sk in $pool; do
    printf '%s\n' "$claims" | grep -q " $sk\$" || { echo "$sk"; return 0; }
  done
}

# The on-box backstop, run before the build touches anything. Routing reads the mirror, and the mirror
# can be wrong — a claim made before labels existed, or one stripped by the old claim code — so a
# build can still land on a held box. When it does: put the holder's missing claim label back, so
# routing sees it next time, then PARK this build the way a usage limit does. dor-resume re-dispatches
# it, and the pick job then steers it clear of this box.
require_free_sidekick() {
  local holder mine
  holder="$(sidekick_holder)"
  [ -n "$holder" ] || return 0
  mine="sk:$(sk_label)"
  echo "::warning::$HOST is holding ${holder}'s functional-test env — not building #$ISSUE over it"
  if [ "${holder#\#}" != "$holder" ] \
     && [ -z "$(gh issue view "${holder#\#}" --repo "$REPO" --json labels \
                  --jq '[.labels[].name | select(startswith("sk:"))] | join(",")' 2>/dev/null || echo unknown)" ]; then
    gh issue edit "${holder#\#}" --repo "$REPO" --add-label "$mine" >/dev/null 2>&1 \
      && echo "::notice::restored the missing $mine claim on $holder"
  fi
  touch "${RUNNER_TEMP:-/tmp}/dor-paused"
  GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" paused 2>/dev/null || true
  gh issue edit "$ISSUE" --repo "$REPO" --add-label dor-paused --remove-label ready-to-build >/dev/null 2>&1 || true
  comment_issue "$(printf '⏸️ **Waiting for a free sidekick** — the build was scheduled on %s, which is still holding %s'\''s test environment. Nothing was changed; it will retry on another box automatically.' "$HOST" "$holder")"
  exit 0
}

# Claim this box for the issue, in both records. $1 = PR number. Returns 1 — and changes nothing —
# when another open issue holds the box: overwriting its reservation is how an env gets wiped.
claim_sidekick() {
  local holder mine stale other
  holder="$(sidekick_holder)"
  if [ -n "$holder" ]; then
    echo "::error::$HOST is holding ${holder}'s env — refusing to claim it for #$ISSUE"
    return 1
  fi
  echo "$1 $ISSUE" > "$HOME/.dor-reservation"
  mine="sk:$(sk_label)"
  # The claim is EXCLUSIVE. A re-dispatched build can land on a different box than the attempt before
  # it, and two sk:* labels on one issue would leave the resolver picking whichever the API returned
  # first. Drop any other claim as we take ours.
  stale="$(gh issue view "$ISSUE" --repo "$REPO" --json labels \
           --jq "[.labels[].name | select(startswith(\"sk:\")) | select(. != \"$mine\")] | join(\",\")" 2>/dev/null || true)"
  # shellcheck disable=SC2086  # label names never contain spaces; this expansion must stay unquoted
  gh issue edit "$ISSUE" --repo "$REPO" --add-label "$mine" ${stale:+--remove-label "$stale"} >/dev/null 2>&1 \
    || echo "::warning::could not label #$ISSUE with $mine — its sidekick will need releasing by hand"
  [ -n "$stale" ] && echo "::notice::claim moved to $mine (dropped $stale) — the old box may still hold a stale stack"
  # Exclusive to the BOX too (#1011): another open issue still labelled with this box would have its
  # next `/rework` dispatched here, where the job answers "not my issue" and exits without a word.
  # sidekick_holder has just established that this box's reservation is not theirs, so their label
  # is the stale record, not ours.
  for other in $(gh issue list --repo "$REPO" --state open --label "$mine" --json number \
                 --jq ".[].number | select(. != $ISSUE)" 2>/dev/null || true); do
    gh issue edit "$other" --repo "$REPO" --remove-label "$mine" >/dev/null 2>&1 \
      && echo "::notice::dropped the stale $mine claim from #$other — this box now holds #$ISSUE"
  done
  return 0
}

#!/usr/bin/env bash
# Shared helpers for the DoR build-side flows that run ON a dor-build sidekick:
#   dor_build_flow.sh     — the initial build (implement → PR → verify → notify)
#   dor_feedback_flow.sh  — a requestor-feedback adjustment on an already-built feature
#
# Source this ("source dor_build_lib.sh"); do NOT execute it. The caller must export at least
# ISSUE REPO URL HOST WORK GH_TOKEN BOARD_TOKEN before sourcing; everything else is derived here so
# both flows stay in lock-step. Set FLOW_NOUN (e.g. "build" / "adjustment") before sourcing to tune
# the human-facing wording of bail()/pause().

export PATH="$HOME/.local/bin:$PATH"

# ── Derived config (identical across both flows) ──────────────────────────────────────────────────
BRANCH="dor/issue-${ISSUE}"
DIR="$HOME/stacks/dor-${ISSUE}"                 # persistent deploy dir = the functional-test env
SCRIPTS="$WORK/.github/scripts"                 # restored to committed state before we call them
# The build/fix loop uses Opus 5, NOT Fable 5 — Fable is reserved for the spec-side interview/probe
# (its weekly bucket is small and it is ~2× the price). Opus is plenty for a scoped, test-gated change.
# Overridable via the DOR_BUILD_MODEL repo variable.
MODEL="${DOR_BUILD_MODEL:-claude-opus-5}"
FALLBACK_MODEL="${DOR_FALLBACK_MODEL:-claude-sonnet-5}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-8}"
IMPLEMENT_TURNS="${IMPLEMENT_TURNS:-150}"       # generous — a real feature can need many turns
FIX_TURNS="${FIX_TURNS:-60}"                    # a fix is scoped; cap it so a confused agent can't run away
MAINTAINERS="@WimvandenHeijkant @TaekeK @robb536"
PLUGINS="entra-group-category-tree resource-type-tree resource-cluster scope-hierarchy risky-consent"
FLOW_NOUN="${FLOW_NOUN:-build}"
# Link to THIS workflow run so a comment can say "follow progress → here". Empty off-Actions.
RUN_URL=""
[ -n "${GITHUB_RUN_ID:-}" ] && RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-$REPO}/actions/runs/${GITHUB_RUN_ID}"
# Terse working output (the agent runs headless — nobody reads its narration), but keep the DELIVERABLES
# professional. Appended to every prompt.
TERSE=$'\n\nWork directly and without narration: make the edits and run the commands, do not explain your steps or write prose summaries. Keep the actual deliverables — commit messages, the PR description, code comments, and changelog entries — normal, clear and professional.'

# Self-hosted runners have no git identity of their own; without one `git commit` aborts
# ("unable to auto-detect email address") and the flow would push an empty branch. Pin an identity.
#
# It has to be the BOT APP's noreply address, not a friendly one. GitHub resolves a commit's author
# by email: `dor-agent@fortigi.nl` matches no account, so every commit came back with author=NONE and
# committer=NONE, GitHub treated the push as an unknown contributor, and held ALL of the PR's
# workflow runs at `action_required` — five manual approvals per build, and an Exceptions bail when
# nobody noticed. Dependabot avoids this the same way (`49699333+dependabot[bot]@users.noreply…`).
# The number is the bot's user id; the address only resolves with it.
git -C "$WORK" config user.email "280718603+fortigi-ci-bot[bot]@users.noreply.github.com" >/dev/null 2>&1 || true
git -C "$WORK" config user.name  "fortigi-ci-bot[bot]"                                    >/dev/null 2>&1 || true

issue_mentions() {  # requestor (author) + commenters, deduped, bots excluded, @-prefixed
  gh issue view "$ISSUE" --repo "$REPO" --json author,comments \
    --jq '([.author.login]+[.comments[].author.login]) | map(select(. and (endswith("[bot]")|not) and (.!="github-actions"))) | unique | map("@"+.) | join(" ")'
}

# A short, deterministic description of what a commit changed (files touched), for report comments —
# more useful than the AI'\''s terse final message. $1 = git range.
# Callers pass a THREE-dot range (origin/main...HEAD): main keeps moving under a long-lived branch,
# and a two-dot diff attributes every unrelated merge to this build. #370's feedback report claimed
# "533 files changed, 6262 insertions" for a tooltip adjustment; the branch itself touched a handful.
changed_summary() {
  local stat; stat="$(git -C "$WORK" diff --stat "$1" 2>/dev/null | tail -8)"
  [ -n "$stat" ] && printf 'Files changed:\n```\n%s\n```' "$stat"
}
comment_issue() { gh issue comment "$ISSUE" --repo "$REPO" --body "$1" >/dev/null 2>&1 || true; }

# Is this a bug report? Cached — an issue's labels do not change under us mid-run.
IS_BUG=""
is_bug() {
  [ -n "$IS_BUG" ] || IS_BUG="$(gh issue view "$ISSUE" --repo "$REPO" --json labels \
      --jq 'if ([.labels[].name] | index("bug")) then "yes" else "no" end' 2>/dev/null || echo no)"
  [ "$IS_BUG" = yes ]
}

# The repro contract the probe certified with, pulled back out of the issue thread — the build's only
# input is .dor/in/spec.json, so the contract travels inside the certified comment. Echoes the JSON;
# returns non-zero when there isn't one (issues certified before contracts existed still build).
read_contract() {
  local body
  body="$(jq -r '[.comments[].body // empty] | map(select(test("Repro contract"))) | last // empty' \
          "$WORK/.dor/in/spec.json" 2>/dev/null)" || return 1
  [ -n "$body" ] || return 1
  printf '%s\n' "$body" | sed -n '/```json/,/```/p' | sed '1d;$d'
}

# Did the fix stay inside the blast radius the probe predicted? Drifting outside it means the
# diagnosis was wrong or the scope crept — either way a human decides, so this is a stop, not a fix
# loop. Tests, docs, changelog fragments and lockfiles are always allowed. Echoes offending paths.
blast_radius_violations() {  # $1 = contract file, $2 = git range
  local globs f g hit
  globs="$(jq -r '.blast_radius[]' "$1" 2>/dev/null)" || return 0
  [ -n "$globs" ] || return 0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # `.ci/*` are the committed RATCHET baselines (coverage, file length, complexity). A fix that
    # legitimately moves coverage MUST update them or CI fails — so they are a consequence of the
    # change, not part of it, exactly like a changelog fragment. #943's build was stopped for
    # touching .ci/coverage-baseline.json, which no probe could reasonably have predicted and which
    # it had no choice but to write.
    case "$f" in
      *.test.js|*.test.jsx|*.spec.js|*.Tests.ps1|changes/*|docs/*|.ci/*|*/package-lock.json|package-lock.json) continue ;;
    esac
    hit=no
    while IFS= read -r g; do
      [ -n "$g" ] || continue
      # shellcheck disable=SC2254  # the glob is data and must stay unquoted to be a pattern
      case "$f" in $g) hit=yes; break ;; esac
    done <<< "$globs"
    [ "$hit" = no ] && printf '%s\n' "$f"
  done < <(git -C "$WORK" diff --name-only "$2" 2>/dev/null)
}

# The automated tests a range touched. e2e specs are excluded — they need the deployed app, and run
# later against the live env.
touched_tests() {  # $1 = git range
  git -C "$WORK" diff --name-only "$1" 2>/dev/null \
    | grep -E '\.(test|spec)\.(js|jsx)$|\.Tests\.ps1$' | grep -v '^app/ui/e2e/' || true
}

# Re-prove the regression test RED, against main, on a branch that already contains the fix.
#
# The first build gets its red proof free from commit ordering: the test exists before the fix does.
# Nothing after that does — an adjustment, a CI fix, a proof-gap re-run all edit a tree where the fix
# is already present, so "the tests pass" says nothing about whether they still catch the bug. The
# obvious failure is an agent quietly weakening the test to get green, and it would look identical to
# success. So: put the PRODUCTION files back to main, keep the tests as they are now, and require a
# failure. That is the same manual check that validated #942, automated.
#
# 0 = still genuinely red without the fix · 1 = passes without the fix (the test no longer catches it)
# 3 = nothing to check (no tests, or no production change) · 4 = could not run the check
prove_red_against_main() {  # $1 = git range
  local tests prod f rc restore="" removed=""
  tests="$(touched_tests "$1")"
  [ -n "$tests" ] || return 3
  prod="$(git -C "$WORK" diff --name-only "$1" 2>/dev/null \
          | grep -vE '\.(test|spec)\.(js|jsx)$|\.Tests\.ps1$' \
          | grep -vE '^(changes|docs)/' || true)"
  [ -n "$prod" ] || return 3

  # Un-fix: restore each production file to main. A file main does not have (the fix added it) has to
  # be moved aside instead, or the test would still import the new code and pass for the wrong reason.
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if git -C "$WORK" cat-file -e "origin/main:$f" 2>/dev/null; then
      git -C "$WORK" checkout origin/main -- "$f" 2>/dev/null && restore="${restore}${f}"$'\n'
    else
      mv "$WORK/$f" "$WORK/$f.dorbak" 2>/dev/null && removed="${removed}${f}"$'\n'
    fi
  done <<< "$prod"

  run_touched_tests "$1"; rc=$?

  # Put the fix back before doing anything else with this tree.
  while IFS= read -r f; do [ -n "$f" ] && git -C "$WORK" checkout HEAD -- "$f" 2>/dev/null; done <<< "$restore"
  while IFS= read -r f; do [ -n "$f" ] && mv "$WORK/$f.dorbak" "$WORK/$f" 2>/dev/null; done <<< "$removed"

  case "$rc" in
    1) cp /tmp/unit.log /tmp/red.log 2>/dev/null || true; return 0 ;;   # failed without the fix — good
    0) return 1 ;;                                                      # passed without the fix — bad
    *) return 4 ;;
  esac
}

# Run the unit tests a range touched, each in its own suite. Output -> /tmp/unit.log
#   0 = all passed   1 = something failed   3 = the range contains no unit test
#   4 = there are tests but this box cannot run them (Pester-only change; the pool has no pwsh)
run_touched_tests() {  # $1 = git range
  local files ui api ps rc=0
  files="$(touched_tests "$1")"
  [ -n "$files" ] || return 3
  ui="$(printf '%s\n' "$files"  | grep '^app/ui/'  | sed 's#^app/ui/##'  | tr '\n' ' ')"
  api="$(printf '%s\n' "$files" | grep '^app/api/' | sed 's#^app/api/##' | tr '\n' ' ')"
  ps="$(printf '%s\n' "$files"  | grep -E '\.Tests\.ps1$' | tr '\n' ' ')"
  : > /tmp/unit.log
  if [ -n "${ps// }" ] && [ -z "${ui// }" ] && [ -z "${api// }" ] && ! command -v pwsh >/dev/null 2>&1; then
    echo "The only tests in this change are PowerShell (Pester), and this sidekick has no pwsh installed." >> /tmp/unit.log
    return 4
  fi
  # shellcheck disable=SC2086  # the file lists are deliberately word-split into args
  if [ -n "${ui// }" ]; then
    ( cd "$WORK/app/ui"  && { [ -d node_modules ] || npm ci >/dev/null 2>&1; }; npx vitest run $ui  ) >>/tmp/unit.log 2>&1 || rc=1
  fi
  # shellcheck disable=SC2086
  if [ -n "${api// }" ]; then
    ( cd "$WORK/app/api" && { [ -d node_modules ] || npm ci >/dev/null 2>&1; }; npx vitest run $api ) >>/tmp/unit.log 2>&1 || rc=1
  fi
  # shellcheck disable=SC2086
  if [ -n "${ps// }" ] && command -v pwsh >/dev/null 2>&1; then
    ( cd "$WORK" && pwsh -NoProfile -Command "Invoke-Pester -Path $ps -CI" ) >>/tmp/unit.log 2>&1 || rc=1
  fi
  return $rc
}

# This sidekick's stable runner label, derived from its hostname: dev-docker-08 -> sk8 (10# strips
# the leading zero, so 03 -> sk3 and 10 -> sk10 both work).
sk_label() { local n; n="$(hostname)"; n="${n##*-}"; printf 'sk%d' "$((10#$n))"; }

# Claim this box for the issue, recording the holder in BOTH places that need to know:
#   ~/.dor-reservation   the box's own authority ("<PR> <ISSUE>"), read once a job is ON the box;
#   sk:<label> on the ISSUE   the GitHub-readable mirror, so reset/feedback can dispatch STRAIGHT
#                             to the holder instead of fanning a job out to every sidekick.
# The label is a routing hint and never the authority — the job that lands still verifies against
# the file, so a stale label costs one no-op rather than the wrong box being wiped. $1 = PR number.
claim_sidekick() {
  echo "$1 $ISSUE" > "$HOME/.dor-reservation"
  local mine="sk:$(sk_label)" stale
  # The claim is EXCLUSIVE. A re-dispatched build (infra death, usage-limit resume) is scheduled by
  # POOL label, so it can land on a different box than the attempt before it — and two sk:* labels on
  # one issue would leave the resolver picking whichever the API returned first. Drop any other claim
  # as we take ours.
  stale="$(gh issue view "$ISSUE" --repo "$REPO" --json labels \
           --jq "[.labels[].name | select(startswith(\"sk:\")) | select(. != \"$mine\")] | join(\",\")" 2>/dev/null || true)"
  # shellcheck disable=SC2086  # label names never contain spaces; this expansion must stay unquoted
  gh issue edit "$ISSUE" --repo "$REPO" --add-label "$mine" ${stale:+--remove-label "$stale"} >/dev/null 2>&1 \
    || echo "::warning::could not label #$ISSUE with $mine — its sidekick will need releasing by hand"
  [ -n "$stale" ] && echo "::notice::claim moved to $mine (dropped $stale) — the old box may still hold a stale stack"
  # Exclusive to the BOX, not just to this issue. The line above only clears OTHER boxes claimed by
  # THIS issue; a previous holder of this box keeps its label, and two open issues then name one
  # sidekick. That is silent, not loud: dor-acceptance dispatches the stale claimant's next
  # `/rework` here, this box answers "not my issue", and the job exits without a word to the
  # requestor. We hold the reservation now, so any other claim on it is stale by construction (#1011).
  local other
  for other in $(gh issue list --repo "$REPO" --state open --label "$mine" --json number \
                 --jq ".[].number | select(. != $ISSUE)" 2>/dev/null || true); do
    gh issue edit "$other" --repo "$REPO" --remove-label "$mine" >/dev/null 2>&1 \
      && echo "::notice::dropped the stale $mine claim from #$other — this box now holds #$ISSUE"
  done
  return 0
}

# Make git push/fetch on THIS checkout authenticate as the BOT app instead of the job's GITHUB_TOKEN.
# GitHub suppresses workflow runs for commits pushed with GITHUB_TOKEN (anti-recursion) — which is why
# the bot PR got ZERO CI checks. Pushing as the app makes the PR's CI actually run. Call once, after
# checkout, before any push. (BOARD_TOKEN must carry contents:write.)
use_bot_remote() {
  git -C "$WORK" config --local --unset-all 'http.https://github.com/.extraheader' 2>/dev/null || true
  git -C "$WORK" remote set-url origin "$(app_remote_url)"
}

# The app-authenticated remote URL. Factored out so use_bot_remote, push_as_app's lease resolution
# and the tests all reach the same string instead of rebuilding it.
app_remote_url() { printf '%s' "https://x-access-token:${BOARD_TOKEN}@github.com/${REPO}.git"; }

# Push as the app WITHOUT depending on which credential git decides to prefer.
#
# use_bot_remote sets an authenticated remote URL, and for the initial build that works — its pushes
# land as fortigi-ci-bot[bot] and CI runs. The feedback flow, with an identical checkout and the same
# helper, pushed as github-actions[bot] anyway, and every one of those commits had its checks held at
# `action_required` (which then bailed the adjustment, correctly, as unverifiable). actions/checkout
# v7 persists credentials through an `includeIf` config file as well as the extraheader that this
# helper clears, so which credential wins is not something to leave to precedence.
#
# Passing the URL to `git push` directly removes the question: the token on the command line is the
# one used. Args after the URL are forwarded, so callers keep their own refspec and flags.
#
# A BARE `--force-with-lease` cannot survive that choice. It resolves its expected value from the
# remote-TRACKING ref, and a push to a URL has none — nor does pushing to a URL ever update one. So
# git rejects it with `! [rejected] HEAD -> <branch> (stale info)` every single time, and it is not a
# race: the first push of a build only survives because it CREATES the branch, where the expected
# value is "absent". Every later push targets a branch that now exists. That made the adjustment push
# (dor_feedback_flow.sh) and verify_loop's CI auto-fix push impossible, and both then bailed the flow
# to Exceptions — #665 dead-lettered exactly this way.
#
# Resolve the lease against the remote itself, which is what the tracking ref would have stood in
# for. The window it guards shrinks to ls-remote → push; that is the honest guarantee available when
# pushing to a URL, and these branches are held by one reserved sidekick at a time anyway. An
# explicit `--force-with-lease=<ref>:<sha>` from a caller is passed through untouched.
push_as_app() {  # $@ = refspec + flags
  local url dst="" a sha
  url="$(app_remote_url)"
  for a in "$@"; do case "$a" in *:refs/heads/*) dst="${a#*:}" ;; esac; done

  local -a args=()
  for a in "$@"; do
    if [ "$a" = "--force-with-lease" ] && [ -n "$dst" ]; then
      sha="$(git -C "$WORK" ls-remote "$url" "$dst" 2>/dev/null | awk 'NR==1{print $1}')"
      # No sha means the branch does not exist yet: this push creates it and there is nothing to
      # protect. Drop the lease rather than invent an expected value.
      [ -n "$sha" ] && args+=("--force-with-lease=${dst}:${sha}")
    else
      args+=("$a")
    fi
  done

  git -C "$WORK" push "$url" "${args[@]}" 2>&1 | sed "s@${BOARD_TOKEN}@***@g"
  return "${PIPESTATUS[0]}"
}

# Run the AI once. $1=prompt $2=outfile $3=max-turns. Returns: 0 ok · 2 usage/spend LIMIT (429, → pause)
# · 1 any other error (→ bail). Centralises model, turn cap, terse output, and limit detection.
run_claude() {
  claude -p "$1${TERSE}" \
    --allowedTools "Read,Edit,Write,Bash,Grep,Glob" \
    --model "$MODEL" --fallback-model "$FALLBACK_MODEL" \
    --max-turns "${3:-$FIX_TURNS}" \
    --output-format json >"$2" 2>&1
  local rc=$?
  # A usage/spend limit is NOT a code failure — the caller should PAUSE, not route to Exceptions.
  if grep -qE '"api_error_status"[[:space:]]*:[[:space:]]*429' "$2" 2>/dev/null \
     || grep -qiE 'spend limit|usage limit|reached your.*limit|hit your (org|plan|weekly)' "$2" 2>/dev/null; then
    return 2
  fi
  # Running out of turns is not a hard error — the caller can commit partial work and re-verify.
  grep -qE '"subtype"[[:space:]]*:[[:space:]]*"error_max_turns"' "$2" 2>/dev/null && return 3
  grep -qE '"is_error"[[:space:]]*:[[:space:]]*true' "$2" 2>/dev/null && return 1
  return "$rc"
}

# Route to the Exceptions column + notify maintainers, then stop. Called on any unrecoverable failure.
bail() {
  local reason="$1"
  echo "::error::${FLOW_NOUN} flow failed: ${reason}"
  touch "${RUNNER_TEMP:-/tmp}/dor-bailed"   # tell the workflow's failure backstop we already handled it
  git -C "$WORK" restore --source=HEAD --staged --worktree -- .github 2>/dev/null || true
  GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" exception 2>/dev/null || true
  gh issue edit "$ISSUE" --repo "$REPO" --add-label needs-triage >/dev/null 2>&1 || true
  comment_issue "$(printf '⚠️ %s — %s hit a problem → **Exceptions** (needs triage).\n**What broke:** %s  (`%s` on %s)' "$MAINTAINERS" "$FLOW_NOUN" "$reason" "$BRANCH" "$HOST")"
  exit 1
}

# Hit a Claude usage limit — NOT an error. Save work-in-progress on the branch, park the issue in the
# "Paused" column, and exit cleanly (0). dor-resume.yml re-dispatches it when capacity returns, and the
# resume-aware flow continues from the saved branch instead of re-implementing.
pause_and_exit() {
  local reason="$1"
  echo "::warning::PAUSING (${FLOW_NOUN}): ${reason}"
  touch "${RUNNER_TEMP:-/tmp}/dor-paused"   # tell the workflow's failure backstop this is a pause
  git -C "$WORK" restore --source=HEAD --staged --worktree -- .github 2>/dev/null || true
  git -C "$WORK" add -A 2>/dev/null || true
  git -C "$WORK" diff --cached --quiet 2>/dev/null || git -C "$WORK" commit -q -m "wip: paused on usage limit (#${ISSUE})" 2>/dev/null || true
  git -C "$WORK" push --force-with-lease origin "$BRANCH" 2>/dev/null || true
  GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" paused 2>/dev/null || true
  gh issue edit "$ISSUE" --repo "$REPO" --add-label dor-paused --remove-label ready-to-build >/dev/null 2>&1 || true
  comment_issue "$(printf '⏸️ **Paused** — hit a Claude usage limit. Work is saved on `%s`; will **auto-resume** when capacity returns (no action needed).' "$BRANCH")"
  exit 0
}

# Deploy the current $BRANCH to the persistent dir on THIS sidekick, load demo data + resource context
# plugins, wait healthy. Returns non-zero on infra failure (→ bail, not a fix-loop).
deploy_and_seed() {
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch origin "$BRANCH" -q && git -C "$DIR" reset --hard "origin/$BRANCH" -q || return 1
  else
    git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$DIR" || return 1
  fi
  # free :3001 — down every other stack on this box (edge placeholder, stale)
  for d in "$HOME"/stacks/*/; do
    [ "$d" = "$DIR/" ] || [ ! -d "$d" ] && continue
    ( cd "$d" && { docker compose down 2>/dev/null || docker compose -f docker-compose.prod.yml down 2>/dev/null || true; } )
  done
  printf 'services:\n  web:\n    environment:\n      BEHIND_TLS: "true"\n      PUBLIC_BASE_URL: "%s"\n' "$URL" > "$DIR/dor-tls.override.yml"
  ( cd "$DIR" && docker compose -f docker-compose.yml -f dor-tls.override.yml up -d --build ) || return 1
  local code=000 i
  for i in $(seq 1 90); do code=$(curl -fsS -o /dev/null -w '%{http_code}' http://localhost:3001/ 2>/dev/null || echo 000); [ "$code" = 200 ] && break; sleep 10; done
  [ "$code" = 200 ] || return 1
  # demo data (crawler job) — block to completion
  local jid st
  jid=$(curl -fsS -X POST http://localhost:3001/api/admin/crawler-jobs -H 'Content-Type: application/json' -d '{"jobType":"demo"}' | jq -r '.id // empty') || return 1
  [ -n "$jid" ] || return 1
  for i in $(seq 1 100); do st=$(curl -fsS "http://localhost:3001/api/admin/crawler-jobs/$jid" | jq -r '.status // "?"'); [ "$st" = completed ] && break; [ "$st" = failed ] && return 1; sleep 3; done
  [ "$st" = completed ] || return 1
  # resource-targeted context plugins (populate the matrix Contexts column etc.) — best-effort
  for p in $PLUGINS; do curl -fsS -X POST "http://localhost:3001/api/context-plugins/$p/run" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1 || true; done
  sleep 15
  return 0
}

# Run the feature's e2e (the specs the branch touched) against the LIVE populated env. 0=pass.
run_feature_e2e() {
  local specs
  specs=$(git -C "$WORK" diff --name-only origin/main...HEAD -- 'app/ui/e2e/*.spec.js' 2>/dev/null | sed 's#app/ui/e2e/##' | tr '\n' ' ')
  if [ -z "${specs// }" ]; then
    # For a BUG there is no fallback: the whole point is replaying the reporter's symptom against the
    # deployed fix. "The app serves" would let a unit-only fix be reported as verified — which is
    # exactly how a green build can mean nothing.
    if is_bug; then
      echo "No e2e spec was added for this bug, so the reporter's symptom was never replayed against the running app. Add or extend a spec under app/ui/e2e/ that walks the reported path." > /tmp/e2e.log
      return 2
    fi
    # Feature with no e2e touched — fall back to a smoke check that the populated app serves.
    [ "$(curl -fsS -o /dev/null -w '%{http_code}' http://localhost:3001/ 2>/dev/null || echo 000)" = 200 ]; return
  fi
  ( cd "$DIR/app/ui" \
    && npm ci >/tmp/e2e-npm.log 2>&1 \
    && npx playwright install --with-deps chromium >/tmp/e2e-pw.log 2>&1 \
    && E2E_BASE_URL=http://localhost:3001 npx playwright test $specs --config=playwright.ci.config.js --project=chromium >/tmp/e2e.log 2>&1 )
}

# Did EVERY failing check die in "Set up job" — i.e. before it ran a single real step? That is
# GitHub failing, not the code. On 2026-08-06 an action-resolution outage ("Failed to resolve action
# download info. Error: Service Unavailable") took out ten jobs on one PR at once; a fixer pointed at
# that would spend MAX_ATTEMPTS passes trying to edit code to satisfy an outage.
#
# Structural, not text-matching: a genuine failure has a dozen green steps and a red one named after
# the work ("Run Vitest"). Deliberately strict — ALL failures must be setup failures. One real red
# check alongside the outage means there is something to fix, so we stay on the normal path.
ci_failures_are_infra() {  # $1 = PR number
  local ids id total=0 infra=0
  ids="$(gh pr view "$1" --repo "$REPO" --json statusCheckRollup \
        --jq '[.statusCheckRollup[]? | select((.conclusion // "") == "FAILURE") | .detailsUrl // ""
               | capture("/job/(?<id>[0-9]+)")?.id // empty] | .[]' 2>/dev/null)" || return 1
  [ -n "$ids" ] || return 1
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    total=$((total+1))
    [ "$(gh api "repos/$REPO/actions/jobs/$id" \
         --jq '([.steps[]?|select(.conclusion=="failure")|.name]) as $f | (($f|length) > 0) and ($f|all(. == "Set up job"))' \
         2>/dev/null)" = true ] && infra=$((infra+1))
  done <<< "$ids"
  [ "$total" -gt 0 ] && [ "$infra" -eq "$total" ]
}

# Settle the PR's checks and classify: `pass` | `fail` | `infra` | `blocked` | `none`.
# Checks register a little after the push, so "nothing reported yet" must not be read as a failure —
# wait for them to appear, then wait for them to finish.
#
# `blocked` is the case that bit #942/#949: GitHub held all four workflow runs at `action_required`
# (a maintainer has to press "Approve and run"), so they never became checks at all. The old code
# waited out its window, returned `none`, and the caller accepted the build on the e2e alone —
# reporting "CI green" on a PR where CI had never run. Held runs are visible only through the
# Actions API; the commit's check-runs list is empty.
ci_state() {
  local pr="$1" waited=0 sha rollup total fails pend kill
  sha="$(gh pr view "$pr" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null)"
  while [ "$waited" -lt 1800 ]; do
    if [ -n "$sha" ] && [ "$(gh api "repos/$REPO/actions/runs?head_sha=$sha" \
         --jq '[.workflow_runs[]?|select(.conclusion=="action_required")]|length' 2>/dev/null || echo 0)" != 0 ]; then
      echo blocked; return
    fi
    # EVERY check, not just the required ones. "CI Passed" is an aggregate that `needs:` every other
    # job, so when one of them FAILS, GitHub never runs the aggregate and it stays PENDING rather
    # than turning red. Watching only required checks is therefore blind to the actual failures:
    # #928's PR reported CI green to the flow while nine jobs — including Unit Tests (API) and the
    # contract tests — were red, because the one required check that would have caught it was
    # stuck pending. Judge the whole rollup instead.
    rollup="$(gh pr view "$pr" --repo "$REPO" --json statusCheckRollup \
              --jq '[.statusCheckRollup[]? | (.conclusion // .status // "PENDING") | ascii_upcase]' 2>/dev/null)" || rollup=""
    if [ -z "$rollup" ] || [ "$rollup" = "[]" ]; then
      sleep 45; waited=$((waited+45)); continue   # not registered yet — wait for CI to appear
    fi
    printf '%s\n' "$rollup" > /tmp/ci.log
    total="$(printf '%s' "$rollup" | jq 'length')"
    fails="$(printf '%s' "$rollup" | jq '[.[]|select(. == "FAILURE" or . == "TIMED_OUT" or . == "STARTUP_FAILURE" or . == "STALE")] | length')"
    pend="$( printf '%s' "$rollup" | jq '[.[]|select(. == "PENDING" or . == "QUEUED" or . == "IN_PROGRESS" or . == "WAITING" or . == "EXPECTED" or . == "REQUESTED")] | length')"
    # CANCELLED is not FAILED. A job killed by an outage, by a superseding push, or by a human never
    # reached a verdict on the code at all — this PR's OWN checks were cancelled that way during
    # yesterday's incident. Counting it as a failure sends it to the AI fixer, which is precisely the
    # mistake this function exists to prevent, so it takes the same wait-and-re-run path as an outage.
    kill="$(printf '%s' "$rollup" | jq '[.[]|select(. == "CANCELLED")] | length')"
    if [ "${fails:-0}" -gt 0 ]; then
      ci_failures_are_infra "$pr" && { echo infra; return; }
      echo fail; return
    fi
    [ "${kill:-0}" -gt 0 ] && { echo infra; return; }
    [ "${total:-0}" -eq 0 ] && { sleep 45; waited=$((waited+45)); continue; }
    [ "${pend:-0}" -gt 0 ] && { sleep 45; waited=$((waited+45)); continue; }
    echo pass; return
  done
  echo none   # never settled inside the window — the caller refuses to call that verified
}

# The verify loop shared by both flows: deploy+seed → e2e on live env → CI. The AI fixer is invoked
# ONLY on a REAL failure (e2e failed, or a required check is red) — never merely because CI hasn't
# reported yet (that spin is what burned a week of budget). $1 = the open PR number.
verify_loop() {
  local pr="$1" attempt=0 e2e_rc ci ctx infra_waits=0
  while : ; do
    deploy_and_seed || bail "deploy/seed of the live env failed on $HOST (infra)"
    run_feature_e2e; e2e_rc=$?
    ci="$(ci_state "$pr")"

    # GitHub is down, not the code. Wait it out WITHOUT consuming a fix attempt and WITHOUT
    # redeploying — the AI cannot edit its way past an action-resolution outage, and re-running the
    # jobs is what actually clears it. Only CI is re-checked here; the e2e result still stands.
    while [ "$ci" = infra ]; do
      infra_waits=$((infra_waits+1))
      [ "$infra_waits" -gt 5 ] && bail "every failing check on PR #$pr died in 'Set up job' — GitHub is failing to start jobs at all (action resolution). Nothing is wrong with this build; re-run its checks once GitHub recovers."
      echo "::warning::CI failures are GitHub setup failures, not code (wait ${infra_waits}/5) — re-running the failed jobs"
      gh run list --repo "$REPO" --branch "$BRANCH" --limit 5 --json databaseId,conclusion \
        --jq '.[]|select(.conclusion=="failure")|.databaseId' 2>/dev/null \
        | while read -r r; do gh run rerun "$r" --failed >/dev/null 2>&1 || true; done
      sleep 180
      ci="$(ci_state "$pr")"
    done

    # Success needs CI to have actually PASSED. CI that never ran is not CI that passed — accepting
    # `none` is how #949 reached "ready for final merge" with four workflow runs still held at
    # `action_required` and zero checks on the head commit.
    if [ "$e2e_rc" = 0 ] && [ "$ci" = pass ]; then
      return 0
    fi

    # Neither of these is something the AI can fix by editing code, so they skip the fix loop.
    [ "$ci" = blocked ] && bail "the PR's workflow runs are held at 'action_required' — a maintainer must approve them before CI can run. Nothing is wrong with the build; it just cannot be verified yet."
    [ "$ci" = none ] && bail "PR #$pr registered no CI checks within 30 minutes — refusing to report a build as verified when its CI never ran. Check the CI trigger for bot-pushed commits."

    attempt=$((attempt+1))
    [ "$attempt" -ge "$MAX_ATTEMPTS" ] && bail "still failing after ${MAX_ATTEMPTS} fix attempts (e2e_rc=${e2e_rc}, ci=${ci}). Last e2e: $(tail -c 800 /tmp/e2e.log 2>/dev/null); last CI: $(tail -c 800 /tmp/ci.log 2>/dev/null)"

    ctx="Fix so BOTH the feature e2e passes on the running app AND the PR's required CI is green."
    [ "$e2e_rc" != 0 ] && ctx="$ctx"$'\n\nFeature e2e output:\n'"$(tail -c 3000 /tmp/e2e.log 2>/dev/null)"
    # List ALL failing checks (not just the required aggregate) so the fixer sees the real culprit,
    # e.g. "Lint: Code duplication (jscpd)" rather than just "CI Passed".
    [ "$ci" = fail ] && ctx="$ctx"$'\n\nFailing CI checks:\n'"$(gh pr checks "$pr" --repo "$REPO" 2>/dev/null | grep -iE 'fail')"
    run_claude "The build for issue #${ISSUE} is not passing yet. ${ctx}. Investigate and fix in this repo. Do NOT touch .github. Do NOT commit — leave the fixes in the working tree." /tmp/fix.json "$FIX_TURNS"
    case $? in
      0|3) : ;;   # 3 = ran out of turns; commit whatever it managed and re-verify (bounded by MAX_ATTEMPTS)
      2) pause_and_exit "hit a usage limit during a fix attempt (attempt ${attempt})" ;;
      *) bail "the AI fix step errored on attempt ${attempt}" ;;
    esac
    git restore --source=HEAD --staged --worktree -- .github 2>/dev/null || true
    git add -A
    if ! git diff --cached --quiet; then
      git commit -q -m "fix: address e2e/CI failures (attempt ${attempt}, #${ISSUE})" || bail "git commit failed during fix (attempt ${attempt})"
    fi
    push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH" || bail "could not push fix on attempt ${attempt}"
  done
}

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
git -C "$WORK" config user.email "dor-agent@fortigi.nl"    >/dev/null 2>&1 || true
git -C "$WORK" config user.name  "IdentityAtlas DoR agent" >/dev/null 2>&1 || true

issue_mentions() {  # requestor (author) + commenters, deduped, bots excluded, @-prefixed
  gh issue view "$ISSUE" --repo "$REPO" --json author,comments \
    --jq '([.author.login]+[.comments[].author.login]) | map(select(. and (endswith("[bot]")|not) and (.!="github-actions"))) | unique | map("@"+.) | join(" ")'
}

# A short, deterministic description of what a commit changed (files touched), for report comments —
# more useful than the AI'\''s terse final message. $1 = git range (e.g. origin/main..HEAD).
changed_summary() {
  local stat; stat="$(git -C "$WORK" diff --stat "$1" 2>/dev/null | tail -8)"
  [ -n "$stat" ] && printf 'Files changed:\n```\n%s\n```' "$stat"
}
comment_issue() { gh issue comment "$ISSUE" --repo "$REPO" --body "$1" >/dev/null 2>&1 || true; }

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
  return 0
}

# Make git push/fetch on THIS checkout authenticate as the BOT app instead of the job's GITHUB_TOKEN.
# GitHub suppresses workflow runs for commits pushed with GITHUB_TOKEN (anti-recursion) — which is why
# the bot PR got ZERO CI checks. Pushing as the app makes the PR's CI actually run. Call once, after
# checkout, before any push. (BOARD_TOKEN must carry contents:write.)
use_bot_remote() {
  git -C "$WORK" config --local --unset-all 'http.https://github.com/.extraheader' 2>/dev/null || true
  git -C "$WORK" remote set-url origin "https://x-access-token:${BOARD_TOKEN}@github.com/${REPO}.git"
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
  git -C "$WORK" restore --source=origin/main --staged --worktree -- .github 2>/dev/null || true
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
  specs=$(git -C "$WORK" diff --name-only origin/main..HEAD -- 'app/ui/e2e/*.spec.js' 2>/dev/null | sed 's#app/ui/e2e/##' | tr '\n' ' ')
  if [ -z "${specs// }" ]; then
    # No feature e2e touched — fall back to a smoke check that the populated app serves.
    [ "$(curl -fsS -o /dev/null -w '%{http_code}' http://localhost:3001/ 2>/dev/null || echo 000)" = 200 ]; return
  fi
  ( cd "$DIR/app/ui" \
    && npm ci >/tmp/e2e-npm.log 2>&1 \
    && npx playwright install --with-deps chromium >/tmp/e2e-pw.log 2>&1 \
    && E2E_BASE_URL=http://localhost:3001 npx playwright test $specs --config=playwright.ci.config.js --project=chromium >/tmp/e2e.log 2>&1 )
}

# Settle the PR's required checks and classify: echoes `pass`, `fail`, or `none` (no checks at all).
# The required "CI Passed" gate registers a little AFTER the push (it `needs:` every other job), so a
# naive poll races it and sees "no required checks reported" — which must NOT be read as a failure.
# Retry until the checks register, then --watch blocks until they finish (so "pending" never leaks).
# Only conclude `none` if nothing ever registers within the window (a genuinely CI-less change).
ci_state() {
  local pr="$1" out rc waited=0
  while [ "$waited" -lt 1800 ]; do
    out="$(timeout 1500 gh pr checks "$pr" --repo "$REPO" --required --watch 2>&1)"; rc=$?
    echo "$out" > /tmp/ci.log
    if echo "$out" | grep -qiE 'no( required)? checks reported'; then
      sleep 45; waited=$((waited+45)); continue   # not registered yet — wait for CI to appear
    fi
    [ "$rc" = 0 ] && { echo pass; return; }
    echo fail; return
  done
  echo none
}

# The verify loop shared by both flows: deploy+seed → e2e on live env → CI. The AI fixer is invoked
# ONLY on a REAL failure (e2e failed, or a required check is red) — never merely because CI hasn't
# reported yet (that spin is what burned a week of budget). $1 = the open PR number.
verify_loop() {
  local pr="$1" attempt=0 e2e_rc ci ctx
  while : ; do
    deploy_and_seed || bail "deploy/seed of the live env failed on $HOST (infra)"
    run_feature_e2e; e2e_rc=$?
    ci="$(ci_state "$pr")"

    # Success: the feature e2e passed AND CI is not red. ("none" = the PR registered no checks; accept
    # on the e2e pass but flag it, since after the bot-push fix checks should appear.)
    if [ "$e2e_rc" = 0 ] && [ "$ci" != fail ]; then
      [ "$ci" = none ] && echo "::warning::PR #$pr registered no CI checks — accepting on the e2e pass; check the CI trigger."
      return 0
    fi

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
    git restore --source=origin/main --staged --worktree -- .github 2>/dev/null || true
    git add -A
    if ! git diff --cached --quiet; then
      git commit -q -m "fix: address e2e/CI failures (attempt ${attempt}, #${ISSUE})" || bail "git commit failed during fix (attempt ${attempt})"
    fi
    git push --force-with-lease origin "$BRANCH" || bail "could not push fix on attempt ${attempt}"
  done
}

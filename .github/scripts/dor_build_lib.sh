#!/usr/bin/env bash
# Shared helpers for the DoR build-side flows that run ON a dor-build sidekick:
#   dor_build_flow.sh     — the initial build (implement → PR → verify → notify)
#   dor_feedback_flow.sh  — a requestor-feedback adjustment on an already-built feature
#
# Source this ("source dor_build_lib.sh"); do NOT execute it. The caller must export at least
# ISSUE REPO URL HOST WORK GH_TOKEN BOARD_TOKEN before sourcing; everything else is derived here so
# both flows stay in lock-step. Set FLOW_NOUN (e.g. "build" / "adjustment") before sourcing to tune
# the human-facing wording of bail().

export PATH="$HOME/.local/bin:$PATH"

# ── Derived config (identical across both flows) ──────────────────────────────────────────────────
BRANCH="dor/issue-${ISSUE}"
DIR="$HOME/stacks/dor-${ISSUE}"                 # persistent deploy dir = the functional-test env
SCRIPTS="$WORK/.github/scripts"                 # restored to committed state before we call them
MODEL="${DOR_BUILD_MODEL:-claude-fable-5}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-8}"
MAINTAINERS="@WimvandenHeijkant @TaekeK @robb536"
PLUGINS="entra-group-category-tree resource-type-tree resource-cluster scope-hierarchy risky-consent"
FLOW_NOUN="${FLOW_NOUN:-build}"

# Self-hosted runners have no git identity of their own; without one `git commit` aborts
# ("unable to auto-detect email address") and the flow would push an empty branch and then fail
# confusingly at PR-create ("No commits between main and ..."). Pin a local identity on the checkout.
git -C "$WORK" config user.email "dor-agent@fortigi.nl"    >/dev/null 2>&1 || true
git -C "$WORK" config user.name  "IdentityAtlas DoR agent" >/dev/null 2>&1 || true

issue_mentions() {  # requestor (author) + commenters, deduped, bots excluded, @-prefixed
  gh issue view "$ISSUE" --repo "$REPO" --json author,comments \
    --jq '([.author.login]+[.comments[].author.login]) | map(select(. and (endswith("[bot]")|not))) | unique | map("@"+.) | join(" ")'
}
comment_issue() { gh issue comment "$ISSUE" --repo "$REPO" --body "$1" >/dev/null 2>&1 || true; }

# Route to the Exceptions column + notify maintainers, then stop. Called on any unrecoverable failure.
bail() {
  local reason="$1"
  echo "::error::${FLOW_NOUN} flow failed: ${reason}"
  touch "${RUNNER_TEMP:-/tmp}/dor-bailed"   # tell the workflow's failure backstop we already handled it
  git -C "$WORK" restore --source=HEAD --staged --worktree -- .github 2>/dev/null || true
  GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" exception 2>/dev/null || true
  gh issue edit "$ISSUE" --repo "$REPO" --add-label needs-triage >/dev/null 2>&1 || true
  comment_issue "$(printf '⚠️ %s — the automated %s for this feature hit a problem and was moved to **Exceptions** for triage.\n\n**What broke:** %s\n\nBranch `%s` on **%s**. A maintainer needs to look.' "$MAINTAINERS" "$FLOW_NOUN" "$reason" "$BRANCH" "$HOST")"
  exit 1
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

# All required PR checks green? Blocks (watch) until they settle or ~25 min. 0=all pass/skip.
poll_ci() { timeout 1800 gh pr checks "$1" --repo "$REPO" --required --watch >/tmp/ci.log 2>&1; }

# The verify loop shared by both flows: deploy+seed → e2e on live env → CI green; AI-fix + retry up
# to MAX_ATTEMPTS; bail on infra failure or exhaustion. $1 = the open PR number.
verify_loop() {
  local pr="$1" attempt=0 e2e_ok ci_ok ctx
  while : ; do
    deploy_and_seed || bail "deploy/seed of the live env failed on $HOST (infra)"
    e2e_ok=0; run_feature_e2e && e2e_ok=1
    ci_ok=0; [ "$e2e_ok" = 1 ] && { poll_ci "$pr" && ci_ok=1; }
    [ "$e2e_ok" = 1 ] && [ "$ci_ok" = 1 ] && return 0

    attempt=$((attempt+1))
    [ "$attempt" -ge "$MAX_ATTEMPTS" ] && bail "still failing after ${MAX_ATTEMPTS} fix attempts (e2e_ok=${e2e_ok}, ci_ok=${ci_ok}). Last e2e: $(tail -c 800 /tmp/e2e.log 2>/dev/null); last CI: $(tail -c 800 /tmp/ci.log 2>/dev/null)"

    ctx="Fix so BOTH the feature e2e passes on the running app AND the PR's CI goes green."
    [ "$e2e_ok" = 0 ] && ctx="$ctx"$'\n\nFeature e2e output:\n'"$(tail -c 3000 /tmp/e2e.log 2>/dev/null)"
    [ "$ci_ok" = 0 ] && [ "$e2e_ok" = 1 ] && ctx="$ctx"$'\n\nFailing CI checks:\n'"$(gh pr checks "$pr" --repo "$REPO" --required 2>/dev/null | grep -iE 'fail')"
    claude -p "The build for issue #${ISSUE} is not passing yet. ${ctx}. Investigate and fix in this repo. Do NOT touch .github. Do NOT commit — just leave the fixes in the working tree." \
      --allowedTools "Read,Edit,Write,Bash,Grep,Glob" --model "$MODEL" --fallback-model claude-opus-5 --output-format json >/tmp/fix.json 2>&1 \
      || bail "the AI fix step errored on attempt ${attempt}"
    git restore --source=origin/main --staged --worktree -- .github 2>/dev/null || true
    git add -A
    if ! git diff --cached --quiet; then
      git commit -q -m "fix: address e2e/CI failures (attempt ${attempt}, #${ISSUE})" || bail "git commit failed during fix (attempt ${attempt})"
    fi
    git push --force-with-lease origin "$BRANCH" || bail "could not push fix on attempt ${attempt}"
  done
}

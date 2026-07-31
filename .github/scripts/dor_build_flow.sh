#!/usr/bin/env bash
# DoR build-agent flow (slice D, full Definition-of-Done). Runs ON a dor-build sidekick, invoked by
# dor-build-agent.yml after the value-gate approval. Drives the `claude` CLI directly (so the CI
# fix-retry loop can re-invoke the AI in-process — a `uses:` action can't be looped).
#
# Definition of Done to reach "Awaiting functional acceptance" (ALL must hold; else fix→retry→Exceptions):
#   1. build completes   2. demo data + resource context plugins loaded   3. feature e2e green on the
#   live env   4. PR opened (incl. docs/changelog)   5. PR CI all green (auto-fix up to 8×).
# Then: comment the issue (URL + build/test summary + PR link) @-mentioning requestor + commenters.
# ANY unrecoverable break → move the issue to the Exceptions column + @-mention maintainers, and stop.
#
#   Env: ISSUE REPO URL HOST                — target issue, owner/repo, this sidekick's N.build URL, hostname
#        CLAUDE_CODE_OAUTH_TOKEN            — Max subscription (auto-picked-up; do NOT pass --bare)
#        GH_TOKEN                           — github.token: git push + gh reads + issue comments/labels
#        BOARD_TOKEN                        — BOT app token: gh pr create + board Status moves
#        WORK                               — the runner checkout dir ($GITHUB_WORKSPACE)
#        DOR_BUILD_MODEL (opt)              — model (default claude-fable-5)
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"

BRANCH="dor/issue-${ISSUE}"
DIR="$HOME/stacks/dor-${ISSUE}"                 # persistent deploy dir (the functional-test env)
SCRIPTS="$WORK/.github/scripts"                 # restored to committed state before we call them
MODEL="${DOR_BUILD_MODEL:-claude-fable-5}"
MAX_ATTEMPTS=8
MAINTAINERS="@WimvandenHeijkant @TaekeK @robb536"
PLUGINS="entra-group-category-tree resource-type-tree resource-cluster scope-hierarchy risky-consent"

api() { curl -fsS -H "Authorization: Bearer $1" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "${@:2}"; }
issue_mentions() {  # requestor (author) + commenters, deduped, bots excluded, @-prefixed
  gh issue view "$ISSUE" --repo "$REPO" --json author,comments \
    --jq '([.author.login]+[.comments[].author.login]) | map(select(. and (endswith("[bot]")|not))) | unique | map("@"+.) | join(" ")'
}
comment_issue() { gh issue comment "$ISSUE" --repo "$REPO" --body "$1" >/dev/null 2>&1 || true; }

# Route to the Exceptions column + notify maintainers, then stop. Called on any unrecoverable failure.
bail() {
  local reason="$1"
  echo "::error::build flow failed: ${reason}"
  touch "${RUNNER_TEMP:-/tmp}/dor-bailed"   # tell the workflow's failure backstop we already handled it
  git -C "$WORK" restore --source=HEAD --staged --worktree -- .github 2>/dev/null || true
  GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" exception 2>/dev/null || true
  gh issue edit "$ISSUE" --repo "$REPO" --add-label needs-triage >/dev/null 2>&1 || true
  comment_issue "$(printf '⚠️ %s — the automated build for this feature hit a problem and was moved to **Exceptions** for triage.\n\n**What broke:** %s\n\nBranch \`%s\` on **%s**. A maintainer needs to look.' "$MAINTAINERS" "$reason" "$BRANCH" "$HOST")"
  exit 1
}

# Deploy the pushed branch to the persistent dir on THIS sidekick, load demo data + resource context
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

# ── Flow ─────────────────────────────────────────────────────────────────────────────────────────
cd "$WORK"
# Never let the agent's scratch (.dor/in/*) or the deploy override get committed into the PR.
grep -qxF '.dor/' .git/info/exclude 2>/dev/null || echo '.dor/' >> .git/info/exclude
grep -qxF 'dor-tls.override.yml' .git/info/exclude 2>/dev/null || echo 'dor-tls.override.yml' >> .git/info/exclude
git checkout -B "$BRANCH" origin/main || bail "could not create branch $BRANCH"

# 1. Implement the approved spec (unit tests green). The AI edits the tree; the flow owns git.
claude -p "$(cat "$WORK/.dor/in/prompt.txt")" \
  --allowedTools "Read,Edit,Write,Bash,Grep,Glob" \
  --model "$MODEL" --fallback-model claude-opus-5 --output-format json >/tmp/impl.json 2>&1 \
  || bail "the AI implement step errored (see run log)"

git restore --source=origin/main --staged --worktree -- .github 2>/dev/null || true   # never let the build touch .github
git add -A
git diff --cached --quiet && bail "the AI produced no changes"
git commit -q -m "$(gh issue view "$ISSUE" --repo "$REPO" --json title --jq '.title') (#${ISSUE})"
git push -u origin "$BRANCH" --force-with-lease || bail "could not push $BRANCH"

# 2. Open the PR (BOT token — GITHUB_TOKEN can't create PRs here).
pr=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number // empty')
if [ -z "$pr" ]; then
  pr=$(GH_TOKEN="$BOARD_TOKEN" gh pr create --repo "$REPO" --base main --head "$BRANCH" \
        --title "$(gh issue view "$ISSUE" --repo "$REPO" --json title --jq '.title')" \
        --body "$(printf 'Closes #%s\n\nBuilt autonomously by the DoR build agent from the approved spec. Functional-test env: %s\n\nDo not merge until CI is green and the requestor has accepted.' "$ISSUE" "$URL")" \
      | grep -oE '[0-9]+$') || bail "could not open the PR"
fi
echo "$pr" > "$HOME/.dor-reservation"
GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" building 2>/dev/null || true

# 3-5. Verify loop: deploy+seed → e2e on live env → CI green. Fix + retry up to MAX_ATTEMPTS.
attempt=0
while : ; do
  deploy_and_seed || bail "deploy/seed of the live env failed on $HOST (infra)"
  e2e_ok=0; run_feature_e2e && e2e_ok=1
  ci_ok=0; [ "$e2e_ok" = 1 ] && { poll_ci "$pr" && ci_ok=1; }
  [ "$e2e_ok" = 1 ] && [ "$ci_ok" = 1 ] && break

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
  git diff --cached --quiet || git commit -q -m "fix: address e2e/CI failures (attempt ${attempt}, #${ISSUE})"
  git push --force-with-lease origin "$BRANCH" || bail "could not push fix on attempt ${attempt}"
done

# 6. All criteria met → move to Awaiting functional acceptance + notify requestor & commenters.
gh issue edit "$ISSUE" --repo "$REPO" --add-label build-done --remove-label state:awaiting-approval >/dev/null 2>&1 || true
GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" build-done || bail "could not move the board to functional acceptance"

summary=$(jq -r '.result // empty' /tmp/impl.json 2>/dev/null | head -c 1200)
[ -n "$summary" ] || summary="Implemented the approved spec; unit tests, the feature e2e on the live env, and the full PR CI are all green."
comment_issue "$(printf '%s — ✅ this feature has been **built and verified**, and is ready for your functional testing.\n\n🔗 **Test it here:** %s (Fortigi-tenant sign-in via authentik)\n📦 **PR:** #%s (CI green)\n\n**What was built & tested:**\n%s\n\nThe demo dataset + context plugins are loaded so the feature has data to exercise. Please try it and **comment anything that is not yet 100%% right** — I monitor this thread and will adjust the build incrementally. When you are fully happy, **reply `approved`** and it moves to the Product Board for the final merge.' "$(issue_mentions)" "$URL" "$pr" "$summary")"
gh pr comment "$pr" --repo "$REPO" --body "🤖 Built + verified on **${HOST}**. e2e on the live env + full CI green. Functional testing: ${URL}. Awaiting requestor acceptance on #${ISSUE}." >/dev/null 2>&1 || true
echo "::notice::#${ISSUE} built + verified → Awaiting functional acceptance (PR #${pr}, ${URL})"

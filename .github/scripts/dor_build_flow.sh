#!/usr/bin/env bash
# DoR build-agent flow (slice D, full Definition-of-Done). Runs ON a dor-build sidekick, invoked by
# dor-build-agent.yml after the value-gate approval. Drives the `claude` CLI directly (so the CI
# fix-retry loop can re-invoke the AI in-process — a `uses:` action can't be looped). Shared deploy /
# e2e / CI / bail helpers live in dor_build_lib.sh.
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
FLOW_NOUN="build"
source "$(dirname "${BASH_SOURCE[0]}")/dor_build_lib.sh"

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
echo "$pr $ISSUE" > "$HOME/.dor-reservation"   # <PR> <ISSUE> — dor-reset/feedback route off this
GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" building 2>/dev/null || true

# 3-5. Verify: deploy+seed → e2e on live env → CI green. Fix + retry up to MAX_ATTEMPTS (else Exceptions).
verify_loop "$pr"

# 6. All criteria met → move to Awaiting functional acceptance + notify requestor & commenters.
gh issue edit "$ISSUE" --repo "$REPO" --add-label build-done --remove-label state:awaiting-approval >/dev/null 2>&1 || true
GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" build-done || bail "could not move the board to functional acceptance"

summary=$(jq -r '.result // empty' /tmp/impl.json 2>/dev/null | head -c 1200)
[ -n "$summary" ] || summary="Implemented the approved spec; unit tests, the feature e2e on the live env, and the full PR CI are all green."
comment_issue "$(printf '%s — ✅ this feature has been **built and verified**, and is ready for your functional testing.\n\n🔗 **Test it here:** %s (Fortigi-tenant sign-in via authentik)\n📦 **PR:** #%s (CI green)\n\n**What was built & tested:**\n%s\n\nThe demo dataset + context plugins are loaded so the feature has data to exercise. Please try it and **comment anything that is not yet 100%% right** — I monitor this thread and will adjust the build incrementally. When you are fully happy, **reply `approved`** and it moves to the Product Board for the final merge.' "$(issue_mentions)" "$URL" "$pr" "$summary")"
gh pr comment "$pr" --repo "$REPO" --body "🤖 Built + verified on **${HOST}**. e2e on the live env + full CI green. Functional testing: ${URL}. Awaiting requestor acceptance on #${ISSUE}." >/dev/null 2>&1 || true
echo "::notice::#${ISSUE} built + verified → Awaiting functional acceptance (PR #${pr}, ${URL})"

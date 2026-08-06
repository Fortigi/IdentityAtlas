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
#        DOR_BUILD_MODEL (opt)              — model (default claude-opus-5; Fable is reserved for the spec side)
set -uo pipefail
FLOW_NOUN="build"
source "$(dirname "${BASH_SOURCE[0]}")/dor_build_lib.sh"

# ── Flow ─────────────────────────────────────────────────────────────────────────────────────────
cd "$WORK"
use_bot_remote   # push as the BOT app so the PR's CI actually runs (GITHUB_TOKEN pushes don't trigger it)
# Never let the agent's scratch (.dor/in/*) or the deploy override get committed into the PR.
grep -qxF '.dor/' .git/info/exclude 2>/dev/null || echo '.dor/' >> .git/info/exclude
grep -qxF 'dor-tls.override.yml' .git/info/exclude 2>/dev/null || echo 'dor-tls.override.yml' >> .git/info/exclude
# Consume the trigger label now so dor-resume.yml can re-apply it to re-dispatch a paused build.
gh issue edit "$ISSUE" --repo "$REPO" --remove-label ready-to-build >/dev/null 2>&1 || true
# Flip the board to Building the moment the build starts (i.e. right after the Product Board approved
# the gate) — not only after the PR is created ~15-20 min later, which would leave it wrongly reading
# "Awaiting approval" for the whole implement phase.
GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" building 2>/dev/null || true

# Resume-aware: if a branch with real work already exists (a previous run paused on a usage limit),
# continue from it instead of re-implementing from scratch — that is the expensive part we must not
# repeat (and re-running implement would just re-hit the limit).
git fetch origin "$BRANCH" -q 2>/dev/null || true
if git rev-parse --verify -q "origin/$BRANCH" >/dev/null && [ -n "$(git log --oneline "origin/main..origin/$BRANCH" 2>/dev/null)" ]; then
  echo "::notice::resuming from existing branch $BRANCH — skipping implement"
  git checkout -B "$BRANCH" "origin/$BRANCH" || bail "could not check out $BRANCH to resume"
else
  git checkout -B "$BRANCH" origin/main || bail "could not create branch $BRANCH"

  # 1. Implement the approved spec (unit tests green). The AI edits the tree; the flow owns git.
  run_claude "$(cat "$WORK/.dor/in/prompt.txt")" /tmp/impl.json "$IMPLEMENT_TURNS"
  case $? in
    0|3) : ;;   # 3 = ran out of turns; proceed with what it produced (the no-changes guard below catches an empty result)
    2) pause_and_exit "hit a usage limit during implement" ;;
    *) bail "the AI implement step errored (see run log)" ;;
  esac

  git restore --source=origin/main --staged --worktree -- .github 2>/dev/null || true   # never let the build touch .github
  git add -A
  git diff --cached --quiet && bail "the AI produced no changes"
  git commit -q -m "$(gh issue view "$ISSUE" --repo "$REPO" --json title --jq '.title') (#${ISSUE})" || bail "git commit failed"
  git push -u origin "$BRANCH" --force-with-lease || bail "could not push $BRANCH"
fi

# 2. Open the PR (BOT token — GITHUB_TOKEN can't create PRs here).
pr=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number // empty')
if [ -z "$pr" ]; then
  pr=$(GH_TOKEN="$BOARD_TOKEN" gh pr create --repo "$REPO" --base main --head "$BRANCH" \
        --title "$(gh issue view "$ISSUE" --repo "$REPO" --json title --jq '.title')" \
        --body "$(printf 'Closes #%s\n\nBuilt autonomously by the DoR build agent from the approved spec. Functional-test env: %s\n\nDo not merge until CI is green and the requestor has accepted.' "$ISSUE" "$URL")" \
      | grep -oE '[0-9]+$') || bail "could not open the PR"
fi
claim_sidekick "$pr"   # ~/.dor-reservation + the sk:<label> that reset/feedback dispatch off
# (board was already moved to Building at the start of the run) — now post the PR + follow link.
comment_issue "$(printf '🔨 Building (PR #%s) — I'\''ll comment when it'\''s ready to test.%s' "$pr" "${RUN_URL:+ · 👀 [follow progress]($RUN_URL)}")"

# 3-5. Verify: deploy+seed → e2e on live env → CI green. Fix + retry up to MAX_ATTEMPTS (else Exceptions).
verify_loop "$pr"

# 6. All criteria met → move to Awaiting functional acceptance + notify requestor & commenters.
touch "${RUNNER_TEMP:-/tmp}/dor-done"   # tell the workflow's fresh-token reconcile step this succeeded
gh issue edit "$ISSUE" --repo "$REPO" --add-label build-done --remove-label state:awaiting-approval >/dev/null 2>&1 || true
# Best-effort: on a >1h build the BOARD_TOKEN (minted at job start, 1h life) may have expired. The
# build-done LABEL above is canonical for the acceptance workflow; the board column is reconciled by
# the workflow's always-run fresh-token step. So this is NOT fatal — the notify below must still run.
GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" build-done 2>/dev/null \
  || echo "::warning::board move failed (BOT token likely expired on a long build) — label is set; the fresh-token step reconciles the column"

summary=$(jq -r '.result // empty' /tmp/impl.json 2>/dev/null | head -c 1200)
[ "${#summary}" -lt 25 ] && summary="$(changed_summary origin/main...HEAD)"   # terse output → describe from the diff
[ -n "$summary" ] || summary="Implemented the approved spec; unit tests and the feature e2e on the live env pass."
comment_issue "$(printf '%s — ✅ built and ready to test.\n\n🔗 **Test:** %s   ·   📦 **PR:** #%s\n\n%s\n\nReply with anything that'\''s off, or **`approved`** to send it to merge.' "$(issue_mentions)" "$URL" "$pr" "$summary")"
gh pr comment "$pr" --repo "$REPO" --body "🤖 Built + verified on **${HOST}** (e2e + CI green) → ${URL}" >/dev/null 2>&1 || true
echo "::notice::#${ISSUE} built + verified → Awaiting functional acceptance (PR #${pr}, ${URL})"

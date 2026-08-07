#!/usr/bin/env bash
# DoR feedback flow (loop E). Runs ON the sidekick that holds a feature currently in "Awaiting
# functional acceptance", invoked by dor-feedback.yml when the requestor (or a member) comments
# something that is NOT "approved". The AI adjusts the implementation to address the feedback,
# re-deploys to the same live env, re-verifies (feature e2e + PR CI, auto-fix up to 8×), and reports
# back on the issue — the board stays in Awaiting functional acceptance for another look. Shares the
# deploy / e2e / CI / bail helpers with the initial build via dor_build_lib.sh.
#
#   Env: ISSUE REPO URL HOST WORK        — same as the build flow
#        FEEDBACK                        — the requestor's comment body (what to change)
#        FEEDBACK_AUTHOR                 — the commenter's login (for the ack)
#        GH_TOKEN BOARD_TOKEN CLAUDE_CODE_OAUTH_TOKEN DOR_BUILD_MODEL — as the build flow
set -uo pipefail
FLOW_NOUN="adjustment"
source "$(dirname "${BASH_SOURCE[0]}")/dor_build_lib.sh"

cd "$WORK"
use_bot_remote   # push as the BOT app so the PR's CI actually runs
grep -qxF '.dor/' .git/info/exclude 2>/dev/null || echo '.dor/' >> .git/info/exclude
grep -qxF 'dor-tls.override.yml' .git/info/exclude 2>/dev/null || echo 'dor-tls.override.yml' >> .git/info/exclude

# The build branch must still exist + have an open PR — otherwise there's nothing to adjust (already
# merged / reset). That's not an Exception; just tell the thread and stop.
git fetch origin "$BRANCH" -q 2>/dev/null || { comment_issue "🤖 I don't have an active build branch for this issue any more, so there's nothing to adjust here."; exit 0; }
git checkout -B "$BRANCH" "origin/$BRANCH" || bail "could not check out $BRANCH to adjust"
pr=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number // empty')
[ -n "$pr" ] || { comment_issue "🤖 The PR for this build is no longer open, so there's nothing to adjust. Re-open it or file a new request."; exit 0; }

comment_issue "$(printf '🤖 On it — adjusting for your feedback, then re-deploying to %s.%s' "$URL" "${RUN_URL:+ · 👀 [follow progress]($RUN_URL)}")"
# The AI is now working — reflect that on the board (not "Awaiting functional acceptance", which reads
# as "ready for you to test"). Restored to functional acceptance when the adjustment is deployed.
GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" building 2>/dev/null || true

# 1. Adjust the implementation to address the feedback (AI edits the tree; the flow owns git).
run_claude "$(printf 'You are the DoR build agent for IdentityAtlas. Issue #%s is in functional acceptance and the requestor left this feedback:\n\n---\n%s\n---\n\nAdjust the implementation on this branch to address it. Keep scope to the feedback. Follow CLAUDE.md (fix at the source; ship/extend tests so coverage does not drop; update any affected docs + the changes/dor-issue-%s.md fragment). Update or extend the feature Playwright e2e under app/ui/e2e/ if the behaviour changed. Do NOT modify anything under .github. Do NOT commit or push — leave the changes in the working tree.' "$ISSUE" "$FEEDBACK" "$ISSUE")" /tmp/adjust.json "$IMPLEMENT_TURNS"
case $? in
  0|3) : ;;   # 3 = ran out of turns; proceed with what it produced (no-changes guard below catches an empty result)
  2) pause_and_exit "hit a usage limit while adjusting for feedback" ;;
  *) bail "the AI adjustment step errored (see run log)" ;;
esac

git restore --source=HEAD --staged --worktree -- .github 2>/dev/null || true
git add -A
if git diff --cached --quiet; then
  touch "${RUNNER_TEMP:-/tmp}/dor-done"   # success (nothing to change) → the reconcile step keeps it at functional acceptance
  GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" build-done 2>/dev/null || true   # nothing to rebuild → back to functional acceptance
  comment_issue "$(printf '🤖 @%s — couldn'\''t find a concrete change to make from that. Which specific behaviour should change? (Or reply **`approved`** if it'\''s fine.)' "$FEEDBACK_AUTHOR")"
  exit 0
fi
git commit -q -m "fix: address requestor feedback (#${ISSUE})" || bail "git commit failed"

# 1b. For a BUG, re-prove that the regression test still catches the bug. The original red proof came
# free from commit ordering — the test existed before the fix did. This adjustment edits a tree where
# the fix is already present, so "the tests pass" proves nothing on its own, and the cheapest way to
# satisfy awkward feedback is to quietly weaken the test. Putting production back to main and
# requiring a failure is what makes that impossible.
if is_bug; then
  prove_red_against_main "origin/main...HEAD"
  case $? in
    0) echo "::notice::re-proved red — the regression test still fails without the fix" ;;
    1) bail "after this adjustment the regression test PASSES without the fix, so it no longer catches #${ISSUE}. The change itself may be fine, but the test that is supposed to guard it has stopped doing so — a human should look before this goes further." ;;
    3) echo "::notice::nothing to re-prove in this adjustment (no test + production pair)" ;;
    *) echo "::warning::could not re-prove the test red — continuing, but that guarantee is unverified this round" ;;
  esac
fi

push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH" || bail "could not push the adjustment for #${ISSUE}"

# 2. Re-deploy + re-verify on the live env (feature e2e + PR CI, auto-fix up to 8×; else Exceptions).
verify_loop "$pr"

# 3. Adjustment deployed + verified → back to Awaiting functional acceptance, and report back.
touch "${RUNNER_TEMP:-/tmp}/dor-done"   # success → the workflow's fresh-token reconcile step asserts build-done (survives >1h cycles)
GH_TOKEN="$BOARD_TOKEN" bash "$SCRIPTS/dor_set_status.sh" "$ISSUE" build-done 2>/dev/null || true
summary=$(jq -r '.result // empty' /tmp/adjust.json 2>/dev/null | head -c 1000)
[ "${#summary}" -lt 25 ] && summary="$(changed_summary origin/main...HEAD)"   # terse output → describe from the diff
[ -n "$summary" ] || summary="Applied your feedback; the feature e2e on the live env is green again."
comment_issue "$(printf '%s — ✅ updated and re-deployed.\n\n🔗 **Re-test:** %s   ·   📦 **PR:** #%s\n\n%s\n\nAnything still off? Comment. Happy? Reply **`approved`**.' "$(issue_mentions)" "$URL" "$pr" "$summary")"
echo "::notice::#${ISSUE} adjusted per feedback → still Awaiting functional acceptance (PR #${pr})"

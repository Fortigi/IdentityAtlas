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
grep -qxF '.dor/' .git/info/exclude 2>/dev/null || echo '.dor/' >> .git/info/exclude
grep -qxF 'dor-tls.override.yml' .git/info/exclude 2>/dev/null || echo 'dor-tls.override.yml' >> .git/info/exclude

# The build branch must still exist + have an open PR — otherwise there's nothing to adjust (already
# merged / reset). That's not an Exception; just tell the thread and stop.
git fetch origin "$BRANCH" -q 2>/dev/null || { comment_issue "🤖 I don't have an active build branch for this issue any more, so there's nothing to adjust here."; exit 0; }
git checkout -B "$BRANCH" "origin/$BRANCH" || bail "could not check out $BRANCH to adjust"
pr=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number // empty')
[ -n "$pr" ] || { comment_issue "🤖 The PR for this build is no longer open, so there's nothing to adjust. Re-open it or file a new request."; exit 0; }

comment_issue "$(printf '🤖 @%s — on it. Adjusting the build to address your feedback, then I'\''ll re-deploy to %s and report back.' "$FEEDBACK_AUTHOR" "$URL")"

# 1. Adjust the implementation to address the feedback (AI edits the tree; the flow owns git).
claude -p "$(printf 'You are the DoR build agent for IdentityAtlas. Issue #%s is in functional acceptance and the requestor left this feedback:\n\n---\n%s\n---\n\nAdjust the implementation on this branch to address it. Keep scope to the feedback. Follow CLAUDE.md (fix at the source; ship/extend tests so coverage does not drop; update any affected docs + the changes/dor-issue-%s.md fragment). Update or extend the feature Playwright e2e under app/ui/e2e/ if the behaviour changed. Do NOT modify anything under .github. Do NOT commit or push — leave the changes in the working tree.' "$ISSUE" "$FEEDBACK" "$ISSUE")" \
  --allowedTools "Read,Edit,Write,Bash,Grep,Glob" \
  --model "$MODEL" --fallback-model claude-opus-5 --output-format json >/tmp/adjust.json 2>&1 \
  || bail "the AI adjustment step errored (see run log)"

git restore --source=origin/main --staged --worktree -- .github 2>/dev/null || true
git add -A
if git diff --cached --quiet; then
  comment_issue "$(printf '🤖 @%s — I looked at that but couldn'\''t find a concrete code change to make from it. Could you point me at the specific behaviour to change? (Or reply `approved` if it'\''s actually fine as-is.)' "$FEEDBACK_AUTHOR")"
  exit 0
fi
git commit -q -m "fix: address requestor feedback (#${ISSUE})"
git push --force-with-lease origin "$BRANCH" || bail "could not push the adjustment for #${ISSUE}"

# 2. Re-deploy + re-verify on the live env (feature e2e + PR CI, auto-fix up to 8×; else Exceptions).
verify_loop "$pr"

# 3. Report back — still in Awaiting functional acceptance for another look.
summary=$(jq -r '.result // empty' /tmp/adjust.json 2>/dev/null | head -c 1000)
[ -n "$summary" ] || summary="Applied your feedback; the feature e2e on the live env and the full PR CI are green again."
comment_issue "$(printf '%s — ✅ updated per your feedback and re-deployed.\n\n🔗 **Re-test here:** %s\n📦 **PR:** #%s (CI green)\n\n**What changed:**\n%s\n\nTake another look — comment anything still off, or reply `approved` when you'\''re happy and it moves to the Product Board for merge.' "$(issue_mentions)" "$URL" "$pr" "$summary")"
echo "::notice::#${ISSUE} adjusted per feedback → still Awaiting functional acceptance (PR #${pr})"

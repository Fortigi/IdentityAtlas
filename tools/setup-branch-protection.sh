#!/usr/bin/env bash
# ─── Branch Protection Setup ─────────────────────────────────────────────────
# Run once after creating or transferring the repository.
# Requires: gh CLI authenticated as a repository admin.
#
# What this configures:
#
#   main         (classic branch protection)
#     - Require PR with 1 approval before merging
#     - Require "PR Summary" status check
#     - Dismiss stale reviews on push
#     - enforce_admins: false  ← lets VERSION_BUMP_PAT push the version bump commit
#
# Release model uses git tags (v5.2.0, v5.2.1, ...) rather than long-lived
# release branches. Hotfix branches (bugfixes/*) are short-lived and deleted
# after cherry-picking to main — no special protection needed.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO="${1:-Fortigi/IdentityAtlas}"
echo "Configuring branch protection for: $REPO"

# ── main — classic branch protection ────────────────────────────────────────
echo ""
echo "Setting classic branch protection on main..."
gh api "repos/$REPO/branches/main/protection" \
  --method PUT \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["PR Summary"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "required_approving_review_count": 1,
    "require_last_push_approval": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false
}
JSON
echo "✅ main branch protection set"

# ── Remove legacy release/** ruleset if it exists ───────────────────────────
echo ""
echo "Checking for legacy release/** ruleset..."
EXISTING_ID=$(gh api "repos/$REPO/rulesets" | \
  python3 -c "import sys,json; rs=[r['id'] for r in json.load(sys.stdin) if r['name']=='Protect release branches']; print(rs[0] if rs else '')" 2>/dev/null || true)

if [ -n "$EXISTING_ID" ]; then
  echo "  Removing legacy release/** ruleset (id=$EXISTING_ID)..."
  gh api "repos/$REPO/rulesets/$EXISTING_ID" --method DELETE
  echo "  ✅ Legacy ruleset removed"
else
  echo "  No legacy ruleset found — nothing to remove"
fi

echo ""
echo "Done. Branch protection summary:"
echo "  main  → PR required (1 approval) + PR Summary check + no force-push"
echo "  tags  → No branch protection needed (tags are immutable by default)"
echo ""
echo "Release model: git tags (v5.2.0, v5.2.1, ...) via Actions → Cut Release / Cut Hotfix"

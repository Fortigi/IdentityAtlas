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

# ── gh-pages — ruleset (no deletion, no force-push) ─────────────────────────
# mike commits versioned doc builds directly to this branch from CI via
# regular fast-forward pushes — it never deletes the branch or force-pushes.
# GitHub Apps (including github-actions[bot]) cannot be bypass actors on
# repo-level rulesets, so no bypass is needed: the rules only block operations
# mike never performs.
echo ""
echo "Setting gh-pages ruleset..."

# Remove existing gh-pages ruleset if present (idempotent re-runs)
GHPAGES_ID=$(gh api "repos/$REPO/rulesets" --jq '[.[] | select(.name=="Protect gh-pages")] | first | .id // ""' 2>/dev/null || true)
if [ -n "$GHPAGES_ID" ]; then
  gh api "repos/$REPO/rulesets/$GHPAGES_ID" --method DELETE
fi

gh api "repos/$REPO/rulesets" --method POST --input - <<'JSON'
{
  "name": "Protect gh-pages",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/gh-pages"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
JSON
echo "✅ gh-pages ruleset set (no deletion, no force-push)"

# ── Remove legacy release/** ruleset if it exists ───────────────────────────
echo ""
echo "Checking for legacy release/** ruleset..."
EXISTING_ID=$(gh api "repos/$REPO/rulesets" --jq '[.[] | select(.name=="Protect release branches")] | first | .id // ""' 2>/dev/null || true)

if [ -n "$EXISTING_ID" ]; then
  echo "  Removing legacy release/** ruleset (id=$EXISTING_ID)..."
  gh api "repos/$REPO/rulesets/$EXISTING_ID" --method DELETE
  echo "  ✅ Legacy ruleset removed"
else
  echo "  No legacy ruleset found — nothing to remove"
fi

echo ""
echo "Done. Branch protection summary:"
echo "  main      → PR required (1 approval) + PR Summary check + no force-push"
echo "  gh-pages  → no deletion, no force-push (mike uses regular fast-forward pushes)"
echo "  tags      → No branch protection needed (tags are immutable by default)"
echo ""
echo "Release model: git tags (v5.2.0, v5.2.1, ...) via Actions → Cut Release / Cut Hotfix"

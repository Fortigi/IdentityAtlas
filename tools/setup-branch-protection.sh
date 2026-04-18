#!/usr/bin/env bash
# ─── Branch Protection Setup ─────────────────────────────────────────────────
# Run once after creating or transferring the repository.
# Requires: gh CLI authenticated as a repository admin.
#
# What this configures:
#
#   main         (classic branch protection — already set, included here for docs)
#     - Require PR with 1 approval before merging
#     - Require "PR Summary" status check
#     - Dismiss stale reviews on push
#     - enforce_admins: false  ← lets VERSION_BUMP_PAT push the version bump commit
#
#   release/**   (GitHub Ruleset — wildcard patterns need Rulesets API)
#     - Require PR before merging (0 approvals needed)
#     - Require "PR Summary" status check
#     - Block direct pushes (non-fast-forward / force push)
#     - Block branch deletion
#     - Bypass: repository admins (actor_id=5) ← VERSION_BUMP_PAT owner must be admin
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO="${1:-Fortigi/IdentityAtlas}"
echo "Configuring branch protection for: $REPO"

# ── 1. main — classic branch protection ─────────────────────────────────────
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

# ── 2. release/** — GitHub Ruleset ──────────────────────────────────────────
echo ""
echo "Creating ruleset for release/** branches..."

# Delete existing ruleset with the same name if it exists
EXISTING_ID=$(gh api "repos/$REPO/rulesets" | \
  python3 -c "import sys,json; rs=[r['id'] for r in json.load(sys.stdin) if r['name']=='Protect release branches']; print(rs[0] if rs else '')" 2>/dev/null || true)

if [ -n "$EXISTING_ID" ]; then
  echo "  Removing existing ruleset (id=$EXISTING_ID)..."
  gh api "repos/$REPO/rulesets/$EXISTING_ID" --method DELETE
fi

gh api "repos/$REPO/rulesets" --method POST --input - <<'JSON'
{
  "name": "Protect release branches",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/release/**"],
      "exclude": []
    }
  },
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "PR Summary" }
        ]
      }
    }
  ]
}
JSON
echo "✅ release/** ruleset created"

echo ""
echo "Done. Branch protection summary:"
echo "  main         → PR required (1 approval) + PR Summary check"
echo "  release/**   → PR required (0 approvals) + PR Summary check + no force-push + no deletion"
echo "  Bypass       → Repository admins (the VERSION_BUMP_PAT owner must have admin role)"

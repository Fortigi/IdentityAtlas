#!/usr/bin/env bash
# ─── Branch Protection Setup ─────────────────────────────────────────────────
# Run once after creating or transferring the repository.
# Requires: gh CLI authenticated as a repository admin.
#
# What this configures:
#
#   main     (ruleset "Protect main")
#     - Squash-merge only
#     - Require PR with 1 approval + code owner review
#     - Dismiss stale reviews on push
#     - Require "PR Summary" status check (strict)
#     - Require CodeQL to pass (errors + high/higher security alerts)
#     - No deletion, no force-push
#     - Bypass (always):    Fortigi CI bot — pushes version bump commits
#     - Bypass (PR only):   IdentityAtlas-Owners team
#
#   gh-pages (ruleset "Protect gh-pages")
#     - No deletion, no force-push
#     - No bypass needed — mike only does regular fast-forward pushes
#
# Release model uses git tags (v5.2.0, v5.2.1, ...) rather than long-lived
# release branches. Hotfix branches (bugfixes/*) are short-lived and deleted
# after cherry-picking to main — no special protection needed.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO="${1:-Fortigi/IdentityAtlas}"

# Bypass actor IDs (GitHub internal IDs — do not change without verifying)
FORTIGI_CI_BOT_ID=3556461       # Integration: Fortigi CI bot
OWNERS_TEAM_ID=17337877         # Team: IdentityAtlas-Owners

echo "Configuring branch protection for: $REPO"

# ── Helper: delete a ruleset by name if it exists ───────────────────────────
delete_ruleset_by_name() {
  local name="$1"
  local id
  id=$(gh api "repos/$REPO/rulesets" --jq "[.[] | select(.name==\"$name\")] | first | .id // \"\"" 2>/dev/null || true)
  if [ -n "$id" ]; then
    gh api "repos/$REPO/rulesets/$id" --method DELETE
    echo "  Removed existing ruleset: $name (id=$id)"
  fi
}

# ── main — ruleset ───────────────────────────────────────────────────────────
echo ""
echo "Setting ruleset: Protect main..."
delete_ruleset_by_name "Protect main"

gh api "repos/$REPO/rulesets" --method POST --input - <<JSON
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["refs/heads/main"],
      "exclude": []
    }
  },
  "bypass_actors": [
    {
      "actor_id": $FORTIGI_CI_BOT_ID,
      "actor_type": "Integration",
      "bypass_mode": "always"
    },
    {
      "actor_id": $OWNERS_TEAM_ID,
      "actor_type": "Team",
      "bypass_mode": "pull_request"
    }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "allowed_merge_methods": ["squash"],
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": false,
        "required_approving_review_count": 1,
        "required_review_thread_resolution": false,
        "required_reviewers": []
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "required_status_checks": [
          { "context": "PR Summary", "integration_id": 15368 }
        ],
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false
      }
    },
    {
      "type": "code_scanning",
      "parameters": {
        "code_scanning_tools": [
          {
            "tool": "CodeQL",
            "alerts_threshold": "errors",
            "security_alerts_threshold": "high_or_higher"
          }
        ]
      }
    }
  ]
}
JSON
echo "✅ Protect main ruleset set"

# ── gh-pages — ruleset ───────────────────────────────────────────────────────
echo ""
echo "Setting ruleset: Protect gh-pages..."
delete_ruleset_by_name "Protect gh-pages"

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
echo "✅ Protect gh-pages ruleset set"

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
echo "  main      → squash-only PR (1 approval + code owner) + PR Summary + CodeQL"
echo "  gh-pages  → no deletion, no force-push"
echo "  tags      → No branch protection needed (tags are immutable by default)"
echo ""
echo "Release model: git tags (v5.2.0, v5.2.1, ...) via Actions → Cut Release / Cut Hotfix"

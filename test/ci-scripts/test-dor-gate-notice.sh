#!/usr/bin/env bash
# Structural tests for the DoR value gate and the draft-PR contract.
#
# These guard two invariants that are invisible in review and expensive when broken — both were
# broken in production before this file existed:
#
#   1. The job that POSTS the "go and approve" notice must not carry `environment:`. A job gated by
#      required reviewers runs no step until it is approved, so a notice posted from inside the gate
#      arrives after the approval it asks for — the issue just goes quiet. #977 moved the notice
#      into the gated job and did exactly this.
#   2. The build agent must open its PR as a DRAFT, and only acceptance may take it out of draft.
#      A ready-for-review PR with green checks reads as mergeable; for an agent-built change that is
#      false until the requestor has accepted it (#933 sat green through eight rejected rounds).
#
# Usage: bash test/ci-scripts/test-dor-gate-notice.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT="$REPO_ROOT/.github/workflows/dor-build-agent.yml"
ACCEPT="$REPO_ROOT/.github/workflows/dor-acceptance.yml"
FLOW="$REPO_ROOT/.github/scripts/dor_build_flow.sh"

PASS=0
FAIL=0

assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"
    echo "        expected: $expected"
    echo "        actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

# Print the body of one top-level job from a workflow: everything from `  <name>:` at two-space
# indent up to the next two-space-indented key. Enough to see that job's own `environment:`/steps
# without a YAML parser (the runner has no PyYAML guarantee, and these tests must stay dependency-free).
job_body() {
  local file="$1" job="$2"
  awk -v want="  ${job}:" '
    $0 == want { inside = 1; next }
    inside && /^  [a-zA-Z_-]+:/ { exit }
    inside { print }
  ' "$file"
}

echo "DoR value-gate + draft-PR structure"
echo

# ── 1. The notice must be posted from an UNGATED job ─────────────────────────

notify_body="$(job_body "$AGENT" notify)"

assert "a 'notify' job exists to post the value-gate notice" \
  "true" "$([ -n "$notify_body" ] && echo true || echo false)"

assert "the notify job posts the approval link" \
  "true" "$(printf '%s' "$notify_body" | grep -q 'Review & approve to build' && echo true || echo false)"

# THE regression guard. If this fails, the notice can only arrive after the approval it requests.
assert "the notify job has NO environment: (else the notice posts after approval)" \
  "false" "$(printf '%s' "$notify_body" | grep -qE '^ +environment:' && echo true || echo false)"

# ── 2. The gate still holds the environment, and only records ────────────────

gate_body="$(job_body "$AGENT" gate)"

assert "the gate job still holds the build-approval environment" \
  "true" "$(printf '%s' "$gate_body" | grep -qE '^ +environment: build-approval' && echo true || echo false)"

assert "the gate job records who approved" \
  "true" "$(printf '%s' "$gate_body" | grep -q 'approvals' && echo true || echo false)"

# The gate must not be the thing asking for approval — that is the notify job's job.
assert "the gate job does NOT post the approval link" \
  "false" "$(printf '%s' "$gate_body" | grep -q 'Review & approve to build' && echo true || echo false)"

# ── 3. The notice is addressed to the requestor of record ────────────────────

assert "authorize exports the requestor of record" \
  "true" "$(grep -qE '^ +requestor: \$\{\{ steps\.req\.outputs\.login \}\}' "$AGENT" && echo true || echo false)"

assert "the notice addresses the requestor, not a hardcoded list" \
  "true" "$(printf '%s' "$notify_body" | grep -q 'REQUESTOR: ${{ needs.authorize.outputs.requestor }}' && echo true || echo false)"

# ── 4. The PR is opened as a draft, and only acceptance clears it ────────────

assert "the build agent opens the PR as a draft" \
  "true" "$(grep -qE 'gh pr create .*--draft' "$FLOW" && echo true || echo false)"

approve_body="$(job_body "$ACCEPT" approve)"

assert "acceptance marks the PR ready for review" \
  "true" "$(printf '%s' "$approve_body" | grep -q 'gh pr ready' && echo true || echo false)"

# Scoped to the approve job on purpose: another job in this file already holds pull-requests: write,
# so a whole-file grep passes even when the approve job only has `read` and `gh pr ready` would 403.
assert "the approve job holds pull-requests: write (gh pr ready needs it)" \
  "true" "$(printf '%s' "$approve_body" | grep -qE '^ +permission-pull-requests: write' && echo true || echo false)"

# `gh pr ready` must appear ONLY in the acceptance flow — nothing else may undraft the PR.
assert "nothing outside acceptance takes the PR out of draft" \
  "0" "$(grep -rl 'gh pr ready' "$REPO_ROOT/.github" 2>/dev/null | grep -cv 'dor-acceptance.yml' || true)"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

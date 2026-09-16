#!/usr/bin/env bash
# Tests that a sparse checkout left in a sidekick's shared runner workspace can't starve a DoR build.
#
# The regression (#1222): dor-reconcile.yml's hourly sweep-sidekick job ran ON each build box and did a
# non-cone sparse checkout of dor_sidekick_claim.sh into the workspace root — the same directory the
# build job checks out main into. actions/checkout's non-cone sparse mode writes core.sparseCheckout=true
# to .git/config. The build's later FULL checkout runs `git sparse-checkout disable` (which writes false
# only to config.worktree), then drops extensions.worktreeConfig — so .git/config's true wins again and
# `git checkout -B main` re-applies the one-file pattern. Every build on every box then died at "Fetch the
# approved spec" with dor_trusted_spec.sh: No such file or directory.
#
# The cleanup step is executed as shipped (its run block is read out of dor-build-agent.yml), against real
# git repositories that replay actions/checkout's own command sequence. No network, no tokens.
#
# Usage: bash test/ci-scripts/test-dor-sparse-workspace.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT="$REPO_ROOT/.github/workflows/dor-build-agent.yml"
RECONCILE="$REPO_ROOT/.github/workflows/dor-reconcile.yml"
FLOW="$REPO_ROOT/.github/scripts/dor_build_flow.sh"
STEP_NAME='Clear any sparse checkout left in the shared workspace'

PASS=0; FAIL=0
assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"; echo "        expected: $expected"; echo "        actual:   $actual"; FAIL=$((FAIL + 1))
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_CONFIG_GLOBAL="$TMP/gitconfig" GIT_CONFIG_NOSYSTEM=1
git config --file "$GIT_CONFIG_GLOBAL" user.email dor@test
git config --file "$GIT_CONFIG_GLOBAL" user.name dor
git config --file "$GIT_CONFIG_GLOBAL" core.autocrlf false
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main

# The cleanup step's run block, verbatim from the workflow (dedented).
awk -v name="$STEP_NAME" '
  index($0, "- name: " name) { in_step = 1; next }
  in_step && /^ *- name:/     { exit }
  in_step && /^ *run: \|/     { in_run = 1; match($0, /^ */); indent = RLENGTH + 2; next }
  in_run                      { print substr($0, indent + 1) }
' "$AGENT" > "$TMP/cleanup.sh"
assert "the cleanup step's script is found in dor-build-agent.yml" "true" \
  "$(grep -q 'core.sparseCheckout' "$TMP/cleanup.sh" && echo true || echo false)"

# An origin with the files a build needs.
git init -q "$TMP/origin"
mkdir -p "$TMP/origin/.github/scripts"
echo claim > "$TMP/origin/.github/scripts/dor_sidekick_claim.sh"
echo spec  > "$TMP/origin/.github/scripts/dor_trusted_spec.sh"
echo app   > "$TMP/origin/README.md"
git -C "$TMP/origin" add -A && git -C "$TMP/origin" commit -qm init

# actions/checkout, non-cone sparse (what the sweep did in the workspace root).
sweep_checkout() {
  git -C "$1" config core.sparseCheckout true
  mkdir -p "$1/.git/info"
  echo '.github/scripts/dor_sidekick_claim.sh' > "$1/.git/info/sparse-checkout"
  git -C "$1" checkout -q --force -B main origin/main
}
# actions/checkout, full (what the build job does next).
full_checkout() {
  git -C "$1" sparse-checkout disable >/dev/null 2>&1
  git -C "$1" config --local --unset-all extensions.worktreeConfig || true
  git -C "$1" checkout -q --force -B main origin/main
}
run_cleanup() { ( cd "$1" && bash "$TMP/cleanup.sh" ); }
has_spec()    { [ -f "$1/.github/scripts/dor_trusted_spec.sh" ] && [ -f "$1/README.md" ] && echo present || echo missing; }
skipped()     { git -C "$1" ls-files -t | grep -c '^S'; }

# ── Control: without the step, the reproduction really loses the files ──────
git clone -q "$TMP/origin" "$TMP/control"
sweep_checkout "$TMP/control"; full_checkout "$TMP/control"
assert "control: a swept workspace's full checkout still lacks the build's scripts" "missing" "$(has_spec "$TMP/control")"

# ── With the step: the full checkout is whole ───────────────────────────────
git clone -q "$TMP/origin" "$TMP/swept"
sweep_checkout "$TMP/swept"
run_cleanup "$TMP/swept"; rc=$?
full_checkout "$TMP/swept"
assert "the cleanup step succeeds on a swept workspace" "0" "$rc"
assert "after cleanup, the full checkout has every file" "present" "$(has_spec "$TMP/swept")"
assert "…and no index entry is left skip-worktree" "0" "$(skipped "$TMP/swept")"
assert "…and core.sparseCheckout is no longer set" "" "$(git -C "$TMP/swept" config --get core.sparseCheckout)"

# ── Harmless on a workspace that was never sparse, or has no repo yet ───────
git clone -q "$TMP/origin" "$TMP/clean"
run_cleanup "$TMP/clean"; rc=$?
full_checkout "$TMP/clean"
assert "a never-sparse workspace: the step succeeds" "0" "$rc"
assert "a never-sparse workspace: files intact" "present" "$(has_spec "$TMP/clean")"
mkdir -p "$TMP/fresh"
run_cleanup "$TMP/fresh"; rc=$?
assert "a fresh box with no .git: the step is a no-op" "0|false" "$rc|$([ -d "$TMP/fresh/.git" ] && echo true || echo false)"

# ── Wiring ──────────────────────────────────────────────────────────────────
step_line="$(grep -n -- "- name: $STEP_NAME" "$AGENT" | head -1 | cut -d: -f1)"
checkout_line="$(grep -n -- '- name: Checkout main (base for the implementation branch)' "$AGENT" | head -1 | cut -d: -f1)"
assert "the build job clears sparse state immediately before it checks out main" "true" \
  "$([ -n "$step_line" ] && [ -n "$checkout_line" ] && [ "$step_line" -lt "$checkout_line" ] \
      && ! sed -n "$((step_line + 1)),$((checkout_line - 1))p" "$AGENT" | grep -q -- '- name:' && echo true || echo false)"
assert "the sweep checks out into its own folder" "true" \
  "$(grep -q '^ *path: \.dor-sweep$' "$RECONCILE" && echo true || echo false)"
assert "…and sources the helper from that folder" "true" \
  "$(grep -q '^ *source \.dor-sweep/\.github/scripts/dor_sidekick_claim\.sh$' "$RECONCILE" && echo true || echo false)"
assert "the build flow never commits the sweep's folder" "true" \
  "$(grep -qF "echo '.dor-sweep/' >> .git/info/exclude" "$FLOW" && echo true || echo false)"

# Guard for every workflow: a job that runs on a self-hosted box shares its workspace with the builds, so
# any sparse checkout in it must go to its own `path:`.
offenders="$(
  for wf in "$REPO_ROOT"/.github/workflows/*.yml; do
    awk -v wf="$(basename "$wf")" '
      function flush() { if (job != "" && selfhosted && sparse && !pathed) print wf ":" job }
      /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { flush(); job = $1; selfhosted = 0; sparse = 0; pathed = 0; in_co = 0; next }
      /self-hosted/                     { selfhosted = 1 }
      /uses: actions\/checkout@/        { in_co = 1; co_sparse = 0; co_path = 0; next }
      in_co && /^ *sparse-checkout:/    { sparse = 1; co_sparse = 1 }
      in_co && /^ *path:/               { co_path = 1 }
      in_co && /^ *- /                  { in_co = 0; if (co_sparse && co_path) pathed = 1 }
      END { flush() }
    ' "$wf"
  done
)"
assert "no self-hosted job sparse-checks-out into the shared workspace root" "" "$offenders"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

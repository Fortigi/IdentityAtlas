#!/usr/bin/env bash
# Unit tests for push_as_app (.github/scripts/dor_build_lib.sh) — the only way the build side gets
# code off a sidekick.
#
# It pushes to a bare URL rather than to the named remote, deliberately: actions/checkout v7 persists
# credentials that would otherwise win and push as github-actions[bot], whose commits get their
# checks held at `action_required`. But a bare `--force-with-lease` resolves its expected value from
# the remote-TRACKING ref, and a URL push has none — so git rejected every such push with
#
#     ! [rejected]  HEAD -> dor/issue-665  (stale info)
#
# deterministically, the moment the branch already existed. The first push of a build survived only
# because it CREATES the branch. Everything after — verify_loop's CI auto-fix push, and every
# requestor-feedback adjustment — could never push, and bailed the flow to Exceptions instead. #665
# dead-lettered exactly that way, on its first `/rework`.
#
# Nothing covered dor_build_lib.sh or either build flow, which is why it shipped. This is the first
# harness for them: real git against real file:// repositories, no network and no tokens.
#
# Usage: bash test/ci-scripts/test-dor-push-lease.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/.github/scripts/dor_build_lib.sh"

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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── A remote and a working clone, both local ────────────────────────────────
git init --quiet --bare "$TMP/origin.git"
WORK="$TMP/work"
git init --quiet "$WORK"
git -C "$WORK" config user.email t@example.com
git -C "$WORK" config user.name  Test
git -C "$WORK" config core.autocrlf false   # keeps the run quiet on a Windows dev box
commit() { echo "$1" > "$WORK/f.txt"; git -C "$WORK" add f.txt; git -C "$WORK" commit --quiet -m "$1"; }
commit one

# dor_build_lib.sh derives BRANCH from ISSUE and expects these exported before it is sourced. Its
# only side effects at source time are two `git config` calls on $WORK, which is why this is safe.
export ISSUE=665 REPO=Fortigi/IdentityAtlas WORK
export URL=https://example.invalid HOST=sk-test GH_TOKEN=stub BOARD_TOKEN=stub-token
# shellcheck source=/dev/null
source "$LIB"

# Point the app remote at the local bare repo. Overriding the ONE function that builds the URL is
# what makes this testable without a network or a token.
app_remote_url() { printf '%s' "file://$TMP/origin.git"; }

remote_sha() { git -C "$TMP/origin.git" rev-parse --verify --quiet "refs/heads/$BRANCH" || true; }
try()        { if "$@" >/dev/null 2>&1; then echo ok; else echo rejected; fi; }

echo "DoR build side — push_as_app and the force-with-lease trap"
echo

# ── 0. The trap itself, in plain git ────────────────────────────────────────
# Demonstrated directly, with no library involved, so the fix's shape is justified rather than
# asserted. Push to a URL — as push_as_app must, to control which credential authenticates — and a
# BARE --force-with-lease has no remote-tracking ref to resolve its expected value from. git does not
# fall back to "no expectation"; it refuses. Note it only refuses on the SECOND push: the first
# creates the branch, where the expected value is legitimately "absent".
git -C "$WORK" push --quiet "file://$TMP/origin.git" "HEAD:refs/heads/probe"
commit probe2
probe_out="$(git -C "$WORK" push "file://$TMP/origin.git" --force-with-lease "HEAD:refs/heads/probe" 2>&1 || true)"
assert "plain git: a bare lease on a URL push is refused once the branch exists" refused \
  "$(printf '%s' "$probe_out" | grep -qi 'stale info' && echo refused || echo pushed)"

# ── 1. First push CREATES the branch: nothing to lease against ──────────────
# This is the one that always worked, and the reason the bug stayed hidden.
assert "creating the branch succeeds" ok \
  "$(try push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH")"
assert "…and the remote has it" "$(git -C "$WORK" rev-parse HEAD)" "$(remote_sha)"

# ── 2. THE regression: pushing again, to a branch that now exists ───────────
# Bare --force-with-lease + a URL push = "stale info", every time. This is the assertion that fails
# against the unfixed library, and it is the whole of #665's `/rework` failure.
commit two
assert "pushing an update to an existing branch succeeds" ok \
  "$(try push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH")"
assert "…and the remote moved to it" "$(git -C "$WORK" rev-parse HEAD)" "$(remote_sha)"

# ── 3. The lease still bites when a caller states it explicitly ─────────────
# Pass-through must be untouched, and the guard must still be real — otherwise the fix would have
# quietly turned every push into --force.
commit three
assert "an explicit lease with the wrong expected sha is rejected" rejected \
  "$(try push_as_app "--force-with-lease=refs/heads/$BRANCH:$(git -C "$WORK" rev-parse HEAD~2)" \
       "HEAD:refs/heads/$BRANCH")"
assert "…and the remote did NOT move" "$(git -C "$WORK" rev-parse HEAD~1)" "$(remote_sha)"

# ── 4. A push with no lease at all is left alone ────────────────────────────
assert "a plain push still works" ok "$(try push_as_app "HEAD:refs/heads/$BRANCH")"
assert "…and lands" "$(git -C "$WORK" rev-parse HEAD)" "$(remote_sha)"

# ── 5. A refspec that names no branch is not rewritten ──────────────────────
# The lease rewrite keys off `…:refs/heads/…`; a tag push must pass straight through.
git -C "$WORK" tag -f v-test >/dev/null 2>&1
assert "a tag refspec pushes untouched" ok "$(try push_as_app "refs/tags/v-test:refs/tags/v-test")"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

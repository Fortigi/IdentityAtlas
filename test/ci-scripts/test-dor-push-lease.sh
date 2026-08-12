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

# ── 6. The credential actions/checkout leaves behind (#1018) ────────────────
# The second half of "push as the app": choosing the identity. An HTTP Authorization header beats the
# userinfo in the push URL, so while checkout's credential is live the app token on the command line
# is never the one used — the push lands as github-actions[bot] and every workflow run of it is held
# at `action_required`. Nothing failed; the flow just could not verify itself, and dead-lettered.
#
# Reproduce v7's exact shape: the key is NOT in --local, it is in a temp file included by
# `includeIf.gitdir`. That is precisely why the original one-line unset was a silent no-op.
gitdir="$(git -C "$WORK" rev-parse --absolute-git-dir)"
printf '[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic STUB\n' \
  > "$TMP/git-credentials-stub.config"
plant_checkout_credential() {
  git -C "$WORK" config --local "includeIf.gitdir:${gitdir}.path" "$TMP/git-credentials-stub.config"
}
# What git would actually send for a github.com push, resolved across every scope.
live_header() {
  git -C "$WORK" config --get-urlmatch http.extraheader "https://github.com/${REPO}.git" 2>/dev/null || true
}

plant_checkout_credential
assert "the checkout credential is live before anything clears it" "AUTHORIZATION: basic STUB" "$(live_header)"

# The pre-fix line, verbatim. It targets --local, the key is not there, so it reports success and
# changes nothing — the failure mode was invisible precisely because it looked like it worked.
git -C "$WORK" config --local --unset-all 'http.https://github.com/.extraheader' 2>/dev/null || true
assert "a --local unset does NOT clear it (the original no-op)" "AUTHORIZATION: basic STUB" "$(live_header)"

# The push must survive it anyway. push_as_app resets the header per-command, which outranks every
# config file, so the app token in the URL is the credential that authenticates. A flow that bailed
# here would dead-letter the issue to a human for something it can handle itself.
commit four
assert "push_as_app pushes anyway — the header is reset per-command" ok \
  "$(try push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH")"
assert "…and the remote moved to it" "$(git -C "$WORK" rev-parse HEAD)" "$(remote_sha)"

# use_bot_remote must still remove it outright — the include is what carries the credential, and no
# per-command reset should be load-bearing. (It also re-points origin, which the rest of this harness
# bypasses by pushing to the URL, so give it one.)
git -C "$WORK" remote add origin "file://$TMP/origin.git"
use_bot_remote
assert "use_bot_remote clears the includeIf'd credential" "" "$(live_header)"

# ── 7. What the reset CANNOT cover — the guard is not decoration ─────────────
# git resolves http.* by URL specificity, so a header scoped to the repo path outranks the reset,
# which is scoped to the host. Nothing in the pipeline writes one today; the point is that if
# anything ever does, the push must not go out under it. Refusing names the cause on the spot,
# instead of surfacing twenty minutes later as "CI is held at action_required" — a symptom that
# reads as a GitHub problem and sent every occurrence to Exceptions.
printf '[http "https://github.com/%s.git"]\n\textraheader = AUTHORIZATION: basic DEEPER\n' "$REPO" \
  > "$TMP/git-credentials-deep.config"
git -C "$WORK" config --local "includeIf.gitdir:${gitdir}.path" "$TMP/git-credentials-deep.config"
before="$(remote_sha)"
commit five
assert "push_as_app refuses when a credential outranks the reset" rejected \
  "$(try push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH")"
assert "…and nothing was pushed under it" "$before" "$(remote_sha)"

# ── 8. An include that is not checkout's is none of our business ────────────
# The value filter decides, not the key: dropping every includeIf would take a sidekick's own git
# config with it. (Compared by basename — git normalises the path, and Git Bash and git disagree
# about how to spell a Windows temp dir.)
printf '[core]\n\tquotepath = false\n' > "$TMP/unrelated.config"
git -C "$WORK" config --local "includeIf.gitdir:${gitdir}.path" "$TMP/unrelated.config"
drop_checkout_credentials
assert "an unrelated includeIf is left alone" "unrelated.config" \
  "$(basename "$(git -C "$WORK" config --local --get "includeIf.gitdir:${gitdir}.path" || true)")"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

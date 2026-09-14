#!/usr/bin/env bash
# Unit tests for the DoR build agent's credential isolation and output guards
# (.github/scripts/dor_agent_sandbox.sh, as wired into dor_build_lib.sh) — SEC-2026-09 H-05.
#
# The build agent is an LLM with a shell, working in the same checkout as a flow that holds a
# push-capable GitHub App token. Each block below pins one route by which that token used to be in
# reach, or by which the agent's output could leave the box unreviewed:
#   1. the agent CLI inherited GH_TOKEN / BOARD_TOKEN from the flow's environment;
#   2. the flow's tokens came from the step env, i.e. the flow's own /proc environ;
#   3. use_bot_remote wrote the app token into .git/config;
#   4. git config / hooks planted by the agent acted on the flow's later git commands;
#   5. a branch that changes .github/ was pushed, including via a commit the agent made itself;
#   6. container / dependency changes reached the PR without a word to the reviewer.
# Real git against local repositories; `claude` and `gh` are stubs. No network, no real tokens.
#
# Usage: bash test/ci-scripts/test-dor-agent-sandbox.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/.github/scripts/dor_build_lib.sh"

PASS=0; FAIL=0
assert() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc"; echo "        expected: $expected"; echo "        actual:   $actual"; FAIL=$((FAIL + 1))
  fi
}
yesno() { if "$@"; then echo yes; else echo no; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── Fixture: a bare origin with main, and a working clone on a build branch ──
git init --quiet --bare "$TMP/origin.git"
WORK="$TMP/work"
git init --quiet "$WORK"
git -C "$WORK" config user.email t@example.com
git -C "$WORK" config user.name Test
git -C "$WORK" config core.autocrlf false
put() { mkdir -p "$(dirname "$WORK/$1")"; printf '%s\n' "$2" > "$WORK/$1"; git -C "$WORK" add "$1"; git -C "$WORK" commit --quiet -m "$1"; }
put README.md base
printf '{"name":"x","description":"a","dependencies":{"a":"1.0.0"},"scripts":{"test":"vitest"}}\n' > "$WORK/package.json"
git -C "$WORK" add package.json && git -C "$WORK" commit --quiet -m pkg
git -C "$WORK" push --quiet "file://$TMP/origin.git" HEAD:refs/heads/main
git -C "$WORK" remote add origin "file://$TMP/origin.git"
git -C "$WORK" fetch --quiet origin
git -C "$WORK" checkout --quiet -b dor/issue-7

# Credentials are staged as files, the way the workflows now hand them over.
mkdir -p "$TMP/cred"
printf 'ghs_flowtoken\n'   > "$TMP/cred/gh"
printf 'ghs_boardtoken\n'  > "$TMP/cred/board"

# A `claude` that records the environment it was given and plants what an injected agent would.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/claude" <<STUB
#!/usr/bin/env bash
env > "$TMP/agent-env.txt"
if [ "\${PLANT:-}" = yes ]; then
  printf '[url "https://evil.invalid/"]\n\tinsteadOf = file://\n' >> "$WORK/.git/config"
  mkdir -p "$WORK/.git/hooks"
  printf '#!/bin/sh\necho HOOK-RAN >> "$TMP/hook.log"\n' > "$WORK/.git/hooks/pre-commit"
  chmod +x "$WORK/.git/hooks/pre-commit"
fi
echo '{"is_error":false}'
STUB
chmod +x "$TMP/bin/claude"
cat > "$TMP/bin/gh" <<STUB
#!/usr/bin/env bash
echo "\$*" >> "$TMP/gh.log"
STUB
chmod +x "$TMP/bin/gh"

export ISSUE=7 REPO=Fortigi/IdentityAtlas WORK URL=https://example.invalid HOST=sk-test
export DOR_CRED_DIR="$TMP/cred" RUNNER_TEMP="$TMP"
export CLAUDE_CODE_OAUTH_TOKEN=oauth-for-the-cli GITHUB_TOKEN=ghs_other MEMBERS_TOKEN=ghs_members
export ACTIONS_ID_TOKEN_REQUEST_TOKEN=oidc SOME_API_KEY=k NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
unset GH_TOKEN BOARD_TOKEN
# shellcheck source=/dev/null
source "$LIB"
PATH="$TMP/bin:$PATH"
# Push to the local fixture instead of github.com — the one function that builds the push URL.
app_remote_url() { printf '%s' "file://$TMP/origin.git"; }

echo "DoR build agent — credential isolation and output guards"
echo

# ── 1. The staged credentials are taken into the flow, and the files are gone ──
assert "GH_TOKEN is loaded from the staged file"    ghs_flowtoken  "${GH_TOKEN:-}"
assert "BOARD_TOKEN is loaded from the staged file" ghs_boardtoken "${BOARD_TOKEN:-}"
assert "the staged token files are deleted"         no  "$(yesno test -e "$TMP/cred")"
assert "DOR_CRED_DIR is not passed on"              ""  "${DOR_CRED_DIR:-}"
assert "a child of the flow (gh) still sees GH_TOKEN" ghs_flowtoken "$(bash -c 'printf %s "$GH_TOKEN"')"

# ── 2. The agent CLI starts without any of them ─────────────────────────────
run_claude "do the thing" "$TMP/out.json" 5; rc=$?
assert "run_claude reports success from the stub" 0 "$rc"
agent_has() { grep -q "^$1=" "$TMP/agent-env.txt" && echo present || echo absent; }
assert "the agent has no GH_TOKEN"        absent "$(agent_has GH_TOKEN)"
assert "the agent has no BOARD_TOKEN"     absent "$(agent_has BOARD_TOKEN)"
assert "the agent has no GITHUB_TOKEN"    absent "$(agent_has GITHUB_TOKEN)"
assert "the agent has no MEMBERS_TOKEN"   absent "$(agent_has MEMBERS_TOKEN)"
assert "the agent has no OIDC request token" absent "$(agent_has ACTIONS_ID_TOKEN_REQUEST_TOKEN)"
assert "the agent has no *_API_KEY"       absent "$(agent_has SOME_API_KEY)"
assert "…but keeps CLAUDE_CODE_OAUTH_TOKEN, which the CLI itself needs" present "$(agent_has CLAUDE_CODE_OAUTH_TOKEN)"
assert "…and ordinary configuration (WORK, npm registry)" "present present" \
  "$(agent_has WORK) $(agent_has NPM_CONFIG_REGISTRY)"
assert "the flow itself keeps its tokens after the agent returns" ghs_boardtoken "${BOARD_TOKEN:-}"

# ── 3. No token in the checkout's git config ────────────────────────────────
use_bot_remote
assert "use_bot_remote leaves origin anonymous" "https://github.com/Fortigi/IdentityAtlas.git" \
  "$(git -C "$WORK" config --get remote.origin.url)"
assert "the app token is nowhere in .git/config" no "$(yesno grep -q ghs_boardtoken "$WORK/.git/config")"
git -C "$WORK" remote set-url origin "file://$TMP/origin.git"   # back to the local fixture

# ── 4. What the agent plants in git is undone before the flow uses git again ──
PLANT=yes run_claude "do the thing" "$TMP/out.json" 5
assert "a planted url.insteadOf is removed from .git/config" no "$(yesno grep -q 'evil.invalid' "$WORK/.git/config")"
assert "a planted hook is removed" no "$(yesno test -e "$WORK/.git/hooks/pre-commit")"
# Even a hook that survived (planted outside run_claude) must not run under the flow's git.
mkdir -p "$WORK/.git/hooks"
printf '#!/bin/sh\necho HOOK-RAN >> "%s/hook.log"\n' "$TMP" > "$WORK/.git/hooks/pre-commit"
chmod +x "$WORK/.git/hooks/pre-commit"
put src.js "console.log(1)"
assert "the flow's git never runs repository hooks" no "$(yesno test -e "$TMP/hook.log")"
assert "the flow's git ignores global config" /dev/null "${GIT_CONFIG_GLOBAL:-}"
rm -f "$WORK/.git/hooks/pre-commit"

# ── 5. .github/ changes never leave the box ─────────────────────────────────
bailed=""
bail() { bailed="$1"; }   # the real bail exits; record the reason instead
remote_branch() { git -C "$TMP/origin.git" rev-parse --verify --quiet "refs/heads/$BRANCH" || true; }

assert "a branch without .github changes has nothing protected" "" "$(protected_path_changes)"
guard_protected_paths
assert "…and the guard lets it through" "" "$bailed"
assert "…and push_as_app pushes it" ok "$(push_as_app "HEAD:refs/heads/$BRANCH" >/dev/null 2>&1 && echo ok || echo refused)"

put .github/workflows/evil.yml "on: push"
assert "a committed workflow change is reported" ".github/workflows/evil.yml" "$(protected_path_changes)"
guard_protected_paths
assert "the flow guard routes it to bail, naming the path" yes \
  "$(printf '%s' "$bailed" | grep -q '.github/workflows/evil.yml' && echo yes || echo no)"
before="$(remote_branch)"
assert "push_as_app refuses it on its own too" refused \
  "$(push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH" >/dev/null 2>&1 && echo ok || echo refused)"
assert "…and the remote branch did not move" "$before" "$(remote_branch)"

# Moving the remote-tracking ref onto the change would hide it from a naive three-dot diff.
git -C "$WORK" update-ref refs/remotes/origin/main HEAD
assert "a moved origin/main cannot hide the change (main is re-fetched)" ".github/workflows/evil.yml" \
  "$(protected_path_changes)"

# No base to compare with means no push, not an empty diff.
git -C "$WORK" remote set-url origin "file://$TMP/does-not-exist.git"
git -C "$WORK" update-ref -d refs/remotes/origin/main
assert "without origin/main the guard fails closed" yes \
  "$([ -n "$(protected_path_changes)" ] && echo yes || echo no)"
git -C "$WORK" remote set-url origin "file://$TMP/origin.git"
git -C "$WORK" fetch --quiet origin

# A pause must not save a protected change for a later resume: it becomes an Exception.
rm -f "$TMP/dor-paused"
bail() { echo "$1" > "$TMP/bail.txt"; exit 1; }
( pause_and_exit "usage limit" ) >/dev/null 2>&1
assert "pausing with a protected change bails instead" yes "$(yesno test -s "$TMP/bail.txt")"
assert "…and leaves no pause marker for the reconcile step" no "$(yesno test -e "$TMP/dor-paused")"
bail() { bailed="$1"; }

git -C "$WORK" reset --quiet --hard HEAD~1   # drop the workflow commit

# ── 6. Supply-chain surface is flagged, not blocked ─────────────────────────
assert "a source-only branch raises no flags" "" "$(supply_chain_flags)"

printf '{"name":"x","description":"CHANGED","dependencies":{"a":"1.0.0"},"scripts":{"test":"vitest --run"}}\n' > "$WORK/package.json"
git -C "$WORK" commit --quiet -am "description"
assert "a package.json edit outside dependency/install blocks is not flagged" "" "$(supply_chain_flags)"

printf '{"name":"x","description":"CHANGED","dependencies":{"a":"1.0.0"},"scripts":{"test":"vitest --run","postinstall":"node x.js"}}\n' > "$WORK/package.json"
git -C "$WORK" commit --quiet -am "postinstall"
assert "a new install script is flagged" yes \
  "$(supply_chain_flags | grep -q '`package.json` — dependencies' && echo yes || echo no)"

git -C "$WORK" reset --quiet --hard HEAD~1
printf '{"name":"x","description":"CHANGED","dependencies":{"a":"2.0.0"},"scripts":{"test":"vitest --run"}}\n' > "$WORK/package.json"
git -C "$WORK" commit --quiet -am "bump"
put app/api/Dockerfile "FROM node:24"
put docker-compose.prod.yml "services: {}"
flags="$(supply_chain_flags)"
assert "a dependency bump is flagged" yes "$(printf '%s' "$flags" | grep -q '`package.json`' && echo yes || echo no)"
assert "a Dockerfile is flagged" yes "$(printf '%s' "$flags" | grep -q '`app/api/Dockerfile` — container' && echo yes || echo no)"
assert "a compose file is flagged" yes "$(printf '%s' "$flags" | grep -q '`docker-compose.prod.yml` — compose' && echo yes || echo no)"
assert "flags never block the push" ok "$(push_as_app --force-with-lease "HEAD:refs/heads/$BRANCH" >/dev/null 2>&1 && echo ok || echo refused)"

: > "$TMP/gh.log"
section="$(supply_chain_section)"
note_supply_chain_changes 42 "$section"
assert "an unchanged flag list is not posted again" 0 "$(grep -c 'pr comment' "$TMP/gh.log")"
note_supply_chain_changes 42 ""
assert "a new flag list is posted on the PR" 1 "$(grep -c 'pr comment 42' "$TMP/gh.log")"

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

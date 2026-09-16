#!/usr/bin/env bash
# What keeps the DoR build agent's shell away from the flow's GitHub credentials, and what the flow
# checks before anything the agent produced leaves the sidekick (SEC-2026-09 H-05).
#
# Sourced by dor_build_lib.sh; do NOT execute it. The agent (`claude -p` with Bash) runs as the same
# unix user as the flow, so none of this is a sandbox in the kernel sense — a determined process can
# still reach anything that user can. What it removes is every PASSIVE route to a usable token:
#   - the agent's environment carries no GitHub credential (agent_exec);
#   - the flow's own process was never started with one either, so /proc/<parent>/environ is clean
#     (load_flow_credentials reads them from files the workflow staged, then deletes the files);
#   - no token is written into the checkout's git config (the origin URL stays anonymous);
#   - git config, hooks and global/system config the agent could have planted are not honoured by the
#     flow's own git commands, which run with those tokens exported (restore_git_state + the env below).
# The real boundary — a disposable container or a separate user, without the docker group, with an
# egress allow-list — has to be built on the sidekick itself; see docs/process/dor-sidekick-setup.md.

# ── Git: ignore what a process with this user's rights could plant ────────────────────────────────
# Global and system config are not read by the flow's git at all (the identity it needs is set in the
# checkout's local config by dor_build_lib.sh), and hooks + fsmonitor are switched off by environment,
# which outranks every config file. Exported, so every git the flow runs inherits it.
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null
export GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false

# ── Credentials arrive as files, not as the step's environment ────────────────────────────────────
# A step's `env:` becomes the flow process's initial environment, which any same-user process can
# read back from /proc/<pid>/environ for as long as the flow lives — including the agent it starts.
# Exporting a variable AFTER exec does not appear there. So the workflow stages GH_TOKEN/BOARD_TOKEN
# in DOR_CRED_DIR in an earlier step, and the flow takes them into its memory and deletes the files
# before any agent runs. Without DOR_CRED_DIR (a direct invocation, the tests) env tokens are used.
# `board-minted-at` is not a secret: it is when BOARD_TOKEN was minted (epoch seconds), which is how
# the flow knows to checkpoint before the token's 1h life runs out (dor_token_checkpoint.sh).
load_flow_credentials() {
  local dir="${DOR_CRED_DIR:-}" pair name file value
  [ -n "$dir" ] || return 0
  for pair in GH_TOKEN:gh BOARD_TOKEN:board BOARD_TOKEN_MINTED_AT:board-minted-at; do
    name="${pair%%:*}"; file="$dir/${pair#*:}"
    [ -f "$file" ] || continue
    value=""
    IFS= read -r value < "$file" || true
    rm -f "$file"
    [ -n "$value" ] && export "$name=$value"
  done
  rmdir "$dir" 2>/dev/null || true
  unset DOR_CRED_DIR
  return 0
}

# Names of every exported variable that could authenticate to GitHub (or anything else) and that the
# agent has no business holding. CLAUDE_CODE_OAUTH_TOKEN is the one exception: the CLI itself needs it.
agent_credential_vars() {
  local name
  while IFS= read -r name; do
    case "$name" in
      CLAUDE_CODE_OAUTH_TOKEN) continue ;;
      GH_*|GITHUB_TOKEN|BOARD_TOKEN|MEMBERS_TOKEN|ACTIONS_*|*_TOKEN|*_SECRET|*_PASSWORD|*_PRIVATE_KEY|*_API_KEY|*_PAT)
        printf '%s\n' "$name" ;;
    esac
  done < <(compgen -e)
}

# Run a command (the agent CLI) with those variables removed from its environment. $@ = command.
agent_exec() {
  local -a unset_args=()
  local name
  while IFS= read -r name; do
    [ -n "$name" ] && unset_args+=(-u "$name")
  done < <(agent_credential_vars)
  env "${unset_args[@]}" "$@"
}

# The checkout's local git config and hooks as the flow left them, held in THIS process's memory — a
# snapshot file would be one more thing a same-user process could rewrite. Taken before every agent
# run and put back straight after, so a planted `url.*.insteadOf`, credential helper, filter driver
# or include never gets to act on a git command that has a token in reach.
GIT_STATE_SNAPSHOT=""
snapshot_git_state() {
  GIT_STATE_SNAPSHOT="$(cat "$WORK/.git/config" 2>/dev/null)"
}
restore_git_state() {
  [ -n "$GIT_STATE_SNAPSHOT" ] || return 0
  printf '%s\n' "$GIT_STATE_SNAPSHOT" > "$WORK/.git/config"
  rm -rf "$WORK/.git/hooks" && mkdir -p "$WORK/.git/hooks"
  return 0
}

# ── Output guard: what the agent's branch may not change ──────────────────────────────────────────
# Print every path under .github/ the branch changes relative to main. Workflows and the pipeline's
# own scripts run with secrets, so an agent-authored change there is refused outright, whether it
# arrived as a working-tree edit or as a commit the agent made itself (the flow's restore-from-HEAD
# cannot undo the latter). main is re-fetched first so a moved remote-tracking ref cannot shrink the
# diff; if that fetch fails the existing ref is used, and if there is no ref at all the guard answers
# with a sentinel line so a caller fails closed instead of pushing on an empty diff.
protected_path_changes() {
  git -C "$WORK" fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main" >/dev/null 2>&1 || true
  if ! git -C "$WORK" rev-parse --verify -q origin/main >/dev/null; then
    echo "(no origin/main to compare against)"
    return 0
  fi
  git -C "$WORK" diff --name-only "origin/main...HEAD" 2>/dev/null | grep -E '^\.github/' || true
}

# ── Supply-chain surface: flagged for the reviewer, never blocking ────────────────────────────────
# The dependency- and install-relevant parts of a package.json, normalised, so a version bump or a
# new postinstall is noticed and an edit to "description" is not.
PACKAGE_SUPPLY_CHAIN_JQ='[.dependencies, .devDependencies, .optionalDependencies, .peerDependencies,
  .bundleDependencies, .bundledDependencies, .overrides, .resolutions,
  ((.scripts // {}) | with_entries(select(.key | test("^(pre|post)?install$|^prepare$|^prepublish$"))))]'

package_supply_chain_changed() {  # $1 = path; compares HEAD against the merge-base with main
  local base before after
  base="$(git -C "$WORK" merge-base origin/main HEAD 2>/dev/null)" || return 1
  before="$(git -C "$WORK" show "$base:$1" 2>/dev/null | jq -cS "$PACKAGE_SUPPLY_CHAIN_JQ" 2>/dev/null)"
  after="$(git -C "$WORK" show "HEAD:$1" 2>/dev/null | jq -cS "$PACKAGE_SUPPLY_CHAIN_JQ" 2>/dev/null)"
  [ "$before" != "$after" ]
}

# Markdown bullets naming container, compose and dependency changes on the branch. Empty when none.
supply_chain_flags() {
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "${f##*/}" in
      Dockerfile|Dockerfile.*|*.Dockerfile|*.dockerfile)
        printf -- '- `%s` — container build definition\n' "$f" ;;
      docker-compose*.yml|docker-compose*.yaml|compose.yml|compose.yaml|compose.*.yml|compose.*.yaml)
        printf -- '- `%s` — compose file\n' "$f" ;;
      package.json)
        package_supply_chain_changed "$f" && printf -- '- `%s` — dependencies, overrides or install scripts\n' "$f" ;;
    esac
  done < <(git -C "$WORK" diff --name-only "origin/main...HEAD" 2>/dev/null)
  return 0
}

# The flags as a PR-body / comment section, or nothing.
supply_chain_section() {
  local flags; flags="$(supply_chain_flags)"
  [ -n "$flags" ] || return 0
  printf '\n\n### Review with extra care: supply-chain surface\nThis automated change touches files that decide what gets installed or run in the images:\n%s\n' "$flags"
}

#!/usr/bin/env bash
# Provision a DoR build-pool sidekick to the baseline the build agent needs.
#
# Idempotent: safe to re-run — every step checks first and only does work if something is missing.
# Installs the software baseline, sets the git identity, installs the `claude` CLI, pre-caches the
# Playwright browser, stands up the `edge` placeholder stack, then verifies. It does NOT register the
# GitHub Actions runner (that needs a short-lived registration token) or wire the repo-side config —
# those two human steps are in docs/process/dor-sidekick-setup.md, which this script implements.
#
#   Usage:  bash provision-sidekick.sh            # provision + verify
#           bash provision-sidekick.sh --verify   # verify only, change nothing
#
# Run as the runner's user (the one that owns ~/actions-runner and can talk to Docker). Needs sudo
# for apt / NodeSource / the gh apt repo.
set -uo pipefail

GIT_NAME="IdentityAtlas DoR agent"
GIT_EMAIL="dor-agent@fortigi.nl"
NODE_MAJOR=22
REPO_RAW="https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main"
FAIL=0

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── verify-only mode ───────────────────────────────────────────────────────────────────────────────
verify() {
  say "Verifying sidekick baseline on $(hostname)"
  have git    && ok "git $(git --version | grep -oE '[0-9.]+' | head -1)"                || bad "git missing"
  local id="$(git config --global user.name 2>/dev/null) <$(git config --global user.email 2>/dev/null)>"
  [ "$id" = "$GIT_NAME <$GIT_EMAIL>" ] && ok "git identity $id" || bad "git identity not set (got: $id)"
  have docker && ok "docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"    || bad "docker missing"
  docker compose version >/dev/null 2>&1 && ok "docker compose $(docker compose version --short 2>/dev/null)" || bad "docker compose plugin missing"
  have gh     && ok "gh $(gh --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"            || bad "gh missing"
  have node   && ok "node $(node --version)"                                             || bad "node missing"
  have npm    && ok "npm $(npm --version)"                                               || bad "npm missing"
  [ -x "$HOME/.local/bin/claude" ] && ok "claude $("$HOME/.local/bin/claude" --version 2>/dev/null)" || bad "claude CLI missing (~/.local/bin/claude)"
  local miss=""
  for p in unzip jq build-essential python3 pkg-config curl ca-certificates; do
    dpkg -l "$p" >/dev/null 2>&1 || miss="$miss $p"
  done
  [ -z "$miss" ] && ok "apt packages present" || bad "apt packages missing:$miss"
  [ -d "$HOME/stacks/edge" ] && ok "edge placeholder stack present" || warn "edge stack missing (N.build serves nothing between builds)"
  ls "$HOME/.cache/ms-playwright"/chromium-* >/dev/null 2>&1 && ok "playwright chromium pre-cached" || warn "playwright chromium not cached (first e2e will be slow)"
  systemctl list-units --type=service 2>/dev/null | grep -q 'actions.runner' && ok "actions runner service registered" \
    || warn "actions runner service NOT registered — see docs/process/dor-sidekick-setup.md (needs a registration token)"
  [ "$FAIL" = 0 ] && say "Baseline OK." || say "Baseline INCOMPLETE — re-run without --verify to install."
  return "$FAIL"
}

if [ "${1:-}" = "--verify" ]; then verify; exit $?; fi

# ── provision ───────────────────────────────────────────────────────────────────────────────────────
say "1/7  apt baseline"
sudo apt-get update -qq
sudo apt-get install -y -qq curl ca-certificates gnupg unzip jq build-essential python3 pkg-config git >/dev/null
ok "curl ca-certificates gnupg unzip jq build-essential python3 pkg-config git"

say "2/7  Docker + compose plugin"
if have docker && docker compose version >/dev/null 2>&1; then
  ok "already present ($(docker --version | grep -oE '[0-9.]+' | head -1))"
else
  curl -fsSL https://get.docker.com | sudo sh >/dev/null
  sudo usermod -aG docker "$USER" || true
  ok "installed (log out/in for the docker group to take effect)"
fi

say "3/7  Node $NODE_MAJOR"
if have node && [ "$(node --version | grep -oE '[0-9]+' | head -1)" -ge "$NODE_MAJOR" ] 2>/dev/null; then
  ok "already $(node --version)"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y -qq nodejs >/dev/null
  ok "installed $(node --version)"
fi

say "4/7  GitHub CLI (gh)"
if have gh; then
  ok "already $(gh --version | grep -oE '[0-9.]+' | head -1)"
else
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null 2>&1
  sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq gh >/dev/null
  ok "installed $(gh --version | grep -oE '[0-9.]+' | head -1)"
fi

say "5/7  claude CLI + git identity"
if [ -x "$HOME/.local/bin/claude" ]; then
  ok "claude already $("$HOME/.local/bin/claude" --version 2>/dev/null)"
else
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1
  ok "claude installed $("$HOME/.local/bin/claude" --version 2>/dev/null)"
fi
grep -q 'HOME/.local/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
git config --global user.name  "$GIT_NAME"
git config --global user.email "$GIT_EMAIL"
ok "git identity: $GIT_NAME <$GIT_EMAIL>"

say "6/7  Playwright chromium (pre-cache so the first e2e isn't slow)"
if ls "$HOME/.cache/ms-playwright"/chromium-* >/dev/null 2>&1; then
  ok "already cached"
else
  npx --yes playwright@latest install --with-deps chromium >/dev/null 2>&1 && ok "cached" || warn "pre-cache failed (non-fatal; the e2e step installs it on demand)"
fi

say "7/7  edge placeholder stack (serves N.build between builds)"
if [ -d "$HOME/stacks/edge" ]; then
  ok "already present"
else
  mkdir -p "$HOME/stacks/edge"
  if curl -fsSL "$REPO_RAW/docker-compose.prod.yml" -o "$HOME/stacks/edge/docker-compose.prod.yml"; then
    ( cd "$HOME/stacks/edge" && docker compose -f docker-compose.prod.yml up -d >/dev/null 2>&1 ) && ok "up" || warn "compose up failed (bring it up manually)"
  else
    warn "could not fetch docker-compose.prod.yml — create ~/stacks/edge manually"
  fi
fi

verify

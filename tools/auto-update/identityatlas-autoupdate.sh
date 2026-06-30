#!/usr/bin/env bash
#
# Identity Atlas auto-update agent — Docker host.
#
# The app owns the decision (Admin → Updates switch + the daily check); this
# script is just the "hands" that apply it. Run it nightly from cron or a
# systemd timer. It asks the running app whether an update should be applied on
# its channel; if so, it pulls the new images and recreates the containers.
# The app records the installed version automatically on its next check, so this
# script needs only read access to the intent endpoint.
#
# Configuration (env vars):
#   IA_API_URL       Base URL of the running app   (default: http://localhost:3001)
#   IA_COMPOSE_FILE  Path to the compose file       (default: docker-compose.prod.yml)
#   IA_READ_TOKEN    A read API token (fgr_…)        — required only if AUTH_ENABLED=true
#   IA_SERVICES      Services to update             (default: "web worker"; postgres is pinned)
#
# Example cron (03:30 nightly):
#   30 3 * * *  IA_COMPOSE_FILE=/opt/identityatlas/docker-compose.prod.yml \
#               /opt/identityatlas/tools/auto-update/identityatlas-autoupdate.sh >> /var/log/ia-update.log 2>&1
#
# A systemd timer unit is provided alongside this script (see *.service / *.timer).

set -euo pipefail

API_URL="${IA_API_URL:-http://localhost:3001}"
COMPOSE_FILE="${IA_COMPOSE_FILE:-docker-compose.prod.yml}"
READ_TOKEN="${IA_READ_TOKEN:-}"
SERVICES="${IA_SERVICES:-web worker}"

log() { echo "[ia-autoupdate] $*"; }

auth=()
[ -n "$READ_TOKEN" ] && auth=(-H "Authorization: Bearer $READ_TOKEN")

# Ask the app what it wants. shouldUpdate = (auto-update enabled) AND (a newer
# version is available on this deployment's channel).
intent="$(curl -fsS --max-time 30 "${auth[@]}" "$API_URL/api/updates/intent")" || {
  log "could not reach $API_URL/api/updates/intent — skipping this run"
  exit 1
}

should="$(printf '%s' "$intent" | grep -o '"shouldUpdate":[a-z]*' | head -1 | cut -d: -f2)"
latest="$(printf '%s' "$intent" | grep -o '"latestVersion":"[^"]*"' | head -1 | cut -d'"' -f4)"
channel="$(printf '%s' "$intent" | grep -o '"channel":"[^"]*"' | head -1 | cut -d'"' -f4)"

if [ "$should" != "true" ]; then
  log "nothing to do (channel=${channel:-?}, shouldUpdate=${should:-false})"
  exit 0
fi

log "update available on channel '${channel}': ${latest:-newer} — pulling…"
# shellcheck disable=SC2086  # word-splitting $SERVICES is intentional
docker compose -f "$COMPOSE_FILE" pull $SERVICES
# shellcheck disable=SC2086
docker compose -f "$COMPOSE_FILE" up -d $SERVICES
log "updated ${SERVICES}. Migrations run on web startup (fail-closed). The app will"
log "record the installed version on its next check (Admin → Updates → history)."

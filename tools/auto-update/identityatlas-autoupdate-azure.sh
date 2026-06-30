#!/usr/bin/env bash
#
# Identity Atlas auto-update agent — Azure Container Apps.
#
# Same model as the Docker agent: the app decides (Admin → Updates), this script
# applies. Run it on a schedule that can reach both the app and Azure — e.g. an
# Azure Automation runbook, a scheduled Container Apps Job, or a GitHub Actions
# cron with an Azure login. Requires the `az` CLI, already logged in / using a
# managed identity with rights to update the container apps.
#
# Configuration (env vars):
#   IA_API_URL         Base URL of the running app                     (required)
#   IA_READ_TOKEN      A read API token (fgr_…)        — if AUTH_ENABLED=true
#   IA_RESOURCE_GROUP  Azure resource group                            (required)
#   IA_WEB_APP         Web container app name                          (required)
#   IA_WORKER_APP      Worker container app name                       (optional)
#   IA_IMAGE_REPO      Image repo  (default: ghcr.io/fortigi/identity-atlas)
#   IA_CHANNEL         Channel tag (default: latest) — must match the deployment
#
# Note: re-deploying the same channel tag makes Container Apps pull that tag's
# CURRENT digest into a new revision, which is what rolls the update forward.

set -euo pipefail

API_URL="${IA_API_URL:?set IA_API_URL}"
READ_TOKEN="${IA_READ_TOKEN:-}"
RG="${IA_RESOURCE_GROUP:?set IA_RESOURCE_GROUP}"
WEB_APP="${IA_WEB_APP:?set IA_WEB_APP}"
WORKER_APP="${IA_WORKER_APP:-}"
IMAGE_REPO="${IA_IMAGE_REPO:-ghcr.io/fortigi/identity-atlas}"
CHANNEL="${IA_CHANNEL:-latest}"

log() { echo "[ia-autoupdate-azure] $*"; }

auth=()
[ -n "$READ_TOKEN" ] && auth=(-H "Authorization: Bearer $READ_TOKEN")

intent="$(curl -fsS --max-time 30 "${auth[@]}" "$API_URL/api/updates/intent")" || {
  log "could not reach $API_URL/api/updates/intent — skipping"
  exit 1
}
should="$(printf '%s' "$intent" | grep -o '"shouldUpdate":[a-z]*' | head -1 | cut -d: -f2)"

if [ "$should" != "true" ]; then
  log "nothing to do (shouldUpdate=${should:-false})"
  exit 0
fi

log "rolling $WEB_APP to ${IMAGE_REPO}:${CHANNEL}"
az containerapp update -g "$RG" -n "$WEB_APP" --image "${IMAGE_REPO}:${CHANNEL}" --output none
if [ -n "$WORKER_APP" ]; then
  log "rolling $WORKER_APP to ${IMAGE_REPO}-worker:${CHANNEL}"
  az containerapp update -g "$RG" -n "$WORKER_APP" --image "${IMAGE_REPO}-worker:${CHANNEL}" --output none
fi
log "done — new revision(s) created. The app records the installed version on its next check."

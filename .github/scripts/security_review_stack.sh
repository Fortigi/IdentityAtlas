#!/usr/bin/env bash
# Runs the Identity Atlas stack the monthly security review tests against: the
# CI Compose file (authentication off, images built in this job), with the demo
# dataset loaded. Same readiness signal and demo job as pr-integration.yml.
#
# Usage:
#   security_review_stack.sh up         start the stack and wait until the schema is ready
#   security_review_stack.sh demo       load the demo dataset and wait for it
#   security_review_stack.sh reset      throw the stack and its data away, then up + demo
#   security_review_stack.sh worker-key print the built-in worker key
#   security_review_stack.sh down       stop and remove everything
set -euo pipefail

COMPOSE=(docker compose -f docker-compose.ci.yml)
API="${API:-http://localhost:3001}"

up() {
  "${COMPOSE[@]}" up -d
  for i in $(seq 1 90); do
    if curl -sf "$API/api/health" 2>/dev/null | grep -q '"schemaReady":true'; then
      echo "schema ready after $((i * 2))s"
      return 0
    fi
    sleep 2
  done
  echo "::error::schema did not become ready within 180s"
  "${COMPOSE[@]}" logs web
  return 1
}

demo() {
  local job id status=""
  job="$(curl -sf -X POST "$API/api/admin/crawler-jobs" -H 'Content-Type: application/json' -d '{"jobType":"demo"}')"
  id="$(jq -r '.id // empty' <<<"$job")"
  [ -n "$id" ] || { echo "::error::could not queue the demo job: $job"; return 1; }
  for _ in $(seq 1 60); do
    status="$(curl -sf "$API/api/admin/crawler-jobs/$id" | jq -r '.status // empty')"
    case "$status" in
      completed) echo "demo data loaded"; return 0 ;;
      failed) echo "::error::demo job failed"; return 1 ;;
    esac
    sleep 3
  done
  echo "::error::demo job timed out (status: $status)"
  return 1
}

case "${1:-}" in
  up) up ;;
  demo) demo ;;
  reset) "${COMPOSE[@]}" down -v; up; demo ;;
  worker-key) "${COMPOSE[@]}" exec -T worker cat /data/uploads/.builtin-worker-key | tr -d '\r\n' ;;
  down) "${COMPOSE[@]}" down -v ;;
  *) echo "usage: security_review_stack.sh up|demo|reset|worker-key|down" >&2; exit 2 ;;
esac

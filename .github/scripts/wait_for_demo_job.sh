#!/usr/bin/env bash
# Queue a demo crawler job and wait for it to finish (issue #1642).
#
# pr-integration.yml used to carry three hand-rolled copies of this loop. Only
# one failed the step when the job failed or ran out of time; the other two fell
# off the end of the loop and exited 0, so Playwright ran against a half-loaded
# database and failed in places that pointed nowhere near the cause. Every
# demo-data load now goes through this one script, and
# test/ci-scripts/test-wait-for-demo-job.sh pins its behaviour.
#
# Usage: wait_for_demo_job.sh <api-base-url> [max-polls] [poll-seconds]
#   api-base-url  e.g. http://localhost:3001/api
#   max-polls     default 40
#   poll-seconds  default 3
#
# Exit 0 only when the job reports 'completed'. Exit 1, with an ::error:: naming
# the status and a dump of the job record, when it could not be queued, ended
# 'failed' or 'cancelled', or was still unfinished when the polls ran out.
set -euo pipefail

API="${1:?usage: wait_for_demo_job.sh <api-base-url> [max-polls] [poll-seconds]}"
POLLS="${2:-40}"
INTERVAL="${3:-3}"

# json_field <name>: prints one top-level string field of the JSON on stdin, or
# nothing when the input is not JSON.
json_field() {
  python3 -c "import sys,json
try: print(json.load(sys.stdin).get('$1','') or '')
except Exception: print('')"
}

dump_job() {
  echo "Job record:"
  curl -sf "$API/admin/crawler-jobs/$JOB_ID" || echo "(could not fetch the job record)"
  echo
}

JOB=$(curl -sf -X POST "$API/admin/crawler-jobs" \
  -H "Content-Type: application/json" -d '{"jobType": "demo"}' || true)
JOB_ID=$(printf '%s' "$JOB" | json_field id)
if [ -z "$JOB_ID" ]; then
  echo "::error::Failed to queue demo job"
  echo "$JOB"
  exit 1
fi
echo "Demo job queued: $JOB_ID"

STATUS=""
for i in $(seq 1 "$POLLS"); do
  STATUS=$(curl -sf "$API/admin/crawler-jobs/$JOB_ID" 2>/dev/null | json_field status || true)
  case "$STATUS" in
    completed)
      echo "Demo job completed after $((i * INTERVAL))s"
      exit 0
      ;;
    failed|cancelled)
      echo "::error::Demo job $STATUS after $((i * INTERVAL))s"
      dump_job
      exit 1
      ;;
  esac
  sleep "$INTERVAL"
done

echo "::error::Demo job timed out after $((POLLS * INTERVAL))s (last status: ${STATUS:-unknown})"
dump_job
exit 1

#!/usr/bin/env bash
# Run Playwright E2E tests against the real Docker stack (USE_SQL=true).
#
# Usage:
#   npm run test:e2e:sql                 # run all E2E against real Docker DB
#   npm run test:e2e:sql -- navigation   # filter by spec name
#
# If the stack is already running (e.g. in active dev), it is reused and NOT
# torn down afterward. If the stack is not running, it is started here and
# torn down when the tests finish.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

API_URL="http://localhost:3001/api/admin/status"

# Check if the stack is already running
STARTED_HERE=false
if curl -sf "$API_URL" > /dev/null 2>&1; then
  echo "Docker stack already running — reusing existing instance"
elif command -v docker > /dev/null 2>&1; then
  echo "Starting Docker stack..."
  cd "$REPO_ROOT"
  docker compose up -d --build
  STARTED_HERE=true

  echo "Waiting for API to be ready..."
  for i in $(seq 1 60); do
    if curl -sf "$API_URL" > /dev/null 2>&1; then
      echo "API ready after $((i * 2))s"
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo "ERROR: API did not become ready within 120s"
      docker compose down
      exit 1
    fi
    sleep 2
  done

  echo "Loading demo data..."
  JOB=$(curl -sf -X POST http://localhost:3001/api/admin/crawler-jobs \
    -H "Content-Type: application/json" -d '{"jobType": "demo"}')
  JOB_ID=$(echo "$JOB" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  if [ -n "$JOB_ID" ]; then
    for i in $(seq 1 40); do
      STATUS=$(curl -sf "http://localhost:3001/api/admin/crawler-jobs/$JOB_ID" | \
        python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
      if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
        echo "Demo data loaded (status: $STATUS)"
        break
      fi
      sleep 3
    done
  fi
else
  echo "docker not found — assuming stack is already running externally (e.g. Docker Desktop on Windows)"
  echo "If tests fail to connect, start the Docker stack manually first."
fi

# Run Playwright with the CI config (real-DB mode, port 3001)
cd "$REPO_ROOT/app/ui"
EXIT_CODE=0
npx playwright test --config=playwright.ci.config.js "$@" || EXIT_CODE=$?

# Only tear down if we started the stack
if [ "$STARTED_HERE" = "true" ]; then
  echo "Tearing down Docker stack..."
  cd "$REPO_ROOT"
  docker compose down
fi

exit $EXIT_CODE

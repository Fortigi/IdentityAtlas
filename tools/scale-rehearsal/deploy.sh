#!/usr/bin/env bash
# Point the scale-test stack at a ref and rebuild web (+worker with --worker); DB kept.
#   deploy.sh <git-ref> [--worker]
set -e
cd ~/stacks/scale-test
git fetch -q origin "$1"
git checkout -q FETCH_HEAD
echo "deployed $(git log --oneline -1)"
svc=web; [ "${2:-}" = --worker ] && svc="web worker"
docker compose -p scale-test -f docker-compose.yml -f compose.scale.yml up -d --build --wait $svc > ~/deploy.log 2>&1 || { tail -20 ~/deploy.log; exit 1; }
until curl -sf -o /dev/null http://localhost:3005/api/health; do sleep 2; done
# the API refreshes the matrix views on start (until step 4): let that finish first
sleep 5
while [ "$(docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -Atc "select count(*) from pg_stat_activity where query like 'REFRESH MATERIALIZED%' and state='active'")" != 0 ]; do sleep 2; done
echo ready

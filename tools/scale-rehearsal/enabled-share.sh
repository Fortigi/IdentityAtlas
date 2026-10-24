#!/usr/bin/env bash
# Re-run the enabled-only matrix queries at the customer's real active share.
#   enabled-share.sh <label> [percent]     (default 62)
# The scale dataset marks 25% of principals enabled; the customer has 108,944 of
# 176,789 identities active (~62%, 2026-09-27). The enabled-only matrix scales with
# the rows that pass the filter, so the 25% numbers understate it. This flips
# accountEnabled deterministically from the row id (no history: synthetic rewrite),
# refreshes the matrix views, and re-runs only the queries that filter on it.
set -uo pipefail
label=$1; pct=${2:-62}; P=${P:-scale-test}; API=${API:-http://localhost:3005/api}
psql() { docker exec ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'\t' -c "$1"; }
psql "SET session_replication_role = replica;
UPDATE \"Principals\" SET \"accountEnabled\" =
  ((('x' || substr(md5(id::text || 'en'), 1, 8))::bit(32)::int & 2147483647) % 100) < $pct;"
psql 'VACUUM ANALYZE "Principals"'
psql "select 'enabled share', round(100.0 * avg(\"accountEnabled\"::int), 1) from \"Principals\""
KEY=$(docker exec ${P}-web-1 cat /data/uploads/.builtin-worker-key)
curl -sS -o /dev/null -X POST "$API/ingest/refresh-views" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{}'
sleep 5
until [ "$(psql "select count(*) from pg_stat_activity where query like 'REFRESH MATERIALIZED%' and state='active'")" = 0 ]; do sleep 10; done
ONLY='^matrix-(enabled|largest)' bash ~/harness/bench.sh "$label"

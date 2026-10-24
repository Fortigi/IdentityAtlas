#!/usr/bin/env bash
# Every 0.5 s, record each REFRESH MATERIALIZED VIEW statement (pid + start) and
# when it was last seen, so a run can be counted and timed afterwards.
#   refresh-counter.sh <out.tsv>        (kill it when done; then summarise with
#   awk -F'\t' '{k=$1" "$2" "$3; s[k]=$2; e[k]=$4} END{for(k in s) print k, e[k]-s[k]}' out.tsv)
out=$1; P=${P:-scale-test}
while true; do
  docker exec ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'\t' -c \
    "select pid, extract(epoch from query_start)::bigint, substring(query from 'REFRESH MATERIALIZED VIEW[^\"]*\"([^\"]+)\"'), extract(epoch from now())::bigint
       from pg_stat_activity where datname=current_database() and state='active' and backend_type='client backend'
        and query like 'REFRESH MATERIALIZED VIEW%'" >> "$out" 2>/dev/null
  sleep 0.5
done

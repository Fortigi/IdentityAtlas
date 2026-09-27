#!/usr/bin/env bash
# Every 5 s: what the database is doing (non-idle backends of the app database).
out=$1; P=${P:-scale-test}
while true; do
  docker exec ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'\t' -c "select extract(epoch from now())::int, coalesce(wait_event_type,'CPU'), coalesce(wait_event,'-'), state, round(extract(epoch from now()-query_start)::numeric,1), regexp_replace(left(query,90),'\s+',' ','g') from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state<>'idle'" >> "$out" 2>/dev/null
  sleep 5
done

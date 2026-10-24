#!/usr/bin/env bash
# Cancel the app database's active queries if the shared disk gets critically low.
log=$1; P=${P:-scale-test}
SQL="select pid, left(query,80), pg_cancel_backend(pid) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='active'"
while sleep 5; do
  free=$(df -B1M --output=avail / | tail -1 | tr -d ' ')
  if [ "$free" -lt ${MIN_MB:-2500} ]; then
    echo "$(date +%s) pg-guard free=${free}M cancelling:" >> "$log"
    docker exec ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -Atc "$SQL" >> "$log" 2>&1
    sleep 20
  fi
done

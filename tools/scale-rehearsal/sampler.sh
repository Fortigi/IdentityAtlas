#!/usr/bin/env bash
# Samples resource use of the scale-test stack every $2 seconds into $1 (TSV).
# Columns: epoch, pwsh_rss_max_mb, pwsh_rss_sum_mb, worker_mem, web_mem, pg_mem, db_bytes, disk_used_bytes
out=$1; every=${2:-5}; P=${P:-scale-test}
echo -e "epoch\tpwsh_rss_max_mb\tpwsh_rss_sum_mb\tworker_mem\tweb_mem\tpg_mem\tdb_bytes\tdisk_used_bytes" > "$out"
while true; do
  now=$(date +%s)
  rss=$(docker exec ${P}-worker-1 sh -c 'for p in /proc/[0-9]*; do c=$(cat $p/comm 2>/dev/null); case "$c" in pwsh*) awk "/VmRSS/{print \$2}" $p/status;; esac; done' 2>/dev/null | awk '{s+=$1; if($1>m)m=$1} END{printf "%d\t%d", m/1024, s/1024}')
  mem=$(docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' ${P}-worker-1 ${P}-web-1 ${P}-postgres-1 2>/dev/null | awk '{print $2}' | paste -sd'\t')
  db=$(docker exec ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -tAc "select pg_database_size('identity_atlas')" 2>/dev/null)
  disk=$(df -B1 / | awk 'NR==2{print $3}')
  echo -e "${now}\t${rss:-0	0}\t${mem}\t${db:-0}\t${disk}" >> "$out"
  sleep "$every"
done

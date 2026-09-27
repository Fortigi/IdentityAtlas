#!/usr/bin/env bash
# Attribute a regression the way the report requires: the SAME queries, on the
# SAME database, with each code version deployed in turn (web only).
#   attribute.sh <label> <queries-regex> <ref> [<ref> ...]
# Each ref runs the queries twice (first cold after the deploy's restart, then warm).
set -uo pipefail
label=$1; only=$2; shift 2
out=~/scale-runs/$label; mkdir -p $out
q() { docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -Atc "$1"; }
idle() { until [ "$(q "select count(*) from pg_stat_activity where datname=current_database() and state='active' and pid<>pg_backend_pid()")" = 0 ]; do sleep 5; done; }
for ref in "$@"; do
  tag=$(echo "$ref" | tr '/' '_')
  bash ~/harness/deploy.sh "$ref" > $out/deploy-$tag.log 2>&1 || { echo "$ref deploy failed" | tee -a $out/summary.txt; continue; }
  commit=$(cd ~/stacks/scale-test && git log --oneline -1)
  idle
  for run in 1 2; do
    ONLY="$only" bash ~/harness/bench.sh "$label/$tag-run$run" > /dev/null 2>&1
    grep -vE "^name|^#" ~/scale-runs/$label/$tag-run$run/bench.tsv | awk -v c="$commit" -v r=$run -F'\t' '{printf "%-45s run%s  %s  http %s  %8.1f s  %s\n", c, r, $1, $4, $5, $7}' | tee -a $out/summary.txt
    idle
  done
done
echo done | tee -a $out/summary.txt

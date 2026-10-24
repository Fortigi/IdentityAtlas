#!/usr/bin/env bash
# One instrumented CSV crawler load against the scale-test stack.
#   run-load.sh <dataset-dir> <label>
# Writes ~/scale-runs/<label>/{samples.tsv,job.json,job.log,tables.tsv,timeline.txt}
set -euo pipefail
data=$1; label=$2; P=${P:-scale-test}; API=${API:-http://localhost:3005/api}
out=~/scale-runs/$label; mkdir -p "$out"
j() { curl -sS -H 'Content-Type: application/json' "$@"; }

if [ -n "${CONFIG_ID:-}" ]; then
  cid=$CONFIG_ID   # re-run an existing crawler config, as a user would (same systems)
else
  cfg=$(j -X POST "$API/admin/crawler-configs" -d "{\"crawlerType\":\"csv\",\"displayName\":\"Scale $label\",\"config\":{\"systemName\":\"CSV Import\",\"systemType\":\"CSV\",\"delimiter\":\"\\t\"}}")
  cid=$(echo "$cfg" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
fi
echo "config $cid"
dest=/data/uploads/csv-$cid
docker exec ${P}-web-1 mkdir -p "$dest"
t0=$(date +%s)
[ -n "${CONFIG_ID:-}" ] || for f in Systems Contexts Resources ContextMembers Users Assignments; do docker cp "$data/$f.csv" ${P}-web-1:"$dest/$f.csv" >/dev/null; done
echo "copied in $(( $(date +%s) - t0 )) s"

bash ~/harness/sampler.sh "$out/samples.tsv" 5 & SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null || true' EXIT

job=$(j -X POST "$API/admin/crawler-jobs" -d "{\"jobType\":\"csv\",\"configId\":$cid,\"syncMode\":\"full\"}")
jid=$(echo "$job" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
echo "job $jid started $(date -Is)"; echo "$(date +%s) job-start" > "$out/timeline.txt"
# Disk guard: this host is shared (the DoR edge placeholder lives on the same disk).
# Below GUARD_GB free, stop the load where it is and record how far it got.
( while sleep 10; do
    free=$(df -B1G --output=avail / | tail -1 | tr -d ' ')
    if [ "$free" -lt "${GUARD_GB:-4}" ]; then
      echo "$(date +%s) disk-guard free=${free}G $(grep 'rows streamed' "$out/job-timed.log" | tail -1 | cut -f2)" >> "$out/timeline.txt"
      j -X POST "$API/admin/crawler-jobs/$jid/force-stop" > /dev/null
      docker stop ${P}-worker-1 > /dev/null
      break
    fi
  done ) & GUARD=$!
trap 'kill $SAMPLER $GUARD 2>/dev/null || true' EXIT
python3 ~/harness/logtail.py "$API" "$jid" "$out/job-timed.log"
st=$(j "$API/admin/crawler-jobs/$jid" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("status"))')
echo "$(date +%s) job-end ${st%%|*}" >> "$out/timeline.txt"
j "$API/admin/crawler-jobs/$jid" > "$out/job.json"
j "$API/admin/crawler-jobs/$jid/log" > "$out/job.log" || true
docker exec ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'\t' -c \
  "select relname, n_live_tup, pg_total_relation_size(relid), pg_relation_size(relid), pg_indexes_size(relid) from pg_stat_user_tables order by 3 desc limit 25" > "$out/tables.tsv"
echo "job $jid ${st%%|*} at $(date -Is)"

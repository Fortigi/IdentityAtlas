#!/usr/bin/env bash
# Step 4 measurement on the current deployment: one full CSV sync with every
# REFRESH counted, the refresh-views request latency, and the startup refresh.
#   step4.sh <label>
label=$1; out=~/scale-runs/$label; mkdir -p "$out"; API=http://localhost:3005/api
bash ~/harness/refresh-counter.sh "$out/refreshes.tsv" & CNT=$!
bash ~/harness/run-load.sh ~/scale-data/p10 "$label" > "$out/load.out" 2>&1
sleep 20   # anything still refreshing after the job ended
kill $CNT
echo "== refreshes during the job (view, seconds)"
awk -F'\t' 'NF>=4 {k=$1" "$2" "$3; s[k]=$2; e[k]=$4; v[k]=$3} END{n=0; for(k in s){n++; print v[k], e[k]-s[k]}; print "count", n}' "$out/refreshes.tsv" | sort
echo "== job result / refresh lines in the job log"
grep -iE "refresh|classif|Views|non-critical|Transient" "$out/job-timed.log" | cut -f2 | grep -v "reconcile" | head -12
python3 -c "import json;d=json.load(open('$out/job.json'));print('job status', d.get('status'), '|', (d.get('result') or d.get('errorMessage') or ''))"
KEY=$(docker exec scale-test-web-1 cat /data/uploads/.builtin-worker-key)
echo "== POST refresh-views latency"
curl -sS -o /dev/null -w "POST refresh-views %{http_code} %{time_total}s\n" -X POST "$API/ingest/refresh-views" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{}'
sleep 1; while [ "$(docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -Atc "select count(*) from pg_stat_activity where query like 'REFRESH MATERIALIZED%' and state='active'")" != 0 ]; do sleep 1; done
echo "== startup"
sed -n '/^# Startup/,$p' ~/harness/extra.sh > /tmp/startup.sh
P=scale-test API=$API out=$out res=$out/startup.tsv bash -c 'psql() { docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'"'"'\t'"'"' -c "$1"; }; P=scale-test; '"$(cat /tmp/startup.sh)"

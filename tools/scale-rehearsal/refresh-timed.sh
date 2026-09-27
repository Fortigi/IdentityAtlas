#!/usr/bin/env bash
# Standalone, timed POST /ingest/refresh-views with the Postgres disk guard at $MIN_MB.
out=~/scale-runs/p100-nohist
MIN_MB=${MIN_MB:-1500} nohup bash ~/harness/pgguard.sh $out/timeline.txt >/dev/null 2>&1 &
GUARD=$!
nohup bash ~/harness/sampler.sh $out/refresh-samples.tsv 5 >/dev/null 2>&1 &
SAMP=$!
docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -c CHECKPOINT >/dev/null
echo "free before: $(df -h --output=avail / | tail -1)"
KEY=$(docker exec scale-test-web-1 cat /data/uploads/.builtin-worker-key)
echo "$(date +%s) refresh-views-start" >> $out/timeline.txt
curl -sS -w "\nrefresh-views\t%{http_code}\t%{time_total}\n" --max-time 3600 -X POST http://localhost:3005/api/ingest/refresh-views \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{}'
echo "$(date +%s) refresh-views-end" >> $out/timeline.txt
kill $SAMP
echo "free after: $(df -h --output=avail / | tail -1)"; grep pg-guard $out/timeline.txt | tail -1
echo "guard still running as $GUARD"

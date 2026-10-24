#!/usr/bin/env bash
# Step 7: the authoritative 100% re-run on MAIN, after the scale fix set merged.
#   step7.sh [ref]            (default: main)
# Measures, in order, on one fresh database:
#   1. the full 41M CSV crawler load (per phase: job-timed.log, samples.tsv, timeline.txt)
#   2. post-sync work: every matrix REFRESH during and after the job (refreshes.tsv)
#   3. a restart with populated views (startup.tsv)
#   4. the query set, including filter-value discovery cold and warm (bench.tsv)
#   5. filter-value discovery again at the customer's attribute shape (filter-shape)
# The repeat import is a separate step (step7-repeat.sh): it depends on fixes that
# may land later, and it rewrites nothing the measurements above need.
set -uo pipefail
ref=${1:-main}; label=step7; out=~/scale-runs/$label; mkdir -p $out
q() { docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -Atc "$1"; }
idle() { until [ "$(q "select count(*) from pg_stat_activity where query like 'REFRESH MATERIALIZED%' and state='active'")" = 0 ]; do sleep 10; done; }
stamp() { echo "$(date +%s) $1" >> $out/timeline.txt; echo "$(date -Is) $1"; }

stamp start
bash ~/harness/deploy.sh "$ref" --worker > $out/deploy.log 2>&1 || { stamp deploy-failed; exit 1; }
( cd ~/stacks/scale-test && git log --oneline -1 ) > $out/commit.txt
bash ~/harness/reset.sh > $out/reset.log; sleep 5
docker inspect scale-test-postgres-1 --format '{{.HostConfig.ShmSize}}' > $out/shm.txt
( cd ~/stacks/scale-test && node tools/scale-dataset/generate.mjs --out ~/scale-data/p100 --scale 1 --no-comma-fixture ) > $out/generate.log 2>&1
( cd ~/scale-data/p100 && sha256sum *.csv ) > $out/dataset.sha256

MIN_MB=2500 nohup bash ~/harness/pgguard.sh $out/timeline.txt > /dev/null 2>&1 & G=$!
nohup bash ~/harness/pgactivity.sh $out/pgactivity.tsv > /dev/null 2>&1 & A=$!
nohup bash ~/harness/refresh-counter.sh $out/refreshes.tsv > /dev/null 2>&1 & R=$!
# once the crawler is past the assignments phase, the CSV copies are dead weight
( until grep -q "Step 7: Identities" $out/job-timed.log 2>/dev/null; do sleep 15; done
  docker exec scale-test-web-1 sh -c 'rm -f /data/uploads/csv-*/*.csv'
  stamp csv-copies-deleted ) & W=$!

stamp load-start
bash ~/harness/run-load.sh ~/scale-data/p100 $label > $out/load.out 2>&1
stamp load-end
sleep 30; idle; stamp post-sync-idle
kill $A $R $W 2>/dev/null
docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'\t' -c \
  "select relname, n_live_tup, pg_total_relation_size(relid), pg_relation_size(relid), pg_indexes_size(relid) from pg_stat_user_tables order by 3 desc limit 15" > $out/tables-after-load.tsv
q "select pg_database_size(current_database())" > $out/db-after-load.txt

stamp restart
sed -n '/^# Startup/,$p' ~/harness/extra.sh > /tmp/startup.sh
P=scale-test API=http://localhost:3005/api out=$out res=$out/startup.tsv bash -c 'psql() { docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'"'"'\t'"'"' -c "$1"; }; P=scale-test; '"$(cat /tmp/startup.sh)" > $out/startup.out 2>&1
idle; stamp restart-idle

stamp bench
bash ~/harness/bench.sh $label > $out/bench.out 2>&1
idle; stamp bench-end

stamp filter-shape
bash ~/harness/filter-shape.sh step7-filter-shape > $out/filter-shape.out 2>&1
stamp done
kill $G 2>/dev/null

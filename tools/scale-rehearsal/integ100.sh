#!/usr/bin/env bash
# Combined, PRE-MERGE full-scale run on integ/scale-fixes-premerge.
label=integ100; out=~/scale-runs/$label; mkdir -p $out
cd ~/stacks/scale-test && node tools/scale-dataset/generate.mjs --out ~/scale-data/p100 --scale 1 --no-comma-fixture > $out/generate.log 2>&1
bash ~/harness/deploy.sh integ/scale-fixes-premerge --worker > $out/deploy.log 2>&1
bash ~/harness/reset.sh > /dev/null; sleep 5
MIN_MB=2500 nohup bash ~/harness/pgguard.sh $out/timeline.txt > /dev/null 2>&1 & G=$!
nohup bash ~/harness/pgactivity.sh $out/pgactivity.tsv > /dev/null 2>&1 & A=$!
nohup bash ~/harness/refresh-counter.sh $out/refreshes.tsv > /dev/null 2>&1 & R=$!
# once the crawler is past the assignments phase (Step 7), the CSV copies are dead weight
( until grep -q "Step 7: Identities" $out/job-timed.log 2>/dev/null; do sleep 15; done
  docker exec scale-test-web-1 sh -c 'rm -f /data/uploads/csv-*/*.csv'
  echo "$(date +%s) csv-copies-deleted" >> $out/timeline.txt ) & W=$!
( until grep -q "copied in" ~/integ100.out 2>/dev/null; do sleep 5; done; rm -f ~/scale-data/p100/*.csv ) &
bash ~/harness/run-load.sh ~/scale-data/p100 $label
sleep 30
until [ "$(docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -Atc "select count(*) from pg_stat_activity where query like 'REFRESH MATERIALIZED%' and state='active'")" = 0 ]; do sleep 10; done
echo "$(date +%s) post-job-idle" >> $out/timeline.txt
kill $A $R $W 2>/dev/null
docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'\t' -c \
  "select relname, n_live_tup, pg_total_relation_size(relid), pg_relation_size(relid), pg_indexes_size(relid) from pg_stat_user_tables order by 3 desc limit 12" > $out/tables-final.tsv
docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -Atc "select pg_database_size(current_database())" >> $out/tables-final.tsv
echo done

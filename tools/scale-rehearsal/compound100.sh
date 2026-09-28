#!/usr/bin/env bash
# Steps 5 + 6 together at 41M, PRE-MERGE (integ branch): a first load of every
# assignment through stages into an empty ResourceAssignments, as a system's initial
# load, then an unchanged re-import with the same system rows.
out=~/scale-runs/compound100; mkdir -p $out
q() { docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -Atc "$1"; }
state() { q "select count(*) || ' live rows; RA ' || pg_size_pretty(pg_total_relation_size('\"ResourceAssignments\"')) || '; RA history rows ' || (select count(*) from \"_history\" where \"tableName\"='ResourceAssignments') || '; history ' || pg_size_pretty(pg_total_relation_size('\"_history\"')) || '; db ' || pg_size_pretty(pg_database_size(current_database())) from \"ResourceAssignments\" where \"deletedAt\" is null"; }
bash ~/harness/deploy.sh integ/scale-fixes-premerge > $out/deploy.log 2>&1
cd ~/stacks/scale-test && node tools/scale-dataset/generate.mjs --out ~/scale-data/p100 --scale 1 --no-comma-fixture > $out/generate.log 2>&1
MIN_MB=2500 nohup bash ~/harness/pgguard.sh $out/timeline.txt > /dev/null 2>&1 & G=$!
nohup bash ~/harness/sampler.sh $out/samples.tsv 5 > /dev/null 2>&1 & S=$!
# a first load: empty table, systems that have never completed a sync
q 'TRUNCATE "ResourceAssignments"' > /dev/null
q "DELETE FROM \"_history\" WHERE \"tableName\"='ResourceAssignments'" > /dev/null
q 'UPDATE "Systems" SET "lastSyncDateTime" = NULL' > /dev/null
q 'VACUUM "_history"' > /dev/null; q CHECKPOINT > /dev/null
echo "before: $(state); free $(df -h --output=avail / | tail -1)" | tee -a $out/results.txt
python3 ~/harness/stage-bench.py ~/scale-data/p100/Assignments.csv stage first | tee -a $out/results.txt
echo "after first: $(state); free $(df -h --output=avail / | tail -1)" | tee -a $out/results.txt
q CHECKPOINT > /dev/null
python3 ~/harness/stage-bench.py ~/scale-data/p100/Assignments.csv stage repeat | tee -a $out/results.txt
echo "after repeat: $(state); free $(df -h --output=avail / | tail -1)" | tee -a $out/results.txt
kill $S $G 2>/dev/null
echo done | tee -a $out/results.txt

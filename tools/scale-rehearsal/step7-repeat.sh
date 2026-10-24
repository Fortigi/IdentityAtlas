#!/usr/bin/env bash
# Step 7, second half: the repeat import, then filter discovery at the customer shape.
#   step7-repeat.sh [ref] [configId]      (defaults: main, 1)
# Waits for step7.sh to finish, redeploys <ref> onto the SAME database (so the
# repeat runs the code with every fix merged), then:
#   1. re-runs the same CSV crawler config over byte-identical files, as a user
#      re-running a crawler would, and records what changed: systems (count and
#      ids), rows per system, _history rows and bytes, database size;
#   2. an unchanged re-import through the staged full load (stage-bench.py);
#   3. filter-shape.sh (held until now: it rewrites every principal and resource).
set -uo pipefail
ref=${1:-main}; cid=${2:-1}; label=step7-repeat; out=~/scale-runs/$label; mkdir -p $out
API=http://localhost:3005/api
q() { docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'\t' -c "$1"; }
idle() { until [ "$(q "select count(*) from pg_stat_activity where query like 'REFRESH MATERIALIZED%' and state='active'")" = 0 ]; do sleep 10; done; }
stamp() { echo "$(date +%s) $1" >> $out/timeline.txt; echo "$(date -Is) $1"; }
snapshot() { # label
  {
    echo "== $1 $(date -Is)"
    echo "systems $(q "select count(*), md5(string_agg(id::text || \"displayName\", ',' order by id)) from \"Systems\"")"
    echo "principals-by-system $(q "select md5(string_agg(\"systemId\"::text || ':' || n, ',' order by \"systemId\")) from (select \"systemId\", count(*) n from \"Principals\" group by 1) x")"
    echo "resources-by-system $(q "select md5(string_agg(\"systemId\"::text || ':' || n, ',' order by \"systemId\")) from (select \"systemId\", count(*) n from \"Resources\" group by 1) x")"
    echo "assignments live $(q "select count(*) from \"ResourceAssignments\" where \"deletedAt\" is null")"
    echo "assignments governed-pairs $(q "select count(*) from \"ResourceAssignments\" a join \"ResourceAssignments\" b on b.\"resourceId\"=a.\"resourceId\" and b.\"principalId\"=a.\"principalId\" and b.\"assignmentType\"=a.\"assignmentType\" and a.governed and not b.governed")"
    echo "history rows $(q "select count(*) from \"_history\"")"
    echo "history by table/op $(q "select string_agg(\"tableName\" || '/' || operation || '=' || n, ' ' order by \"tableName\", operation) from (select \"tableName\", operation, count(*) n from \"_history\" group by 1,2) x")"
    echo "history bytes $(q "select pg_total_relation_size('\"_history\"')")"
    echo "db bytes $(q "select pg_database_size(current_database())")"
    echo "free $(df -h --output=avail / | tail -1)"
  } | tee -a $out/snapshots.txt
}

until ! pgrep -f "harness/step7.sh" > /dev/null; do sleep 60; done
stamp start
bash ~/harness/deploy.sh "$ref" --worker > $out/deploy.log 2>&1 || { stamp deploy-failed; exit 1; }
( cd ~/stacks/scale-test && git log --oneline -1 ) > $out/commit.txt
idle
snapshot before

# 1. the CSV crawler, same config, identical files
dest=/data/uploads/csv-$cid
docker exec scale-test-web-1 mkdir -p $dest
for f in Systems Contexts Resources ContextMembers Users Assignments; do docker cp ~/scale-data/p100/$f.csv scale-test-web-1:$dest/$f.csv > /dev/null; done
MIN_MB=2500 nohup bash ~/harness/pgguard.sh $out/timeline.txt > /dev/null 2>&1 & G=$!
nohup bash ~/harness/refresh-counter.sh $out/refreshes.tsv > /dev/null 2>&1 & R=$!
stamp csv-repeat-start
CONFIG_ID=$cid bash ~/harness/run-load.sh ~/scale-data/p100 $label > $out/load.out 2>&1
stamp csv-repeat-end
sleep 30; idle; stamp csv-repeat-idle
kill $R 2>/dev/null
docker exec scale-test-web-1 sh -c "rm -f $dest/*.csv"
snapshot after-csv-repeat

# 2. the staged path, unchanged re-import
stamp staged-repeat-start
python3 ~/harness/stage-bench.py ~/scale-data/p100/Assignments.csv stage staged-repeat > $out/staged.out 2>&1
stamp staged-repeat-end
idle
snapshot after-staged-repeat

# 3. filter discovery at the customer's attribute shape
stamp filter-shape
FORCE=1 bash ~/harness/filter-shape.sh step7-filter-shape > $out/filter-shape.out 2>&1
stamp done
kill $G 2>/dev/null

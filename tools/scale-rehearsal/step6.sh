#!/usr/bin/env bash
# Step 6 A/B on the current deployment. Assumes a full CSV load has populated the DB.
out=~/scale-runs/step6-$1; mkdir -p $out; csv=~/scale-data/p10/Assignments.csv
q() { docker exec scale-test-postgres-1 psql -U identity_atlas -d identity_atlas -Atc "$1"; }
state() { q "select count(*) || ' rows, keys md5 ' || md5(string_agg(\"resourceId\"::text||\"principalId\"::text, ',' order by \"resourceId\",\"principalId\")) || ', history ' || (select count(*) from \"_history\" where \"tableName\"='ResourceAssignments') from \"ResourceAssignments\" where \"deletedAt\" is null"; }
empty() { q 'TRUNCATE "ResourceAssignments"' >/dev/null; q "DELETE FROM \"_history\" WHERE \"tableName\"='ResourceAssignments'" >/dev/null; q 'VACUUM ANALYZE "ResourceAssignments"' >/dev/null; q CHECKPOINT >/dev/null; }
for proto in stage; do
  empty
  python3 ~/harness/stage-bench.py $csv $proto first | tee -a $out/results.jsonl; echo "  after first-$proto: $(state)" | tee -a $out/results.jsonl
  q CHECKPOINT >/dev/null
  python3 ~/harness/stage-bench.py $csv $proto repeat | tee -a $out/results.jsonl; echo "  after repeat-$proto: $(state)" | tee -a $out/results.jsonl
done

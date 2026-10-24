#!/usr/bin/env bash
# Step 6 design input: how should rows get from a staging table into an indexed
# ResourceAssignments? Same 4.1M rows, same production indexes, no history trigger
# (so the index cost is isolated). Variants:
#   batched-10k        today's shape: 10k-row INSERT .. ON CONFLICT per committed batch, file order
#   batched-10k-sorted the same, but the stage read in unique-key order
#   one-merge-sorted   a single INSERT .. SELECT .. ORDER BY key ON CONFLICT DO UPDATE
#   one-merge-unsorted a single INSERT .. SELECT in file order
#   bare-then-build    plain INSERT into an unindexed table, then CREATE the 13 indexes
#   merge-into-populated  one sorted merge of the same 4.1M rows into a table that
#                      already holds 4.1M OTHER rows (the repeat/second-system case)
#   merge-existing     one sorted merge of 4.1M rows that ALL already exist (an unchanged re-import)
#   merge-existing-if-changed  same, but DO UPDATE ... WHERE something changed
# merge-experiment.sh <Assignments.csv> <out>
set -euo pipefail
csv=$1; out=$2; P=${P:-scale-test}
q() { docker exec -i ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -v ON_ERROR_STOP=1 -At "$@"; }
docker cp "$csv" ${P}-postgres-1:/tmp/exp.csv
q <<'SQL'
DROP TABLE IF EXISTS exp_stage, exp_src;
CREATE UNLOGGED TABLE exp_stage(res text, usr text, typ text, sys text);
COPY exp_stage FROM '/tmp/exp.csv' WITH (FORMAT csv, DELIMITER E'\t', HEADER true);
CREATE UNLOGGED TABLE exp_src AS
  SELECT row_number() OVER () AS rn, md5('r'||res)::uuid AS rid, md5('u'||usr)::uuid AS pid, typ FROM exp_stage;
CREATE INDEX ON exp_src(rn);
DROP TABLE exp_stage;
ANALYZE exp_src;
CREATE OR REPLACE PROCEDURE exp_batches(sorted bool) LANGUAGE plpgsql AS $$
DECLARE n bigint; b bigint := 0; t0 timestamptz := clock_timestamp();
BEGIN
  IF sorted THEN
    DROP TABLE IF EXISTS exp_src_sorted;
    CREATE UNLOGGED TABLE exp_src_sorted AS SELECT row_number() OVER (ORDER BY rid, pid, typ) AS rn, rid, pid, typ FROM exp_src;
    CREATE INDEX ON exp_src_sorted(rn);
  END IF;
  SELECT max(rn) INTO n FROM exp_src;
  WHILE b < n LOOP
    EXECUTE format('INSERT INTO exp."ResourceAssignments" ("resourceId","principalId","assignmentType","systemId","updatedAt")
             SELECT rid, pid, typ, 1, now() FROM %I WHERE rn > $1 AND rn <= $2
             ON CONFLICT ("resourceId","principalId","assignmentType",governed) WHERE "principalId" IS NOT NULL
             DO UPDATE SET "updatedAt" = EXCLUDED."updatedAt", "systemId" = EXCLUDED."systemId"',
             CASE WHEN sorted THEN 'exp_src_sorted' ELSE 'exp_src' END) USING b, b + 10000;
    COMMIT;
    b := b + 10000;
  END LOOP;
  RAISE NOTICE 'seconds=%', round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
END $$;
SQL
setup() { q -c "DROP SCHEMA IF EXISTS exp CASCADE" -c "CREATE SCHEMA exp" \
  -c "CREATE TABLE exp.\"ResourceAssignments\" (LIKE public.\"ResourceAssignments\" INCLUDING DEFAULTS INCLUDING CONSTRAINTS $1)" >/dev/null; }
timed() { local label=$1; shift; q -c 'CHECKPOINT' >/dev/null; local t0=$(date +%s.%N); "$@" >/dev/null 2>&1; echo -e "$label\t$(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{printf "%.1f", a-b}')\t$(q -c "select pg_size_pretty(pg_total_relation_size('exp.\"ResourceAssignments\"'))")" | tee -a "$out"; }
MERGE_SORTED="INSERT INTO exp.\"ResourceAssignments\" (\"resourceId\",\"principalId\",\"assignmentType\",\"systemId\",\"updatedAt\") SELECT rid, pid, typ, 1, now() FROM exp_src ORDER BY rid, pid, typ ON CONFLICT (\"resourceId\",\"principalId\",\"assignmentType\",governed) WHERE \"principalId\" IS NOT NULL DO UPDATE SET \"updatedAt\" = EXCLUDED.\"updatedAt\", \"systemId\" = EXCLUDED.\"systemId\""
MERGE_UNSORTED="${MERGE_SORTED/ ORDER BY rid, pid, typ/}"
MERGE_IF_CHANGED="${MERGE_SORTED} WHERE exp.\"ResourceAssignments\".\"systemId\" IS DISTINCT FROM EXCLUDED.\"systemId\""
: > "$out"
setup "INCLUDING INDEXES"; timed batched-10k q -c "CALL exp_batches(false)"
setup "INCLUDING INDEXES"; timed batched-10k-sorted q -c "CALL exp_batches(true)"
setup "INCLUDING INDEXES"; timed one-merge-sorted q -c "$MERGE_SORTED"
setup "INCLUDING INDEXES"; timed one-merge-unsorted q -c "$MERGE_UNSORTED"
setup ""; timed bare-load q -c "INSERT INTO exp.\"ResourceAssignments\" (\"resourceId\",\"principalId\",\"assignmentType\",\"systemId\",\"updatedAt\") SELECT rid, pid, typ, 1, now() FROM exp_src"
build() { q -c "select indexdef from pg_indexes where schemaname='public' and tablename='ResourceAssignments'" | \
  sed 's/ON public."ResourceAssignments"/ON exp."ResourceAssignments"/; s/INDEX "\([^"]*\)"/INDEX "exp_\1"/; s/$/;/' | q; }
timed then-build-13-indexes build
# second system / repeat: the target already holds 4.1M rows
setup "INCLUDING INDEXES"
q -c "INSERT INTO exp.\"ResourceAssignments\" (\"resourceId\",\"principalId\",\"assignmentType\",\"systemId\") SELECT md5('x'||rid::text)::uuid, pid, typ, 2 FROM exp_src ORDER BY 1, pid, typ" >/dev/null
timed merge-into-populated q -c "$MERGE_SORTED"
timed merge-existing-unchanged q -c "$MERGE_SORTED"
timed merge-existing-if-changed q -c "$MERGE_IF_CHANGED"
q -c "DROP SCHEMA exp CASCADE" -c "DROP TABLE IF EXISTS exp_src, exp_src_sorted" -c "DROP PROCEDURE exp_batches" >/dev/null

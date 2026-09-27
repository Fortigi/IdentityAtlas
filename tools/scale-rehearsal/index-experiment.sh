#!/usr/bin/env bash
# Where does bulk-insert time go? Loads the same N assignment rows into a copy of
# ResourceAssignments (same name, schema "exp", so the history trigger keys it
# exactly as in production) in 10k-row committed batches, four ways:
#   bare      no indexes, no trigger, plain INSERT
#   indexed   all 13 production indexes, INSERT ... ON CONFLICT DO UPDATE (the ingest's shape)
#   history   indexed + the production history trigger
#   rebuild   bare, then build the 13 indexes afterwards (drop-and-rebuild strategy)
#   index-experiment.sh <Assignments.csv> <out.txt>
set -euo pipefail
csv=$1; out=$2; P=${P:-scale-test}
q() { docker exec -i ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -v ON_ERROR_STOP=1 -At "$@"; }
docker cp "$csv" ${P}-postgres-1:/tmp/exp.csv
q <<'SQL'
DROP TABLE IF EXISTS exp_stage, exp_src;
CREATE UNLOGGED TABLE exp_stage(res text, usr text, typ text, sys text);
COPY exp_stage FROM '/tmp/exp.csv' WITH (FORMAT csv, DELIMITER E'\t', HEADER true);
CREATE UNLOGGED TABLE exp_src AS
  SELECT row_number() OVER () AS rn, md5('r'||res)::uuid AS rid, md5('u'||usr)::uuid AS pid, typ
    FROM exp_stage;
CREATE INDEX ON exp_src(rn);
DROP TABLE exp_stage;
ANALYZE exp_src;
CREATE OR REPLACE PROCEDURE exp_load(upsert bool) LANGUAGE plpgsql AS $$
DECLARE n bigint; b bigint := 0; t0 timestamptz := clock_timestamp();
BEGIN
  SELECT max(rn) INTO n FROM exp_src;
  WHILE b < n LOOP
    EXECUTE 'INSERT INTO exp."ResourceAssignments" ("resourceId","principalId","assignmentType","systemId","updatedAt")
             SELECT rid, pid, typ, 1, now() FROM exp_src WHERE rn > $1 AND rn <= $2'
      || CASE WHEN upsert THEN ' ON CONFLICT ("resourceId","principalId","assignmentType",governed) WHERE "principalId" IS NOT NULL
                                DO UPDATE SET "updatedAt" = EXCLUDED."updatedAt", "systemId" = EXCLUDED."systemId"' ELSE '' END
      USING b, b + 10000;
    COMMIT;
    b := b + 10000;
  END LOOP;
  RAISE NOTICE 'rows=% seconds=%', n, round(extract(epoch FROM clock_timestamp() - t0)::numeric, 1);
END $$;
SQL
setup() { # $1 = INCLUDING clause extras, $2 = trigger yes/no
  q -c "DROP SCHEMA IF EXISTS exp CASCADE" -c "CREATE SCHEMA exp" \
    -c "CREATE TABLE exp.\"ResourceAssignments\" (LIKE public.\"ResourceAssignments\" INCLUDING DEFAULTS INCLUDING CONSTRAINTS $1)" >/dev/null
  if [ "$2" = yes ]; then
    q -c 'CREATE TRIGGER trg_history_ins_del AFTER INSERT OR DELETE ON exp."ResourceAssignments" FOR EACH ROW EXECUTE FUNCTION fg_record_history()' >/dev/null
  fi
}
sizes() { q -c "select pg_size_pretty(pg_total_relation_size('exp.\"ResourceAssignments\"')), pg_size_pretty(pg_total_relation_size('\"_history\"'))"; }
run() { # label upsert
  q -c 'CHECKPOINT' >/dev/null
  local t=$( { q -c "CALL exp_load($2)" 2>&1 >/dev/null; } | grep -o 'rows=.*')
  echo -e "$1\t$t\t$(sizes)" | tee -a "$out"
}
: > "$out"
setup "" no;                  run bare false
setup "INCLUDING INDEXES" no; run indexed true
setup "INCLUDING INDEXES" yes; run history true
q -c "TRUNCATE \"_history\"" >/dev/null
# rebuild: bare load, then the 13 production index definitions against it
setup "" no; run rebuild-load false
t0=$(date +%s.%N)
q -c "select indexdef from pg_indexes where schemaname='public' and tablename='ResourceAssignments'" | \
  sed 's/ON public."ResourceAssignments"/ON exp."ResourceAssignments"/; s/INDEX "\([^"]*\)"/INDEX "exp_\1"/; s/$/;/' | q >/dev/null
echo -e "rebuild-indexes\tseconds=$(awk -v a="$(date +%s.%N)" -v b="$t0" "BEGIN{printf \"%.1f\", a-b}")\t$(sizes)" | tee -a "$out"
q -c "DROP SCHEMA exp CASCADE" -c "DROP TABLE exp_src" -c "DROP PROCEDURE exp_load" >/dev/null

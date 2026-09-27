#!/usr/bin/env bash
# Load a generated fixture into the SQL Server container:
#   schema (heaps) → bcp every table → keys and indexes → row counts vs manifest.
#
#   ./load.sh [data-dir-inside-container] [database]
#
# Run on the Docker host, from this directory, after `docker compose up -d`.
# The data directory is the one generate.mjs wrote, mounted into the container
# at /fixture-data (FIXTURE_DATA_DIR in .env). Fails if any count differs.
set -euo pipefail

DATA="${1:-/fixture-data}"
DB="${2:-iiq_fixture}"
CONTAINER="${CONTAINER:-iiq-fixture-mssql-1}"
TOOLS=/opt/mssql-tools18/bin

in_container() { docker exec -i "$CONTAINER" bash -c "$1"; }
sql() { in_container "$TOOLS/sqlcmd -C -S localhost -U sa -P \"\$MSSQL_SA_PASSWORD\" -b -h -1 -W -d $DB -Q \"SET NOCOUNT ON; $1\""; }
run_script() {
  docker cp "sql/$1" "$CONTAINER:/tmp/$1"
  in_container "$TOOLS/sqlcmd -C -S localhost -U sa -P \"\$MSSQL_SA_PASSWORD\" -b -v DatabaseName=$DB -i /tmp/$1"
}

MANIFEST="$(in_container "cat $DATA/manifest.json")"
# Tables in load order with their expected row counts, from the manifest.
mapfile -t ROWS < <(printf '%s' "$MANIFEST" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    for (const t of JSON.parse(s).tables) console.log(`${t.table} ${t.rows}`);
  });')

echo "== schema"
run_script 01-schema.sql

for entry in "${ROWS[@]}"; do
  table="${entry% *}"
  echo "== bcp $table"
  start=$(date +%s)
  # -c character mode, 0x1f / 0x1e terminators, UTF-8, TABLOCK into a heap, and
  # fail on the first bad row instead of skipping it.
  in_container "$TOOLS/bcp $table in $DATA/$table.bcp -S localhost -U sa -P \"\$MSSQL_SA_PASSWORD\" -d $DB -u \
    -c -t 0x1f -r 0x1e -C 65001 -b 100000 -h TABLOCK -m 1 -e /tmp/$table.err" | grep -E 'rows copied|Error|error' || true
  echo "   $(( $(date +%s) - start )) s"
done

echo "== keys and indexes"
start=$(date +%s)
run_script 02-keys.sql
echo "   $(( $(date +%s) - start )) s"

echo "== counts"
fail=0
for entry in "${ROWS[@]}"; do
  table="${entry% *}"; want="${entry#* }"
  got="$(sql "SELECT COUNT_BIG(*) FROM $table" | tr -d '[:space:]')"
  if [ "$got" = "$want" ]; then echo "   ok   $table $got"; else echo "   FAIL $table loaded $got, generated $want"; fail=1; fi
done
exit $fail

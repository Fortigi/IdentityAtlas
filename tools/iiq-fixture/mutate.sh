#!/usr/bin/env bash
# Move the loaded fixture on the way a real source moves between two refreshes,
# so an incremental load has something to find. See sql/03-mutate.sql for what
# each change is for.
#
#   ./mutate.sh [database] [updated] [deleted] [reinserted]
#
# Run on the Docker host, from this directory, after ./load.sh. Prints what it
# changed and the table counts that follow, which is what a rehearsal compares
# PostgreSQL against.
#
# Defaults are a NORMAL day, not a disaster: a key sweep refuses to remove more
# than 5% of a scope without an explicit override, and a fixture that only ever
# rehearses the refusal rehearses the wrong thing.
set -euo pipefail

DB="${1:-iiq_fixture}"
UPDATED="${2:-2000}"
DELETED="${3:-500}"
REINSERTED="${4:-500}"
CONTAINER="${CONTAINER:-iiq-fixture-mssql-1}"
TOOLS=/opt/mssql-tools18/bin

docker cp sql/03-mutate.sql "$CONTAINER:/tmp/03-mutate.sql" >/dev/null
docker exec -i "$CONTAINER" bash -c \
  "$TOOLS/sqlcmd -C -S localhost -U sa -P \"\$MSSQL_SA_PASSWORD\" -b \
     -v DatabaseName=$DB -v Updated=$UPDATED -v Deleted=$DELETED -v Reinserted=$REINSERTED \
     -i /tmp/03-mutate.sql"

#!/usr/bin/env bash
# Post-load measurements against the scale-test stack.  bench.sh <label>
# Each call: HTTP code, wall seconds, bytes. --max-time caps a call at $CAP s so a
# call that does not finish is reported as such (curl code 28) instead of hanging.
set -uo pipefail
label=$1; P=${P:-scale-test}; API=${API:-http://localhost:3005/api}; CAP=${CAP:-1800}
out=~/scale-runs/$label; mkdir -p "$out"; res="$out/bench.tsv"
KEY=$(docker exec ${P}-web-1 cat /data/uploads/.builtin-worker-key)
psql() { docker exec ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'\t' -c "$1"; }
bench() { # name method path [body] [auth]
  local name=$1 m=$2 p=$3 body=${4:-} auth=${5:-} t0 r
  local args=(-sS -o "$out/body-$name.out" -w '%{http_code}\t%{time_total}\t%{size_download}' --max-time "$CAP" -X "$m" "$API$p")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $KEY")
  t0=$(date +%s)
  r=$(curl "${args[@]}" 2>"$out/err-$name.txt"); rc=$?
  local note=''
  # A dropped or refused connection means the API process died: wait for it to come
  # back so the next measurement is not a false "refused", and record the restart.
  if [ $rc -ne 0 ] && [ $rc -ne 28 ]; then
    sleep 3
    for i in $(seq 1 90); do curl -sf -o /dev/null "$API/health" && break; sleep 2; done
    note="api-restarted:$(docker inspect ${P}-web-1 --format '{{.RestartCount}}')"
  fi
  echo -e "$name\t$t0\t$rc\t$r\t$note" | tee -a "$res"
}
# SKIP=<regex> leaves matching measurements out; ONLY=<regex> runs just the matching ones.
skip() { [[ -n "${SKIP:-}" && "$1" =~ $SKIP ]] || [[ -n "${ONLY:-}" && ! "$1" =~ $ONLY ]]; }
echo -e "name\tstart_epoch\tcurl_rc\thttp\tseconds\tbytes\tnote" > "$res"

# ── post-sync work, timed on its own ───────────────────────────────
# Since #1269 these return once the refresh is SCHEDULED; it runs in the
# background. settle() waits for it and records how long it really took, so no
# later measurement shares the database with a refresh (a first bench on step 7
# did, and its matrix numbers were void).
settle() { # name
  local t0; t0=$(date +%s); sleep 5
  until [ "$(psql "select count(*) from pg_stat_activity where query like 'REFRESH MATERIALIZED%' and state='active'")" = 0 ]; do sleep 2; done
  echo -e "$1-background	$t0	0	-	$(( $(date +%s) - t0 ))	0	refresh finished" | tee -a "$res"
}
skip classify-business-roles || { bench classify-business-roles POST /ingest/classify-business-role-assignments '{}' auth; settle classify-business-roles; }
skip refresh-views || { bench refresh-views           POST /ingest/refresh-views '{}' auth; settle refresh-views; }
skip refresh-views-again || { bench refresh-views-again     POST /ingest/refresh-views '{}' auth; settle refresh-views-again; }
skip build-contexts-hook || bench build-contexts-hook     POST /ingest/refresh-contexts '{}' auth

# ── ids for the targeted calls ─────────────────────────────────────
TOP=$(psql 'select "resourceId", count(*) from "ResourceAssignments" group by 1 order by 2 desc limit 1')
TOP_ID=${TOP%%$'\t'*}; echo -e "# top resource $TOP" | tee -a "$res"
APP=$(psql "select c.id, count(*) from \"Contexts\" c join \"ContextMembers\" m on m.\"contextId\"=c.id where c.\"contextType\"='LogicalApplication' group by 1 order by 2 desc limit 1")
APP_ID=${APP%%$'\t'*}; echo -e "# largest application $APP" | tee -a "$res"
MIDSYS=$(psql "select \"systemId\", count(*) from \"Resources\" where \"resourceType\"<>'BusinessRole' group by 1 order by 2 desc offset 10 limit 1")
MIDSYS_ID=${MIDSYS%%$'\t'*}; echo -e "# mid-size system $MIDSYS" | tee -a "$res"

# ── matrix, principal rows ─────────────────────────────────────────
M='{"filter":{"rowType":"principal","subject":{"include":[],"exclude":[]},"resource":{"include":[],"exclude":[]},"includeBusinessRoles":false}}'
skip matrix-unfiltered || bench matrix-unfiltered POST /matrix/data "$M"
skip matrix-scope-stats || bench matrix-scope-stats POST /matrix/scope-stats "$M"
F1='{"filter":{"rowType":"principal","subject":{"include":[{"kind":"attribute","field":"accountEnabled","values":["true"]}],"exclude":[]},"resource":{"include":[],"exclude":[]}}}'
skip matrix-enabled-only || bench matrix-enabled-only POST /matrix/data "$F1"
F2="{\"filter\":{\"rowType\":\"principal\",\"subject\":{\"include\":[{\"kind\":\"attribute\",\"field\":\"accountEnabled\",\"values\":[\"true\"]},{\"kind\":\"attribute\",\"field\":\"department\",\"values\":[\"Finance\"]}],\"exclude\":[]},\"resource\":{\"include\":[{\"kind\":\"attribute\",\"field\":\"systemId\",\"values\":[\"$MIDSYS_ID\"]}],\"exclude\":[]}}}"
skip matrix-enabled-finance-midsystem || bench matrix-enabled-finance-midsystem POST /matrix/data "$F2"
F3="{\"filter\":{\"rowType\":\"principal\",\"subject\":{\"include\":[{\"kind\":\"attribute\",\"field\":\"accountEnabled\",\"values\":[\"true\"]}],\"exclude\":[]},\"resource\":{\"include\":[{\"kind\":\"context\",\"contextId\":\"$APP_ID\",\"includeChildren\":true}],\"exclude\":[]}}}"
skip matrix-largest-application || bench matrix-largest-application POST /matrix/data "$F3"

# ── logical applications (the pivot the API offers) ────────────────
skip contexts-list-applications || bench contexts-list-applications GET '/contexts?targetType=Resource&contextType=LogicalApplication'
skip context-detail-largest || bench context-detail-largest GET "/contexts/$APP_ID"
skip context-members-page1 || bench context-members-page1 GET "/contexts/$APP_ID/members?limit=50&offset=0"
skip context-members-deep-page || bench context-members-deep-page GET "/contexts/$APP_ID/members?limit=50&offset=50000"

# ── resource detail, six-figure membership ─────────────────────────
skip resource-detail || bench resource-detail GET "/resources/$TOP_ID"
skip resource-assignments || bench resource-assignments GET "/resources/$TOP_ID/assignments"
skip resource-members || bench resource-members GET "/resources/$TOP_ID/members"

# ── report templates ───────────────────────────────────────────────
skip reports-list || bench reports-list GET /reports
skip report-disabled-with-access-rows || bench report-disabled-with-access-rows GET /reports/disabled-accounts-with-access/rows
skip report-disabled-with-access-csv || bench report-disabled-with-access-csv GET '/reports/disabled-accounts-with-access/export?format=csv'
skip report-access-outside-roles-rows || bench report-access-outside-roles-rows GET /reports/access-outside-roles/rows

# ── dashboard ──────────────────────────────────────────────────────
skip dashboard-stats || bench dashboard-stats GET /admin/dashboard-stats
psql "select relname, n_live_tup, pg_total_relation_size(relid), pg_relation_size(relid), pg_indexes_size(relid) from pg_stat_user_tables order by 3 desc limit 25" > "$out/tables-after-bench.tsv"
psql "select matviewname, pg_total_relation_size(format('%I', matviewname)::regclass) from pg_matviews" >> "$out/tables-after-bench.tsv"

# ── filter-value discovery (list-page filters), COLD then warm ─────
# /matrix/columns runs a SELECT DISTINCT … LIMIT per column and per
# extendedAttributes key, behind a 5-minute in-process cache. A warm rig hides it,
# so restart the API to empty the cache and measure what a user opening the app
# gets, then the same calls warm. (Reported from a customer install, 2026-09-27.)
if ! skip filter-discovery; then
  docker restart ${P}-web-1 >/dev/null
  for i in $(seq 1 150); do curl -sf -o /dev/null "$API/health" && break; sleep 2; done
  echo -e "# filter discovery: api restarted, cache cold" | tee -a "$res"
  for e in Principal Identity Resource; do bench "filter-columns-schema-$e-cold" GET "/matrix/columns?entity=$e&schema=true"; done
  for e in Principal Identity Resource; do bench "filter-columns-values-$e-cold" GET "/matrix/columns?entity=$e"; done
  for e in Principal Identity Resource; do bench "filter-columns-values-$e-warm" GET "/matrix/columns?entity=$e"; done
  EXT=$(psql "select k from \"Principals\", jsonb_object_keys(\"extendedAttributes\") k group by 1 order by count(*) desc limit 1")
  echo -e "# most common principal extension key: $EXT" | tee -a "$res"
  [ -n "$EXT" ] && bench filter-column-values-ext GET "/matrix/column-values?entity=Principal&column=ext.$EXT&q=a"
  bench filter-column-values-dept GET "/matrix/column-values?entity=Principal&column=department&q=a"
  psql "select count(distinct k) from \"Principals\", jsonb_object_keys(\"extendedAttributes\") k" | sed 's/^/# principal extension keys: /' | tee -a "$res"
fi

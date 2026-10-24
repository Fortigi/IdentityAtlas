#!/usr/bin/env bash
# Extra before/after points: a valid deep members page, a small application with
# and without the enabled filter, and the refresh the API runs when it starts.
#   extra.sh <label>
label=$1; P=${P:-scale-test}; API=${API:-http://localhost:3005/api}; CAP=${CAP:-900}
out=~/scale-runs/$label; mkdir -p "$out"; res="$out/extra.tsv"; : > "$res"
psql() { docker exec ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'\t' -c "$1"; }
t() { local name=$1; shift; curl -sS -o "$out/xbody-$name.out" -w "$name\t%{http_code}\t%{time_total}\t%{size_download}\n" --max-time "$CAP" "$@" | tee -a "$res"; }
APP=$(psql "select c.id from \"Contexts\" c join \"ContextMembers\" m on m.\"contextId\"=c.id where c.\"contextType\"='LogicalApplication' group by 1 order by count(*) desc limit 1")
n=$(psql "select count(*) from \"ContextMembers\" where \"contextId\"='$APP'")
t members-deep-valid "$API/contexts/$APP/members?limit=50&offset=$(( n * 6 / 10 ))"
t members-search "$API/contexts/$APP/members?limit=50&offset=0&search=READ"
t members-descendants "$API/contexts/$APP/members?limit=50&offset=0&include=descendants"
SMALL=$(psql "select c.id from \"Contexts\" c join \"ContextMembers\" m on m.\"contextId\"=c.id where c.\"contextType\"='LogicalApplication' group by 1 order by count(*) asc limit 1")
for subj in '[]' '[{"kind":"attribute","field":"accountEnabled","values":["true"]}]'; do
  name=matrix-small-app; [ "$subj" != '[]' ] && name=matrix-small-app-enabled
  t $name -X POST "$API/matrix/data" -H 'Content-Type: application/json' \
    -d "{\"filter\":{\"rowType\":\"principal\",\"subject\":{\"include\":$subj,\"exclude\":[]},\"resource\":{\"include\":[{\"kind\":\"context\",\"contextId\":\"$SMALL\",\"includeChildren\":true}],\"exclude\":[]}}}"
done
# Startup: restart the API and time any matrix-view refresh it starts on its own.
docker restart ${P}-web-1 >/dev/null; t0=$(date +%s); seen=0; last=$t0
for i in $(seq 1 360); do
  r=$(psql "select count(*) from pg_stat_activity where datname=current_database() and query like 'REFRESH MATERIALIZED%' and state='active'")
  [ "$r" != "0" ] && { seen=1; last=$(date +%s); }
  [ $seen = 1 ] && [ "$r" = "0" ] && break
  [ $seen = 0 ] && [ $(( $(date +%s) - t0 )) -gt 60 ] && break
  sleep 1
done
echo -e "startup-refresh\tseen=$seen\tseconds=$(( last - t0 ))" | tee -a "$res"

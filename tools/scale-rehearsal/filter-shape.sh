#!/usr/bin/env bash
# Filter-value discovery at the customer's attribute shape.  filter-shape.sh <label>
#
# The synthetic scale dataset carries few extendedAttributes keys. The customer's
# IdentityIQ export carries ~13 on principals and ~12 on resources, two of them
# high-cardinality (costcentercode, locationid) and three the org hierarchy a user
# (cardinalities are the customer's real ones, from their discovery queries of
# 2026-09-27: costcentercode 1,846, locationid 161, sectext 119, subdivtext 44,
# divtext 7 — over 176,789 identities)
# filters on first (divtext / sectext / subdivtext). This writes that shape onto
# the rig's rows — deterministically from the row id, so a re-run is identical —
# then measures /matrix/columns cold (API restarted: its cache is in-process, 5 min)
# and warm. Run AFTER bench.sh: it rewrites every principal and resource row, so the
# before/after comparison of the main query set must not see it.
set -uo pipefail
# step7.sh calls this last; the repeat import must come first (this rewrites every
# principal and resource row), so step7-repeat.sh runs it with FORCE=1 afterwards.
if [ -e ~/HOLD_FILTER_SHAPE ] && [ -z "${FORCE:-}" ]; then echo "held: run after step7-repeat.sh"; exit 0; fi
label=$1; P=${P:-scale-test}
psql() { docker exec ${P}-postgres-1 psql -U identity_atlas -d identity_atlas -AtF $'\t' -c "$1"; }

# h(n, salt): a stable pseudo-random integer in [0, n) from the row id.
H="(('x' || substr(md5(id::text || '%s'), 1, 8))::bit(32)::int & 2147483647) %% %s"
h() { printf "$H" "$2" "$1"; }

echo "# shaping principals $(date -Is)"
psql "SET session_replication_role = replica;  -- no history trigger for this synthetic rewrite
UPDATE \"Principals\" SET \"extendedAttributes\" = COALESCE(\"extendedAttributes\", '{}'::jsonb) || jsonb_build_object(
  'companyname',     'Company ' || ($(h 12 co)),
  'companycode',     'C' || lpad(($(h 12 co))::text, 3, '0'),
  'departmentnumber','D' || lpad(($(h 400 dn))::text, 4, '0'),
  'costcentercode',  'CC' || lpad(($(h 1846 cc))::text, 5, '0'),
  'employeegroup',   'EG' || ($(h 6 eg)),
  'employeesubgroup','ES' || ($(h 25 es)),
  'employeestatus',  (ARRAY['Active','Inactive','Leave','Retired'])[1 + ($(h 4 st))],
  'workcountry',     (ARRAY['NL','DE','BE','FR','US','GB','PL','ES'])[1 + ($(h 8 wc))],
  'locationid',      'L' || lpad(($(h 161 lo))::text, 5, '0'),
  'divtext',         'Division ' || ($(h 7 dv)),
  'sectext',         'Sector ' || ($(h 119 sc)),
  'subdivtext',      'Subdivision ' || ($(h 44 sd)),
  'hiredate',        (date '2000-01-01' + ($(h 9000 hd)))::text);"
echo "# shaping resources $(date -Is)"
psql "SET session_replication_role = replica;
UPDATE \"Resources\" SET \"extendedAttributes\" = COALESCE(\"extendedAttributes\", '{}'::jsonb) || jsonb_build_object(
  'requestable',        ($(h 2 rq)) = 1,
  'requestdelegateonly',($(h 2 rd)) = 1,
  'certfrequency',      (ARRAY['Monthly','Quarterly','Yearly','Never'])[1 + ($(h 4 cf))],
  'costcentercode',     'CC' || lpad(($(h 1846 cc))::text, 5, '0'),
  'gpi_compliance',     ($(h 2 gp)) = 1,
  'trainingcheck',      ($(h 2 tc)) = 1,
  'ncdetection',        ($(h 2 nc)) = 1,
  'usexportcontrol',    ($(h 2 ux)) = 1,
  'iiq_elevated_access',($(h 2 ea)) = 1,
  'aggregated',         ($(h 2 ag)) = 1,
  'uncorrelated',       ($(h 2 uc)) = 1,
  'ownername',          'owner' || ($(h 20000 ow)));"
psql 'VACUUM ANALYZE "Principals"'; psql 'VACUUM ANALYZE "Resources"'
psql "select 'principal keys', count(distinct k) from \"Principals\", jsonb_object_keys(\"extendedAttributes\") k
      union all select 'resource keys', count(distinct k) from \"Resources\", jsonb_object_keys(\"extendedAttributes\") k"

ONLY='^filter-' bash ~/harness/bench.sh "$label"

# Then the enabled-only queries at the customer's real active share.
[ -n "${FORCE:-}" ] && bash ~/harness/enabled-share.sh step7-enabled62

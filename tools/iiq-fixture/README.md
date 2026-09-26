# IdentityIQ-shaped scale fixture

A SQL Server database shaped like a SailPoint IdentityIQ (`spt_*`) schema,
filled with synthetic data at realistic size and shape, so the
[SQL connector](../crawlers/sql/) can be developed and verified without access
to a production IdentityIQ database. Everything in it is invented.

It is the [scale test fixture](../scale-dataset/) written down the way
IdentityIQ stores it: the same plan, the same seed, the same people,
entitlements, logical applications and holder sets. A load through the CSV
crawler and a load through the SQL crawler can therefore be compared row for
row. `generate.test.js` checks that claim against the other generator's actual
files.

## Quick start

On a Docker host (see [`docker-compose.yml`](docker-compose.yml)):

```bash
cp .env.example .env            # set MSSQL_SA_PASSWORD
docker compose up -d            # SQL Server 2022 Developer on port 14330
node generate.mjs --out data --scale 0.01
./load.sh                       # schema → bcp → keys → counts vs manifest
```

`load.sh` fails when any table's row count differs from what was generated.

## What it creates

| Table | At 100% | Notes |
|---|---:|---|
| `spt_identity` | 180,060 | people **and** their account (one row each), 75% `inactive`, plus 60 workgroups |
| `spt_application` | 40 | technical connectors |
| `spt_managed_attribute` | 800,000 | entitlements; the logical application is inside the `attributes` XML |
| `spt_custom` | 1 | the logical-application catalogue: one XML map keyed by application name |
| `spt_identity_entitlement` | 40,000,000 | grants; `granted_by_role`, `assigned` and `source` say how |
| `spt_bundle` | 10,000 | business roles |
| `spt_identity_assigned_roles` | 1,000,000 | role assignments |
| `spt_bundle_profile_relation` | ~65,000 | role composition, joinable by application + attribute + value |

The storage follows IdentityIQ's own SQL Server DDL: 32-character hex ids
sharing long prefixes, `numeric(19,0)` epoch-millisecond timestamps written by
the application, `tinyint` flags, and XML attribute maps in `nvarchar(max)`,
indented over several lines.

The schema also carries site-style **extension columns** (organisation levels,
company, cost centre, employee status and so on on `spt_identity`; compliance
flags on `spt_managed_attribute`). Their types are placeholders until checked
against a real `INFORMATION_SCHEMA` dump, as are the secondary indexes in
[`sql/02-keys.sql`](sql/02-keys.sql).

## Parameters

Shape parameters (volumes, skew, enabled share, systems spread, applications
spanning systems, near-collisions) belong to the scale fixture and are set with
`--set k=v`. They are never changed here, so both fixtures stay one dataset.

IdentityIQ parameters ([`lib/params.mjs`](lib/params.mjs), `--iiq k=v`):

| Parameter | Default | Meaning |
|---|---|---|
| `catalogName` | `Application_Catalog` | `spt_custom.name` of the catalogue record |
| `appNameKey` | `LogicalApplication` | XML key naming an entitlement's logical application |
| `catalogKeys` | 7 neutral field names | keys inside each catalogue entry |
| `workgroups` | 60 | workgroup rows in `spt_identity`, on top of the principals |
| `roleGrantedShare` | 0.2 | grants that came from a role (`granted_by_role = 1`) |
| `requestedShare` | 0.15 | other grants requested through LCM (`assigned = 1`) |
| `appNameDriftShare` | 0.002 | entitlements whose application name differs from the catalogue only by case or a trailing space |
| `unassignedAppShare` | 0 | entitlements with no logical application |
| `asOf`, `historyDays` | 2026-09-01, 3650 | every timestamp lies in this window, so output does not depend on the clock |

The catalogue record name and the XML keys are deployment-specific in real
installations. Set them to the source you are rehearsing rather than editing
the code.

## File format

One `<table>.bcp` file per table, no header, UTF-8, fields separated by `0x1f`
and records by `0x1e`. XML values contain newlines and quotes, which rules out
tab-separated text. `manifest.json` records the column order, row counts and
the shared shape statistics.

## A trap: the collation hides the drift

Logical applications are matched by **name**, and `appNameDriftShare` makes some
entitlements name their application with a different case or a trailing space.
Under a case-insensitive collation (the default, and the usual production
setting) SQL Server calls those names equal: `COUNT(DISTINCT …)` folds them
away and a join matches them. PostgreSQL compares exactly. Any matching done in
the source will therefore disagree with matching done in Identity Atlas. The
SQL connector resolves application names in one place, in the crawler, and
reports every spelling it had to fold. Do not "fix" the drift in a query.

## Known simplifications

- Grants that came from a role are not derived from that role's composition.
  The flag is a share, not a consequence.
- No `spt_link`: every identity is also its own account, which matches the
  engagement this fixture was built for.

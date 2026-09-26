# Scale test fixture

A generator for a synthetic identity-governance export at a realistic size and,
more importantly, a realistic **shape**, written in the CSV crawler's canonical
schema ([csv-import-schema.md](../../docs/architecture/csv-import-schema.md)).
It exists to find out where Identity Atlas stops coping before a real dataset of
that size does. Everything in it is invented; it contains no real data.

```bash
node tools/scale-dataset/generate.mjs --out ./scale-1pct  --scale 0.01   # seconds
node tools/scale-dataset/generate.mjs --out ./scale-10pct --scale 0.1
node tools/scale-dataset/generate.mjs --out ./scale-full  --scale 1      # ~20 s, ~2.2 GB
```

Run the small scales first. A failure at 1% costs minutes to find; the same failure
at 100% costs hours.

## What it writes

| File | Rows at 100% | Notes |
|---|---|---|
| `Systems.csv` | 41 | 40 technical connectors + the `Identity Store` |
| `Contexts.csv` | 1,500 | logical applications: `ContextType=LogicalApplication`, `TargetType=Resource`, owner, `CmdbReference` |
| `Resources.csv` | 810,000 | 800,000 entitlements + 10,000 `BusinessRole` roles |
| `ContextMembers.csv` | 800,000 | one per entitlement, `MemberType=Resource` |
| `Users.csv` | 180,000 | principals, 45,000 enabled |
| `Assignments.csv` | 41,000,000 | 40M entitlement + 1M role assignments, ~1.9 GB |
| `manifest.json` | — | parameters, row/byte counts, and the shape statistics of this run |
| `comma-shift-fixture/` | tiny | see [Delimiter](#delimiter) |

Principals, business roles and logical applications live in the `Identity Store`
system; each entitlement lives in one technical connector, and its assignment rows
carry that connector's `SystemName`. No `Identities.csv` / `IdentityMembers.csv`:
this fixture models one principal per person, with no cross-system account
correlation.

Every file streams through a 1 MB buffer; the generator's memory stays flat
(~210 MB RSS at full scale, most of it the per-entitlement plan).

## Shape

Uniform random data at this volume produces query plans nothing like a real
directory's. Each property below is a parameter in [`lib/params.mjs`](lib/params.mjs)
(override with `--set name=value`) and is checked by the tests.

| Property | Parameter (default) | What it produces at 100% |
|---|---|---|
| Assignment skew | `assignmentSkew` (1.0), `holderCapShare` (0.95) | holders of the rank-r entitlement ∝ 1/(r+1)^1.0, capped at 95% of principals, summing exactly to the total: 34 entitlements with six-figure membership, median 8, tail of 4 |
| Role skew | `roleAssignmentSkew` (1.0) | same law over the roles |
| Disabled majority | `enabledShare` (0.25) | exactly 25% of principals enabled |
| Systems spread | `connectorSkew` (1.3) | largest connector ~35% of entitlements, second ~14%, a long tail of small ones |
| Applications span systems | `crossSystemShare` (0.35), `maxSecondaryConnectors` (4) | each application has a home connector plus 0–4 secondaries; most applications hold entitlements from several connectors |
| Application size | `applicationSkew` (1.0) | a few very large applications, many small |
| Commas in values | `directoryConnectorShare` (0.3) | directory-style connectors (always including the largest) emit LDAP distinguished names; every description carries commas too |
| Name near-collisions | `nameCollisionShare` (0.002) | display names that differ from an earlier one only by case or a trailing space, for entitlements and principals |

External ids are opaque (`E-3fa2c91b`, `P-…`, `R-…`, `A-…`, `S-…`) and unique across
every file and every system. That matters: the crawler's deterministic ids are
namespaced per crawler run, not per system, so two systems reusing an id would
collapse into one row.

At small scales the head of the distribution saturates at the holder cap — the
mean holders per entitlement stays ~50 while the principal count shrinks — so the
1% median is ~15 rather than 8. The ratios are the same; the absolute head is not.

`--seed` makes a run reproducible byte for byte. Each file draws from its own
named random stream, so changing one file's logic does not reshuffle the others.

## Loading it

Use the CSV crawler with the delimiter set to a tab (`"delimiter": "\t"` in the
crawler config). The crawler loads the files in its own fixed order. What happened
when the full set was loaded is in
[Scale Rehearsal: 41 M Assignments](../../docs/architecture/scale-rehearsal.md).

## Delimiter

Output defaults to tab-separated: no generated value contains a tab, so nothing is
ever quoted and any reader gets the columns right. `--delimiter comma|semicolon|pipe|<char>`
changes it; values that contain the delimiter are then quoted per RFC 4180.

Every run also writes `comma-shift-fixture/`: a dozen rows, comma-delimited and
correctly quoted, whose values are all distinguished names. A reader that splits on
commas without honouring quotes moves the `SystemName` column into the middle of a
DN, which the crawler's fast path did until #1263. The same files are committed in
[`fixtures/comma-shift/`](fixtures/comma-shift/) as a regression case; a test keeps
them identical to what the generator emits.

## Files

| File | Role |
|---|---|
| `generate.mjs` | command line |
| `lib/params.mjs` | parameters and scaling |
| `lib/random.mjs` | seeded streams, bijective opaque ids |
| `lib/distributions.mjs` | power law, weighted picks, exact selection |
| `lib/plan.mjs` | the per-entitlement / per-principal plan, shape statistics |
| `lib/names.mjs` | invented vocabulary, distinguished names, near-collisions |
| `lib/emit.mjs` | one streaming emitter per file |
| `lib/csvWriter.mjs` | buffered, backpressure-aware writer |

Tests (`*.test.js`) run in the API Vitest suite.

---
type: reference
---

# Analytics Profiles & Power BI — design note

> Status: **proposal + Phase 1 slice** (Feature 2). Written before the code, from an audit of
> `main` at `5.792.20261009.1322`, then stacked on the Core Ontology (Feature 1, PR #1369,
> [core-ontology.md](core-ontology.md)); see [Ontology alignment](#9-ontology-alignment).
>
> Companion code: [`app/api/src/analytics/`](https://github.com/Fortigi/IdentityAtlas/tree/main/app/api/src/analytics),
> [`routes/analytics.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/routes/analytics.js),
> migration `084_analytics_profiles.sql`. End-user procedure: [Power BI analytics](../admin/power-bi-analytics.md).

## 1. What this is for, in one paragraph

A customer wants Power BI reports on identity populations, accounts, assignments and governance,
sliced by **their own** categories (internal/external, N1/N2 tier, department, sector), without
copying 40 million assignments into Power BI. Identity Atlas computes **jointly aggregated** counts
server-side, under definitions it owns; Power BI imports the compact result and only visualises it.
An **Analytics Profile** records which dimensions a customer reports on and which dimension
*combinations* (datasets) are supported. Every response states which history method produced it,
so a chart never claims history that the database does not hold.

## 2. Audit — what exists today

### 2.1 APIs, auth, pagination, read tokens

| Topic | What the code does | Consequence for analytics |
|---|---|---|
| Read tokens | `fgr_…` keys (`auth/readTokens.js`, table `ReadApiKeys`, migration 016). Presented **only** as `Authorization: Bearer fgr_…`. Non-GET → 403; any path under `/api/admin/` → 403. Implicitly hold `data.read` only. 90-day idle auto-revoke (`READ_TOKEN_IDLE_DAYS`). | Dataset retrieval must be **GET outside `/api/admin/`**. The analytics API lives at `/api/analytics/v1/…`. |
| Existing Power Query surface | `routes/bulkLists.js` flat lists (`/api/assignments`, …) paged with `limit`/`offset` (max 10 000); M templates in `export/queryTemplates.js` use `Web.Contents(BaseUrl, [RelativePath, Query, Headers])` + `List.Generate`. The Excel workbook flow mints a token (`routes/dataExport.js`). | Reuse the same M idiom (static base URL + `RelativePath`/`Query`, bearer header) so refresh behaves the same. These endpoints export **rows**, not aggregates — they are what this feature must not make the default. |
| Aggregates | `GET /api/admin/dashboard-stats` (estimates, admin path), `POST /api/matrix/scope-stats|scope-timeseries|scope-breakdown` (POST), report templates, custom reports. | None is reachable by a read token, and none produces a joint multi-dimension table. The **governed** definition of `scope-stats` is reused verbatim (§4.3). |
| Permissions | Catalog in `auth/permissions.js`; `requirePermission()` per route; guard in `auth/permissionManifest.js`. | New permission `admin.analytics` gates profile writes (Admin has it through `*`). Reads take `data.read` (token-compatible). |
| Feature flags | `featureFlags.js` + `requireFeature()` → 404 when off. | New flag `analytics`, **off by default**. |
| Versioning / pagination / caching | No `/v1` anywhere; `{ data, total }` with `limit`/`offset`; no ETag/Cache-Control. | `/api/analytics/v1` is the first versioned surface. Datasets are bounded by contract (rejected, never truncated — principle B2), so no paging in Phase 1. |
| Tenancy | One database per installation; no tenant column. `Systems.tenantId` is the *source* tenant. | Profiles are **installation-scoped**. A profile may narrow its *source scope* to a set of systems. |
| Audit of actions | No generic audit helper; `AuthRoleChangeLog` pattern, `createdBy`/`updatedBy` + `_history`. | Profiles get an append-only `AnalyticsProfileVersions` table (never pruned). Dataset pulls are logged to the server log (see open decisions). |

### 2.2 History, soft delete, import runs

| Mechanism | Fact (source) |
|---|---|
| `_history` | Trigger `fg_record_history()` (009, rewritten 071) writes a **full-row** JSONB snapshot per INSERT/UPDATE/DELETE: `rowData` (after; the old row for D) and `prevData` (before; NULL for I). Only `photo` is stripped. |
| Audited tables | Principals, Resources, ResourceAssignments, ResourceRelationships, Systems, AssignmentPolicies, GovernanceCatalogs (009); IdentityMembers (022); Contexts (018); SavedMatrixFilters (069). |
| **Not audited** | **Identities**, **ContextMembers**, PrincipalActivity, RiskScores, CertificationDecisions, AssignmentRequests, PrincipalRelationships. |
| Retention | `HISTORY_RETENTION_DAYS` (WorkerConfig, default **180**, 0 = keep forever); pruned every 6 h. Tombstones are purged on the same window. |
| Initial loads (073) | A system's *first* sync writes **no** per-row insert events; one anchor row per (table, system), `rowId = 'initial-load:<systemId>'`, marks when its rows arrived. Updates and deletes are always recorded. |
| Soft delete (040) | `deletedAt` on Principals, Resources, ResourceAssignments only; recorded in `_history` as an **U** row. Every other table hard-deletes. |
| Bulk rewrites | Migrations 045, 049, 052/058, 070, 074 rewrote rows and left `U` events stamped with the migration time; pre-052 snapshots carry old `resourceType` names. |
| Import runs | No per-row run id, no firstSeen/lastSeen. `GraphSyncLog` (per batch), `CrawlerJobs`, `Systems.lastSyncDateTime` (overwritten), `updatedAt` = "last ingested" (072, backfilled). No created-at on Principals/Resources/RA; source timestamps `createdDateTime` exist on Principals/Resources. |
| Snapshots | `DashboardSnapshots` (027): one installation-wide row per day since that migration, no breakdown. Most columns are `reltuples` **estimates that include tombstones**; `governedAssignments` is an exact count of `governed = true` rows **without a `deletedAt` filter**. (`dashboard-trends.md` still says it counts `assignmentType='Governed'`; the code changed in 049.) |
| Existing as-of code | `matrix/scopeHistory.js` reconstructs state at instant D as *prevData of the first event after D* ∪ *live rows with no event after D*. |

**Defects found in existing as-of code (reported, not fixed on this branch — one issue per branch):**

1. `scopeHistory.js` never checks `deletedAt`, so a tombstoned principal/resource/assignment counts as alive in both branches of the reconstruction — the timeline disagrees with live scope-stats, which reads the matview that does filter tombstones.
2. The ResourceAssignments history key (`resourceId|principalId|assignmentType`) omits `governed` and `identityId`; since 047 two rows (governed and actual) can share one key, so `ROW_NUMBER() … rn = 1` keeps only one of them, and identity-held assignments get a malformed key.
3. `historyStart` is the first event of *any* system; rows of a system loaded later count as present before they were loaded.
4. `DashboardSnapshots` trend mixes an estimate denominator (incl. tombstones) with an exact numerator (incl. tombstones) and a different governed definition than scope-stats.

### 2.3 What "as of" can truthfully answer

Reconstruction from `_history` is exact for an **audited** table at an instant D when D ≥ the oldest
retained event of that table (pruning removes whole prefixes, so everything after the oldest retained
event is complete), **and** the row's system had been loaded by D (its anchor, if any, precedes D).

| Metric | Live (now) | Past instant, method | Notes |
|---|---|---|---|
| Principal count (stock) by **Principal** attributes (enabled, type, department, company, any `extendedAttributes` key, system) | accurate | **reconstructed** — Phase 1 | Full-row snapshots keep historic attribute values. Exclude tombstones (`state->>'deletedAt'`) and systems not yet loaded. Bounded by retention. |
| Principal count by **Identity** attributes | accurate | **unavailable** (or *current-attribute*, explicitly labelled) | Identities not audited; IdentityMembers is, but identity attributes are not. Phase 1 rejects this combination with an explanation. |
| Identity count (stock) | accurate | **unavailable** | Identities hard-delete and are not audited. A **forward snapshot** is the only truthful route. |
| Resource count by type/system/attributes | accurate | reconstructable (same method as principals) | Not built in Phase 1. |
| Assignment count by Direct/Indirect/Eligible | accurate | reconstructable **with caveats** — governed/actual key collision (defect 2) and pre-022 gap | Fix the key before relying on it. |
| Governed share (pairs covered by a held business role) | accurate (matview) | reconstructed by `scopeHistory.js`, **not trustworthy** until defects 1–2 are fixed | Phase 1 serves the live value only. |
| Created / removed events (principals) | n/a | events from `_history` `I` and `U deletedAt NULL→ts` **only after a system's initial load** | Initial-load rows have no creation event by design (073); `createdDateTime` is the source's own creation time and is the honest "joiner" measure where present. Net movement ≠ events (re-activations, purges). Phase 2. |
| Enabled → disabled transitions | n/a | event-reconstructable (`accountEnabled` in snapshots) | Phase 2. |
| Context-membership based dimensions | accurate | **current-attribute only** | ContextMembers not audited. |
| Anything before `historyStart` or older than the retention window | — | **unavailable** | Never back-filled; a longer window must be configured *before* the period. |

**Forward-snapshot proposal (Phase 3, not built):** a nightly `AnalyticsSnapshots` writer that stores
each *active profile's* snapshot datasets (already joint and bounded) per day, keyed by profile
version. It is the only truthful path to identity stock history and to history older than the
retention window, and it makes large-tenant refreshes cheap (Power BI reads the stored rows).

### 2.4 Cardinality and volumes

- Dimension values are checked at **profile save time**: every text/discovered field is measured with
  `COUNT(DISTINCT …)` over the profile's source scope; above `MAX_DIMENSION_VALUES` (200) it is
  rejected with the measured number. Booleans/closed enums are bounded by definition. Identifiers,
  names, e-mail, free text (`description`, `jobTitle`) are **not reportable** at all.
- Drift after save (a department attribute that becomes free text) is caught at **query time**: a
  dataset whose result exceeds `maxRows` returns `422 dataset_too_large`, never a truncated table.
- Volumes (from [scale-rehearsal.md](scale-rehearsal.md), 41 M assignments): the governed-pair
  aggregation that `scope-stats` runs takes **48.8 s**; the analytics governed-share dataset runs the
  same pair aggregation plus dimension joins, so expect the same order. **Not measured on this branch**
  (no Docker/PostgreSQL on the build machine) — see blockers. Principal-grain datasets are bounded by
  the principal count (≈200 k at the largest customer), not by assignments.

## 3. Source-to-metric inventory

| Metric (catalog id) | Kind | Source | Grain (one counted unit) | Denominator / measure | Deleted rows | Status |
|---|---|---|---|---|---|---|
| `principals.count` | snapshot | `Principals` ⟕ `IdentityMembers` ⟕ `Identities` | one live account (`deletedAt IS NULL`, not a group principal) | count of accounts | excluded | **Phase 1** |
| `identities.count` | snapshot | `Identities` ⟕ `IdentityMembers` ⟕ `Principals` | one identity with ≥ 1 live linked account | count of identities; identities without a live account reported as `excluded` | excluded via accounts | **Phase 1** |
| `assignments.governedShare` | snapshot | `vw_ResourceUserPermissionAssignments` ⟕ `vw_UserPermissionAssignmentViaBusinessRole` | one distinct (account, resource) pair | `pairs` (denominator), `governedPairs` (numerator), `ungovernedPairs`, `governedShare = governedPairs / pairs`, `holders` | excluded by the matviews | **Phase 1** |
| `principals.countAsOf` | snapshot, historical | `_history` (Principals) ∪ `Principals` | one account alive at period end | count of accounts | excluded (`state->>'deletedAt'`) | **Phase 1** |
| `principals.created` / `.removed` | event | `_history` | one event | count of events | n/a | Phase 2 |
| `resources.count` / `.countAsOf` | snapshot | `Resources` / `_history` | one live resource | count | excluded | Phase 2 |
| `assignments.count` by type | snapshot | `ResourceAssignments` | one (account, resource, type) row | count | excluded | Phase 2 |
| Data quality (orphan accounts, unknown share) | snapshot | `accountlinking/orphanQuery.js` | one account | count | excluded | Phase 3 |

## 4. Metric catalog — exact definitions (Phase 1)

All counts are integers. All instants are **UTC**; `periodEnd` is the last millisecond of the
period in UTC. A dimension value that is NULL or blank after `btrim` is reported as the profile's
unknown label (default `(unknown)`). Every dimension column is text (`true`/`false` for booleans).

### 4.1 `principals.count` (v1)

- **Grain:** a row in `Principals` with `deletedAt IS NULL` and `principalType` ≠ `#microsoft.graph.group`
  (a group is a container, not an account — `lib/principalTypes.js`), within the profile's source scope.
- **Value:** number of such accounts in the cell.
- **Identity dimensions** join through `IdentityMembers`. An account linked to **no** identity gets
  `(not linked)`; an account linked to **more than one** identity (the schema allows it — there is no
  unique index on `IdentityMembers.principalId`) gets `(multiple identities)`. An account is therefore
  counted **exactly once** per dataset, so cells always sum to the total.
- **History method:** `current` (live tables).

### 4.2 `identities.count` (v1)

- **Grain:** a row in `Identities` with at least one linked account that is live under §4.1
  (in source scope). Identities with no live account are not counted and are reported as
  `excluded.identitiesWithoutLiveAccount`.
- **Value:** number of identities. An identity with three accounts counts **once**.
- **Allowed dimensions:** Identity fields only. Account-level dimensions are rejected: an identity
  with an enabled and a disabled account would have to be counted in two cells (double counting) or
  in one arbitrary cell (an invented rule). Use `principals.count` with Identity dimensions instead.
- **History method:** `current`.

### 4.3 `assignments.governedShare` (v1)

Same definition as `POST /api/matrix/scope-stats` so the two surfaces agree:

- **Grain:** a distinct `(principalId, resourceId)` pair in `vw_ResourceUserPermissionAssignments`
  (which already excludes tombstoned assignments, holders and targets), whose holder is a live
  non-group account in source scope and whose resource type is visible by default
  (`lib/resourceVisibility.js`: `BusinessRole` rows are excluded — holding the role is the
  *governance* fact, its contained resources are the access).
- **Numerator `governedPairs`:** pairs present in `vw_UserPermissionAssignmentViaBusinessRole`
  (covered by a business role / access package the account holds).
- **Denominator `pairs`:** all pairs in the cell. `ungovernedPairs = pairs − governedPairs`.
  `governedShare = governedPairs / pairs`, NULL when `pairs = 0`. There is no unknown governed state in
  this definition (coverage is decidable); `unknown` is reported as `0` explicitly.
- **Excluded (reported in the response, not hidden):** pairs on `BusinessRole` resources, pairs held by
  group principals.
- **Ownership** rows (`GroupOwnership`, …) are counted as ungoverned access, as the matrix does
  (`docs/architecture/matrix-scope-statistics.md`). Open decision.
- **Freshness:** the matviews are refreshed after each sync; the refresh instant is **not recorded**
  anywhere, so freshness is reported as the latest `Systems.lastSyncDateTime` in scope.
- **History method:** `current`.

### 4.4 `principals.countAsOf` (v1)

- **Grain:** an account alive at the period end D: reconstructed via the `scopeHistory.js` as-of CTE,
  **plus** `state->>'deletedAt' IS NULL`, **plus** the account's system had been loaded by D (no
  `initial-load:<systemId>` anchor after D), plus the §4.1 group exclusion and source scope.
- **Periods:** calendar months, `periods` ≤ 12, ending with the current (incomplete) month whose
  instant is *now* (`periodComplete: false`).
- **Allowed dimensions:** Principal fields only (columns and `extendedAttributes` keys are in the
  snapshot). Identity fields → rejected (not audited).
- **Coverage:** a period whose end precedes `historyStart` (oldest retained Principals event) is
  **not returned as a number**: it is listed in `coverage.unavailablePeriods`. Each returned row
  carries `historyMethod: "reconstructed"` (or `"current"` for the running month).
- **System label:** the system *name* is today's name for the historic `systemId` (renames are not
  history).

## 5. Analytics Profiles

```jsonc
{
  "name": "Workforce overview",
  "status": "active",                  // active | retired
  "scope": { "systemIds": [1, 4] },    // optional; default = every system
  "dimensions": [                      // the reporting dimensions this customer selected (≤ 8)
    { "field": "Principal.accountEnabled", "label": "Account status" },
    { "field": "Identity.department" },
    { "field": "Principal.ext.employeeCategory", "label": "Internal / external" }
  ],
  "datasets": [                        // the SUPPORTED combinations (≤ 10, ≤ 4 dimensions each)
    { "id": "accounts", "metric": "principals.count",
      "dimensions": ["Principal.accountEnabled", "Principal.ext.employeeCategory", "Identity.department"] },
    { "id": "governance", "metric": "assignments.governedShare", "dimensions": ["Identity.department"] },
    { "id": "accounts-trend", "metric": "principals.countAsOf",
      "dimensions": ["Principal.accountEnabled"], "periods": 6 }
  ],
  "privacy": { "minGroupSize": 5 },    // 1–100, default 5
  "limits": { "maxRows": 10000 }       // ≤ 50 000
}
```

- **Whitelist only.** A dimension is a semantic field id from the registry (`analytics/fields.js`):
  core fields, or `<Entity>.ext.<key>` for an `extendedAttributes` key that the existing discovery
  (`db/columnCache.js discoverExtendedAttrKeys`, 300-key cap) has seen, key `[A-Za-z0-9_]+`. No SQL,
  no JSON paths. Dataset dimensions must be a subset of the profile's dimensions.
- **Joint, not marginal.** A dataset is one `GROUP BY` over all of its dimensions at once. The
  supported combinations are exactly the datasets; Power BI can filter within a dataset, never join
  two datasets' cells.
- **Versioning.** Every save increments `version` and appends the full definition to
  `AnalyticsProfileVersions` (never pruned). Updates carry `expectedVersion`; a stale write → 409.
  Delete = `status: retired` (a new version), so the trail is never lost. Every dataset response names
  the profile version and the metric version it was computed with.
- **Suppression.** A cell whose population (accounts for principal metrics, identities for identity
  metrics, distinct holders for governed share) is between 1 and `minGroupSize − 1` returns its
  measures as `null` with `suppressed: true`. Zero cells are never emitted.

## 6. API (`/api/analytics/v1`, feature flag `analytics`)

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /catalog` | `data.read` | Entities, fields (id, IRI, label, type, reportable/why not, history support), metrics. |
| `GET /profiles`, `GET /profiles/:id`, `GET /profiles/:id/versions` | `data.read` | Read profiles and their version trail. |
| `POST /profiles/validate` | `admin.analytics` | Validate + measure cardinality + estimated row bound, without saving (impact preview). |
| `POST /profiles`, `PUT /profiles/:id`, `DELETE /profiles/:id` | `admin.analytics` | Create, update (`expectedVersion`), retire. |
| `GET /profiles/:id/datasets/:datasetId` | `data.read` | The joint aggregate rows + coverage, suppression and freshness. |
| `GET /profiles/:id/metadata` | `data.read` | Versions, metric definitions, history methods, supported combinations, limitations, freshness. |

All GETs work with an `fgr_` read token. Errors are `{ error, code, details? }` with
`400 invalid_profile`, `404 not_found`, `409 version_conflict|name_taken|profile_retired|profile_outdated`,
`422 dataset_too_large`. Every dataset query runs in a transaction with `statement_timeout` (120 s).
Each dataset pull is logged (who or which read token, profile, version, row count) to the server log.

### Verification on this branch

- **Unit tests** (`src/analytics/*.test.js`, `routes/analytics.test.js`): validation boundaries,
  suppression at k−1/k, the row guard at maxRows/maxRows+1, period arithmetic, version conflicts,
  feature/permission gates.
- **Contract test** (`contract-tests/analyticsDatasets.contract.test.js`), run in CI against
  PostgreSQL 16 and locally against PGlite: two populations with identical marginals and opposite
  joints; an identity with three accounts counted once (and an account in two identities bucketed);
  tombstones, group principals and business-role rows excluded; blank/NULL → unknown; 201-value
  attribute refused; empty scope returns no rows; history moved by an attribute change, a soft delete
  and a system loaded later. Each of those rules was removed in turn and the suite failed each time.
- **Indicative timings** (PGlite — single-threaded WebAssembly, *not* representative of a PostgreSQL
  server): 50 000 accounts / 500 000 assignments — 4-dimension joint account dataset 0.23 s (534 cells,
  91 KB), identities 0.27 s, governed share by 2 dimensions 3.6 s (266 cells), reconstructed trend
  1.3 s. The 41 M-assignment rehearsal is still to be done (blocker 2).

## 7. Power BI — authentication and refresh (from documentation; **unverified here**)

No Power BI Desktop or Service was available while building this. Everything in this section is from
Microsoft documentation and field experience and **must be tested before it is promised**.

| Option | Desktop | Service (scheduled refresh) | Trade-off |
|---|---|---|---|
| **A. Anonymous + `Authorization: Bearer fgr_…` header** built in M from a parameter (what the Excel workbook does) | works | Expected to work when the data source URL is **static** (`Web.Contents(BaseUrl, [RelativePath=…, Query=…])`) and the credential is set to *Anonymous*; "Skip test connection" is usually required because the test call does not send the header | The token is a dataset parameter — visible to anyone who can edit the semantic model. Revocable and read-only, idle-revoked after 90 days of non-use. **Phase 1 default.** |
| **B. "Web API" credential + `ApiKeyName`** (key stored as a Power BI credential, not in the model) | works | supported credential type | Power BI sends the key as a **query-string parameter**; Identity Atlas accepts tokens only in the `Authorization` header. Would need a new, opt-in query-param token mode (tokens in URLs end up in proxy logs). Open decision. |
| **C. Organizational account (Entra ID OAuth)** | works when the API accepts the token audience Power BI requests | potentially the cleanest (no shared secret) | Needs the API's app registration to accept Power BI's token for the resource URL; untested. Phase 2 spike. |
| Gateway | not needed | **Not needed** for a publicly reachable HTTPS URL; an on-premises data gateway is needed when Identity Atlas is only reachable on a private network (typical for the portable/laptop install) | Licensing: sharing and scheduled refresh need Pro/PPU or capacity; Pro allows 8 refreshes/day. |
| POST bodies | — | `Web.Contents` with `Content` is restricted to anonymous auth in the Service | Every dataset is a **GET**. |

**Template.** A `.pbit` or PBIP/TMDL project cannot be produced or verified without Power BI Desktop,
and a hand-made `.pbit` is explicitly out of bounds. Phase 1 ships a Power Query M file
([`docs/admin/power-bi/IdentityAtlasAnalytics.pq`](../admin/power-bi/IdentityAtlasAnalytics.pq))
and a documented Desktop procedure. Producing the PBIP project in Git (Desktop → *Save as* →
Power BI Project, which is the supported Git format) and exporting the `.pbit` from it is a manual
step for someone with Desktop — see blockers.

## 8. Blockers

1. **No Power BI Desktop/Service** on the build machine: no verified `.pbit`/PBIP, no Service refresh
   test (acceptance criteria 12–13 open).
2. **No Docker/PostgreSQL** locally: the contract tests run in CI only; the SQL was additionally
   exercised locally against PGlite (WebAssembly PostgreSQL 16, the portable runtime). No
   large-volume timings (criterion 14 open); the 41 M rehearsal rig (sidekick-6) is the place.
3. **Defects in existing history code** (§2.2) block a trustworthy *historic* governed share.
4. **Feature 1 ontology** (#1369) is not merged yet; this branch is stacked on it (§9).

## 9. Ontology alignment

Field ids are `Entity.property` (e.g. `Principal.accountEnabled`) and map to IRIs of the core
ontology (`ontology/core.ttl`, namespace `https://identityatlas.io/ontology#`) through **one**
table, `analytics/ontologyTerms.js`, following the core conventions:

| Analytics | Core ontology |
|---|---|
| `Principal.accountEnabled`, `Identity.department`, … (a column) | the property named as the column: `ia:accountEnabled`, `ia:department` (shared by every table that has the column; its `rdfs:domain` lists them) |
| `Principal.system`, `Resource.system` (reported as the system's name) | the foreign key `ia:systemId`, an object property ranging over `ia:System` |
| entities `Principal`, `Identity`, `Resource`, `System`, `Assignment` | classes `ia:Principal`, `ia:Identity`, `ia:Resource`, `ia:System`, `ia:ResourceAssignment` |
| the type values the queries branch on (`BusinessRole`, …) | typed subclasses (`ia:BusinessRole`, `ia:typeValue "BusinessRole"`) or value-list individuals |
| `<Entity>.ext.<key>` | **no core IRI** — extended attributes are per-install vocabulary and stay outside the core ontology by design |

`analytics/ontologyTerms.test.js` loads `core.ttl` through the ontology module (`ontology/cli.js
loadOntology`, N3.js) — no second parser — and fails when a catalog field names a property that is
not defined, or one whose domain does not include the field's class (e.g. `Identity.accountEnabled`:
`ia:accountEnabled` exists, but only on `ia:Principal` and `ia:IdentityMember`), or when a type value
the queries depend on is not declared.

**One inconsistency found:** every account count excludes principals of type
`#microsoft.graph.group` (`lib/principalTypes.js`, used app-wide), but the ontology closes
`ia:Principal`'s `principalType` list to the ingest `PRINCIPAL_TYPES`, which do not include it.
Either such rows cannot arrive (and the exclusion is dead code everywhere) or the closed list is
incomplete. The test records it as a known gap (a ratchet: it fails once the ontology declares the
value); the fix belongs in the ontology/ingest, not here. Customer selections never go into the core
ontology.
## 10. Staged plan

| Phase | Content | State |
|---|---|---|
| 0 | This audit, coverage matrix, metric catalog | done (this page) |
| 1 | Profiles (store, versions, validation, cardinality), catalog, 3 current metrics + 1 reconstructed historic metric, bounded joint aggregator with suppression, `/api/analytics/v1`, M sample + Desktop procedure, flag off | **this PR** |
| 1b | Fix `scopeHistory.js` tombstone + assignment-key defects (separate bugfix PR) | proposed |
| 2 | PBIP project + verified `.pbit` (needs Desktop), Service refresh test for options A/B/C, event metrics (created/removed/disabled), `resources.*`, `assignments.count` | proposed |
| 3 | Forward `AnalyticsSnapshots` writer per active profile (identity history, beyond retention, cheap large-tenant refresh), data-quality page, ETag/conditional refresh | proposed |
| 4 | Cross-tenant/security tests, complementary suppression against differencing, scale tests on the 41 M rig, upgrade compatibility | proposed |

## 11. Open decisions (for Wim)

1. Permission: a new `admin.analytics` (chosen) vs reusing `data.write.reports`.
2. Governed share: count ownership pairs as ungoverned access (chosen, = matrix) or exclude them.
3. Power BI Service auth: stay with option A, add an opt-in query-param token (B), or invest in Entra (C).
4. Minimum group size default 5 and floor 1 — or a floor of 3+ that admins cannot lower.
5. Differencing protection beyond per-cell suppression (complementary suppression, rounding).
6. Should dataset pulls be audited in a table (who/which token/when) rather than the server log?
7. Migration number 084 collides with `feature/org-truth-mvp` (084–088); renumber whichever merges second.

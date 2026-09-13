# SCIM 2.0 Crawler — Developer Guide

Generic connector for any SCIM 2.0 service provider (RFC 7643/7644). Nothing in
here is vendor-specific: the endpoint's own `/ServiceProviderConfig`,
`/ResourceTypes` and `/Schemas` drive the wizard, and only the standard `/Users`
and `/Groups` collections are read.

User-facing docs: [`docs/sync/scim.md`](../../../docs/sync/scim.md).

## Files

| File | Role |
|---|---|
| `crawler.json` | Manifest: type `scim`, `entryPoint`, no `dependsOn`, no `postSyncHooks`, full `configSchema` (auth matrix via `allOf`/`if`-`then`) |
| `Start-ScimCrawler.ps1` | Thin entry point. Fixed params `ApiBaseUrl`, `ApiKey`, `JobId`, `ConfigPath`; connects, registers the system, runs three phases, finalises |
| `ScimCrawler.Functions.ps1` | REST client (`Connect-ScimAPI`, `Invoke-ScimRequest`, `Invoke-ScimSearchStream`), the pure paging helpers (`Get-ScimPageUrl`, `Get-ScimPageState`), config resolution (`ConvertFrom-ScimConfigMap`) and the bucketed ingest writer |
| `ScimCrawler.Transform.ps1` | Pure record-shapers + membership classification + nested-group expansion. No I/O, no script scope |
| `ScimCrawler.Phases.ps1` | One `Sync-Scim*` per phase; reads through `Invoke-ScimSearchStream`, writes through the ingest writer, records failures via `Add-ScimPhaseError` |
| `discover.js` | Live discovery for the wizard: resource types + per-object attribute lists, and the credential check |
| `ConfigWizard.jsx` | Six-step wizard. Pure logic (`toggleAttribute`, `toggleAllAttributes`, `canSubmitObjects`, `buildScimConfig`) is exported for direct unit tests |
| `Summary.jsx` | Config-card panel: endpoint, auth, system name, page size, objects, attribute counts |
| `Test-ScimCrawler.ps1` | CI integration test against the mock server, through the full dispatch pipeline |
| `../shared/Start-MockScimServer.ps1` | Mock SCIM 2.0 server with real `startIndex`/`count` paging, request recording and in-place data swapping |

Unit tests: `test/unit/ScimCrawlerTransform.Tests.ps1`, `ScimCrawlerFunctions.Tests.ps1`,
`ScimCrawlerPhases.Tests.ps1`. JS/UI tests: `configValidation.test.js`,
`discover.test.js` (API vitest), `ConfigWizard.test.jsx`, `wizardLogic.test.js`
(UI vitest), `ConfigWizard.e2e.mjs` (Playwright, via the generic loader).

## Sync phases (in order)

1. **System** — one Identity Atlas system per endpoint, keyed on `systemType='SCIM'`
   + `tenantId=<baseUrl>`. Written in delta mode (Systems is cross-system — a full
   sync there would delete other sources' rows).
2. **Users** — `/Users` streamed page by page → `Principals`.
3. **Groups** — `/Groups` streamed page by page → `Resources` (`resourceType='Group'`).
   The `members` arrays are retained.
4. **Group members** — user members → `Direct` assignments; nested groups →
   `Contains` relationships **and** expanded per-user `Indirect` assignments.

## Things that will bite you

**The system is keyed on the base URL.** `tenantId = baseUrl`, so pointing an
existing config at a different host (or, in a test, restarting the mock on a new
port) creates a *second* system rather than updating the first. That is why
`Start-MockScimServer` has a `/__mock/state` control endpoint and
`Set-MockScimData`: a reconcile test swaps the served data in place instead of
restarting on a new port.

**Deterministic ids are mandatory here.** A SCIM `id` is an arbitrary string, but
the ingest schema wants a UUID primary key. Every batch therefore goes out with
`idGeneration='deterministic'` and `idPrefix='scim-sys<systemId>'`; the ingest layer
derives the UUID from `"<idPrefix>-<entity>:<externalId>"` and resolves
`resourceExternalId` / `principalExternalId` into the same namespace. Drop the
prefix and the foreign keys silently stop lining up.

**Principals are bucketed by `principalType`.** The full-sync scoped delete keys on
`systemId` *plus* the scope columns, and `principalType` is a scope column for
principals. Sending one mixed batch scoped to a single type would make that batch's
reconcile delete every principal of the other types. `Complete-ScimIngestWriter`
therefore flushes one batch per bucket — **including an empty batch for every
declared bucket that produced nothing**, which is the only thing that lets a type
that lost its last account have its stale rows removed.

**Empty batches are load-bearing.** `Send-ScimBatch` deliberately does *not* pass
`-SkipWhenEmpty`: an emptied source must clear its rows, not silently keep them.

**`@($null)` has one element.** `@($raw['userTypeMapping'])` on a missing key yields
a one-element array containing `$null`, so "no mapping configured" looked like one
empty rule and the catch-all default was never applied. `ConvertFrom-ScimConfigMap`
filters nulls out explicitly — the same trap applies to any config list here.

**A single-element array unwraps on return.** `ConvertTo-ScimNestedGroupIndirectAssignments`
returns `,@($out)` (leading comma). Without it, a one-row result comes back as the
bare hashtable and every `.Count` / `[0]` on it reads the record's *key count*.

**`type` on a group member is optional.** RFC 7643 §4.2 makes the `type`/`$ref`
hints optional and providers get them wrong, so `Resolve-ScimMemberKind` classifies
by matching the member id against the user/group id-sets this run actually fetched.
`type` is consulted only to break a tie when an id is in both sets. An id in
neither is counted and logged, never silently dropped.

**Paging terminates on three conditions.** `Get-ScimPageState` stops on an empty
page, on a short page, and when `startIndex + returned` passes `totalResults` — the
last one stops a compliant provider being asked for a pointless empty page when the
result count is an exact multiple of the page size.

**No delta.** SCIM has no standard change feed. A `_syncMode='delta'` request runs a
full sync and logs that it did; do not add a `filter`-based watermark without
checking `/ServiceProviderConfig`'s `filter.supported` first.

## Adding a new object type

Users and Groups are the v1 scope. Adding another SCIM resource type means deciding
what it *becomes* in the universal data model first (a `Resource` of which
`resourceType`? a Context?) — that is a data-model decision, not a connector
detail. Once decided: add a phase in `ScimCrawler.Phases.ps1`, shapers in
`ScimCrawler.Transform.ps1`, a toggle in `crawler.json`'s `selectedObjects`, and
flip `syncable` for it in `discover.js`'s `SYNCABLE_RESOURCE_TYPES`.

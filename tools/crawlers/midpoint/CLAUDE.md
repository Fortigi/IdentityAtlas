# midPoint Crawler — Developer Guide

## Architecture

A crawler is a folder under `tools/crawlers/<type>/` with a `crawler.json` manifest and an entry point. The dispatcher (`setup/docker/Invoke-CrawlerJob.ps1`) reads the manifest registry, resolves `dependsOn` (DFS, topological sort), and runs the entry point. The scheduler (`setup/docker/scheduler.ps1`) claims queued jobs via `POST /api/crawlers/jobs/claim`. See `docs/architecture/crawler-architecture.md`.

## Files

| File | Role |
|---|---|
| `crawler.json` | Manifest: type `midpoint`, `entryPoint`, no `dependsOn`, `postSyncHooks: ["buildContexts"]`, full `configSchema` |
| `Start-MidpointCrawler.ps1` | Entry point. Fixed params: `ApiBaseUrl`, `ApiKey`, `JobId`, `ConfigPath`. Runs all sync phases, safe-scoped per `systemId`, emits a performance summary (wall-clock + per-read + per-ingest-endpoint) |
| `Invoke-MidpointApi.ps1` | REST client: `Connect-MidpointAPI` (BasicAuth/ApiToken/OAuth2CC/OAuth2ROPC), `Invoke-MidpointSearch` (paged), `Invoke-MidpointSearchStream` (paged, per-page callback — no accumulation in memory), `Invoke-MidpointGet`, and helpers (`Get-MidpointRefOid/Type/Relation`, `Get-MidpointString` (PolyString/multi-value), `Get-MidpointAttrValue`, `Test-MidpointEnabled`, `Convert-MidpointOutcome`, `New-StableGuid`, `Format-AccountLabel`) |
| `Seed-MidpointTestData.ps1` | Idempotent functional fixture seeder with fixed OIDs (`New-/Remove-MidpointTestData`, `Get-MidpointFixtureSpec`). Covers every type/phase/relationship for the CI proof cycle |
| `Test-MidpointCrawler.ps1` | CI integration test: starts a mock midPoint server, runs a job through the full dispatch pipeline, asserts on the DB |
| `../shared/Invoke-CrawlerIngest.ps1` | Shared ingest helpers (`Invoke-IngestAPI`, `Update-CrawlerProgress`, `ConvertTo-JsonArray`) |
| `../shared/Start-MockMidpointServer.ps1` | Mock REST server used by the CI integration test |
| `test/unit/Midpoint.Tests.ps1` | Pester unit tests (helpers + fixture spec + load distribution + file structure) |

## Data-Model Mapping

| midPoint | → Identity Atlas | Notes |
|---|---|---|
| `ResourceType` | **Systems** | Only resources with account/entitlement shadows |
| `OrgType` | **Contexts** (`contextType=OrgUnit`) | Hierarchy via `parentOrgRef`, topo-sorted |
| `RoleType` | **Resources** (`resourceType=BusinessRole`) | `inducement[]` → `ResourceRelationships` (`Contains`) |
| `ServiceType` | **Resources** (`resourceType=Service`) | |
| `UserType` | **Identities** + focus **Principal** + **IdentityMembers** | One Principal per user (the midPoint focus account) |
| `ShadowType kind=account` | **Principals** | Linked to the identity via `user.linkRef` |
| `ShadowType kind=entitlement` | **Resources** (`resourceType=Entitlement`) | e.g. AD groups |
| `ShadowType kind=generic`/other | **Skipped** | OU/container/DB rows — no user account |
| Account → entitlement membership | **ResourceAssignments** (`assignmentType=Direct`) | Via `association[]` or (4.9+) `referenceAttributes.<name>[]`, consolidated on the owner focus principal, `viaAccount` in `extendedAttributes` |
| `user.assignment[]` → Role/Service | **ResourceAssignments** (`assignmentType=Governed`) | |
| `user.parentOrgRef[]` | **ContextMembers** | |
| `accessCertificationCampaigns` | **CertificationDecisions** | Requires `?include=case` |

midPoint OIDs are UUIDs and are reused 1-to-1 as `id`/`externalId` — every record is traceable to the source object.

## Sync Phases (in order)

1. **Systems** — `ResourceType` (+ midPoint itself)
2. **Orgs** — `OrgType` → Contexts
3. **Roles + Services** — `RoleType` + `ServiceType` → Resources
4. **Users** — `UserType` → Identities + focus Principals + IdentityMembers
5. **Shadows** — `ShadowType` → account Principals + entitlement Resources + memberships (ResourceAssignments `Direct`)
6. **Org membership** — `user.parentOrgRef[]` → ContextMembers
7. **Assignments** — `user.assignment[]` → ResourceAssignments `Governed`
8. **Role nesting** — `RoleType.inducement[]` → ResourceRelationships `Contains`
9. **Reviews** — certification campaigns → CertificationDecisions
10. **`refresh-views`** — refreshes matrix materialized views

Each phase is safe-scoped by `systemId`: full-sync deletes only rows the crawler owns.

## Known Gotchas

**AD group memberships (midPoint 4.9+):** 4.9 stores account→group relationships as `shadow.referenceAttributes.group[]` (direct refs), not the legacy `association[]`. The crawler reads both forms. Shadow search requires `?options=raw`; `include=association` returns both as well.

**`Invoke-MidpointSearchStream` vs `Invoke-MidpointSearch`:** Use `SearchStream` for large result sets (Shadows phase). It invokes a per-page callback and never accumulates the full result in memory. `Search` accumulates — fine for small types (Roles, Orgs), but will OOM on 300k+ shadows.

**`New-StableGuid`:** Used to derive stable UUIDs for synthetic records (e.g. the midPoint-itself system). Same input always produces the same UUID — safe for idempotent re-runs.

**`postSyncHooks: ["buildContexts"]`:** Triggers `POST /api/ingest/refresh-contexts` after the sync. This endpoint may return 404 on some versions (non-critical — job still succeeds, context refresh happens on the next scheduled run).

**`CRAWLER_MANIFESTS_DIR` on the web container:** Must be set for the midPoint crawler to appear in "Add Crawler" in the UI. The worker dispatcher reads the manifest directly from the image; the web container needs the env var to discover it.

**Streaming memory:** `Invoke-MidpointSearchStream` bounds the managed heap, but docker-stats RSS stays ~6 GiB due to native/JSON-parsing memory. To reduce this further, look into streaming JSON deserialization or a smaller `pageSize`.

## Running the Functional Fixtures (CI proof cycle)
```powershell
. .\Seed-MidpointTestData.ps1
New-MidpointTestData -BaseUrl <midpoint-url> -Username administrator -Password <pw>
Remove-MidpointTestData -BaseUrl <midpoint-url> -Username administrator -Password <pw>
```

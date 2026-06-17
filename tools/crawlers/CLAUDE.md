# Crawler Development — Quick Reference

Full authoring guide: [`docs/sync/custom-crawlers.md`](../../docs/sync/custom-crawlers.md)
Architecture internals: [`docs/architecture/crawler-architecture.md`](../../docs/architecture/crawler-architecture.md)

## Adding a Crawler

Drop a folder into `tools/crawlers/<type>/` with `crawler.json` + entry point. No changes to `Invoke-CrawlerJob.ps1`, `IdentityAtlas.psm1`, or `pr.yml` needed. Restart the worker to pick it up.

## Folder conventions

```
tools/crawlers/<type>/
├── crawler.json                ← required manifest
├── Start-<Type>Crawler.ps1     ← entry point
├── CLAUDE.md                   ← developer guide (architecture, data-model mapping, gotchas)
├── Test-<Type>Crawler.ps1      ← CI integration test
└── dev/                        ← development tools (not shipped, not loaded by dispatcher)
    ├── README.md               ← run instructions and cleanup notes
    └── Seed-<Type>*.ps1        ← load-test seeders, fixture generators, etc.
```

**`dev/` subfolder:** for scripts that support development and testing but are not part of the production image. The dispatcher ignores subdirectories entirely — nothing in `dev/` ever runs at runtime. Use it for load-test seeders, fixture generators, and migration helpers. Always include a `dev/README.md`.

See `docs/sync/custom-crawlers.md` for the full authoring guide including the `dev/` folder convention.

## PowerShell Style

**Brace style: Stroustrup** — opening brace on the same line as the statement; closing brace on its own line; blank line after every closing brace.

**Formatting:**
- Whitespace around all operators (`=`, `-eq`, `+`, etc.)
- No aliases — always use full cmdlet names (`ForEach-Object` not `%`; `Where-Object` not `?`)
- No semicolons as line terminators — use newlines
- Trim whitespace around pipe characters

**Regions** — use `#region` / `#endregion` blocks for non-trivial scripts:

```powershell
#region Parameters
#endregion Parameters

#region Configuration
#endregion Configuration

#region Functions
#endregion Functions

#region Main
#endregion Main
```

Add more regions as needed (e.g. `#region Authentication`). Never nest regions more than one level deep.

**Logging** — use colour-coded `Write-Host` throughout:

```powershell
Write-Host "Connected"       -ForegroundColor Green   # success
Write-Host "Rate limited"    -ForegroundColor Yellow  # warning / non-fatal
Write-Host "Fetching users…" -ForegroundColor Cyan    # progress
Write-Host "ERROR: $msg"     -ForegroundColor Red     # error
```

Never use `Write-Output` for progress messages — use `return` for values only.

## Rules

- Every `.ps1` file must have `[CmdletBinding()]` — the Pester quality gate enforces this.
- Entry point filenames must be `Start-<Something>.ps1` — the dependency loader excludes `Start-*` when dot-sourcing library files.
- Never run the `odata` type as a job — its entry point throws by design. Use it only as a `dependsOn` dependency.
- `_syncMode` is the only reserved config key injected by the dispatcher. Don't use keys starting with `_` for your own config.

## Integration Tests

Every crawler should include a `Test-<Type>Crawler.ps1` alongside its `crawler.json`. The CI discovers and runs all such files automatically in topological dependency order — no YAML changes needed.

### Parameter contract

Every test file MUST accept these two parameters (the CI discovery loop always passes them):

```powershell
[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,  # e.g. http://localhost:3001/api
    [Parameter(Mandatory)] [string]$ApiKey       # built-in worker key
)
```

If your test doesn't use `$ApiKey` (e.g. a library-only test like `Test-ODataCrawler.ps1`), declare it as non-mandatory with a default:

```powershell
[string]$ApiKey = ''
```

### Failure contract

Test scripts MUST `throw` or call `exit 1` on failure. The CI runner uses `try/catch` to detect failures — a test that runs clean but never asserts anything will silently pass. Use `Write-Error` + `exit 1` or the `Report-Result` helper pattern from existing tests.

### Shared utilities

Import the mock OData server for crawlers that have no live CI endpoint:

```powershell
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared' 'Start-MockODataServer.ps1')
$mock = Start-MockODataServer -EntitySets @{ Users = @(...) }
# ... test code ...
Stop-MockODataServer -Mock $mock
```

The mock server (`tools/crawlers/shared/Start-MockODataServer.ps1`) runs as a background job on an OS-assigned port and serves configurable OData JSON. It is designed for `ubuntu-latest` runners only — do not use on Windows without URL ACL setup.

### Extra parameters via environment variables

The two-parameter contract (`-ApiBaseUrl`, `-ApiKey`) is fixed. If your test needs extra configuration (e.g. a tenant ID for a real API test), use environment variables:

```powershell
$tenantId = $env:TEST_GRAPH_TENANT_ID
if (-not $tenantId) { Write-Host "Skipping — TEST_GRAPH_TENANT_ID not set"; exit 0 }
```

Set secrets in GitHub Actions → Settings → Secrets and variables → Actions. Add an `if: env.MY_SECRET != ''` condition to the test step or handle it in the script.

### Examples

- `tools/crawlers/odata/Test-ODataCrawler.ps1` — library test against a mock server (no `-ApiKey` needed)
- `tools/crawlers/omada/Test-OmadaCrawler.ps1` — full E2E test against a mock server (requires Docker stack)

## `principalType` and `identityType` Values

**`Principals.principalType`** — use these values consistently across all crawlers:

| Value | Description |
|-------|-------------|
| `User` | Interactive human user account |
| `ServicePrincipal` | App registration service principal |
| `ManagedIdentity` | Azure resource-attached managed identity |
| `WorkloadIdentity` | Federated credential identity (GitHub Actions, AKS) |
| `AIAgent` | AI agent (Copilot Studio, Azure OpenAI, custom) |
| `ExternalUser` | Guest / B2B account from another tenant |
| `SharedMailbox` | Shared mailbox or room/equipment account |

**`Identities.identityType`** — since `ResourceAssignments` now supports `identityId` alongside `principalId` (migration 036), identities can represent both humans and technical accounts modelled as identities in IGA systems. The `Identities` table does not yet have an `identityType` column — this is a planned addition. Until it lands, crawlers that write technical-account identities should store the type in `extendedAttributes`. When the column is added, use:

| Value | Description |
|-------|-------------|
| `Person` | Human identity — the standard case |
| `ServiceAccount` | Technical / functional / service account modelled as an identity in an IGA system |
| `MachineAccount` | Non-human machine or device account |

**Which table to use:** `principalType` describes the account; `identityType` describes the correlated entity. A technical account (`principalType=ServicePrincipal`) can have a corresponding Identity (`identityType=ServiceAccount`) when the IGA system models it that way — both tables may be populated. Pure principal-only organisations (no IGA) never write `identityId` rows.

## PowerShell SDK

The worker container loads `setup/IdentityAtlas.psm1` before running any crawler, which makes all functions in `tools/powershell-sdk/` available. Key categories:

| Folder | Purpose | Key functions |
|--------|---------|---------------|
| `graph/` | Graph API wrappers + auth | `Get-FGAccessToken`, `Invoke-FGGetRequest`, `Invoke-FGPostRequest`, `Get-FGUser`, `Get-FGGroup`, `Get-FGServicePrincipal` |
| `helpers/` | Idempotent resource helpers | `Confirm-FGGroup`, `Confirm-FGUser`, `Confirm-FGAccessPackage` |

**Rule:** never call `Invoke-RestMethod` directly for Graph API — always use `Invoke-FGGetRequest` / `Invoke-FGPostRequest` etc. They handle pagination, token refresh, and retries automatically.

## Key Files

| File | Role |
|---|---|
| `setup/IdentityAtlas.psm1` | Defines `Get-CrawlerRegistry` — the auto-discovery function |
| `setup/docker/Invoke-CrawlerJob.ps1` | Manifest-driven dispatcher; reads registry, resolves deps via DFS, runs entry point |
| `app/api/src/routes/jobs.js` | Node.js side; reads same manifests for `VALID_JOB_TYPES` and `configSchema` validation |
| `tools/crawlers/shared/Start-MockODataServer.ps1` | Reusable mock HTTP server for integration tests |
| `tools/crawlers/shared/Invoke-CrawlerIngest.ps1` | Shared ingest helpers (`Invoke-IngestAPI`, `Update-CrawlerProgress`, `ConvertTo-JsonArray`) — dot-source from each crawler entry point |

## Shared ingest helpers

All crawler entry points must dot-source the shared helpers at the top of their script body (after `$ApiBaseUrl`, `$ApiKey`, `$JobId` are set):

```powershell
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
```

The helpers read `$ApiBaseUrl`, `$ApiKey`, and `$JobId` from the caller's scope at call time. `Update-CrawlerProgress` throws on HTTP 409 (job terminated server-side) so the dispatcher can abort the crawl cleanly.

## Tests

- `test/unit/Dispatcher.Tests.ps1` — registry building, DFS ordering, cycle detection, live manifest validation
- `test/unit/Omada.Tests.ps1` — OData auth, `Get-OmadaRef*` helpers, file structure assertions
- `test/unit/CrawlerIngest.Tests.ps1` — shared ingest helpers: scope-capture, 409 abort, JSON array guarantees
- `tools/crawlers/odata/Test-ODataCrawler.ps1` — OData library integration test (all 6 auth methods)
- `tools/crawlers/omada/Test-OmadaCrawler.ps1` — Omada IGA end-to-end integration test

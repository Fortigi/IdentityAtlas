# Crawler Development — Quick Reference

Full authoring guide: [`docs/sync/custom-crawlers.md`](../../docs/sync/custom-crawlers.md)
Architecture internals: [`docs/architecture/crawler-architecture.md`](../../docs/architecture/crawler-architecture.md)

## Adding a Crawler

Drop a folder into `tools/crawlers/<type>/` with `crawler.json` + entry point. No changes to `Invoke-CrawlerJob.ps1`, `IdentityAtlas.psm1`, or `pr.yml` needed. Restart the worker to pick it up.

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
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'shared\Start-MockODataServer.ps1')
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

## Key Files

| File | Role |
|---|---|
| `setup/IdentityAtlas.psm1` | Defines `Get-CrawlerRegistry` — the auto-discovery function |
| `setup/docker/Invoke-CrawlerJob.ps1` | Manifest-driven dispatcher; reads registry, resolves deps via DFS, runs entry point |
| `app/api/src/routes/jobs.js` | Node.js side; reads same manifests for `VALID_JOB_TYPES` and `configSchema` validation |
| `tools/crawlers/shared/Start-MockODataServer.ps1` | Reusable mock HTTP server for integration tests |

## Tests

- `test/unit/Dispatcher.Tests.ps1` — registry building, DFS ordering, cycle detection, live manifest validation
- `test/unit/Omada.Tests.ps1` — OData auth, `Get-OmadaRef*` helpers, file structure assertions
- `tools/crawlers/odata/Test-ODataCrawler.ps1` — OData library integration test (all 6 auth methods)
- `tools/crawlers/omada/Test-OmadaCrawler.ps1` — Omada IGA end-to-end integration test

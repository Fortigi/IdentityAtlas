# Crawler Development Guide

## Adding a New Crawler

Drop a folder into `tools/crawlers/<type>/` with a `crawler.json` manifest and an entry point script.
`Get-CrawlerRegistry` auto-discovers it at module load — no changes to `Invoke-CrawlerJob.ps1`,
`IdentityAtlas.psm1`, or `pr.yml` are needed.

```
tools/crawlers/
└── my-source/
    ├── crawler.json               ← required manifest
    └── Start-MySourceCrawler.ps1  ← entry point declared in manifest
```

Restart the worker container after adding the folder. The new crawler appears in the UI automatically.

## `crawler.json` Schema

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | ✅ | Registry key and `JobType` identifier — must be unique across all crawlers |
| `displayName` | string | ✅ | Human-readable name shown in the UI |
| `entryPoint` | string | ✅ | Entry point filename, relative to the crawler folder |
| `dependsOn` | string[] | — | Crawler types whose library files are dot-sourced before this crawler runs |
| `configSchema` | JSON Schema object | — | Describes expected config fields; used by the UI to render the config form |
| `postSyncHooks` | string[] | — | Named hooks the dispatcher runs after the crawler completes (see below) |

### Minimal example

```json
{
  "type": "my-source",
  "displayName": "My Source System",
  "entryPoint": "Start-MySourceCrawler.ps1",
  "dependsOn": [],
  "postSyncHooks": ["buildContexts", "accountCorrelation"]
}
```

### `postSyncHooks` reference

| Hook | What it does |
|---|---|
| `buildContexts` | Runs `Build-FGContexts.ps1` — derives org-unit context membership from principal data |
| `accountCorrelation` | Runs `Invoke-FGAccountCorrelation` — links accounts across systems to shared identities |

Most crawlers that sync users should include both hooks.

## Auto-Discovery

`Get-CrawlerRegistry` (in `setup/IdentityAtlas.psm1`) scans `tools/crawlers/*/crawler.json` once
at module load and builds a registry hashtable keyed by `type`. The result is cached for the
lifetime of the module session.

The dispatcher (`setup/docker/Invoke-CrawlerJob.ps1`) calls `Get-CrawlerRegistry` to look up the
entry point and dependencies for each job — it never references crawler types by name.

## Dependency System (`dependsOn`)

A crawler can declare other crawlers as dependencies. Before running the entry point, the dispatcher
dot-sources all `.ps1` library files from each dependency folder (excluding the dependency's own entry
point), making their functions available in the caller's scope.

Dependencies are resolved via DFS so chains work automatically:
if `my-crawler` → `odata` → `rest`, the load order is `rest → odata → my-crawler`.

**Example:** Omada declares `"dependsOn": ["odata"]`. Before `Start-OmadaCrawler.ps1` runs, the
dispatcher dot-sources `Invoke-ODataAuth.ps1`, `Invoke-ODataGetRequest.ps1`, and
`Invoke-ODataPagedRequest.ps1` from `tools/crawlers/odata/`. The Omada entry point can then call
`Connect-ODataAPI` and `Invoke-ODataPagedRequest` directly without importing anything.

## The OData Base Layer (`tools/crawlers/odata/`)

A reusable library for any OData 4.0 REST API. Declare `"dependsOn": ["odata"]` to use it.
The `odata` type is library-only — its entry point (`Start-ODataCrawler.ps1`) throws immediately
if invoked directly as a job.

### Functions provided

| Function | Purpose |
|---|---|
| `Connect-ODataAPI` | Authenticate and store session. Auth methods: `ApiToken`, `BasicAuth`, `CookieString`, `OAuth2CC`, `OAuth2ROPC`, `FormCookie` |
| `Invoke-ODataPagedRequest` | Fetch all pages of an OData collection; returns a flat array |
| `Invoke-ODataGetRequest` | Single GET with explicit `$top`/`$skip` and optional base URL override |
| `Get-ODataAuthRoot` | Return the root URL (strips `/odata/dataobjects` suffix) for auth endpoints |

`Connect-ODataAPI` stores session state in `$script:ODataSession`. All subsequent `Invoke-OData*`
calls read from that session automatically — no token passing between calls.

## Standard Entry Point Interface

Every entry point must accept exactly these four mandatory parameters:

```powershell
[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,   # Identity Atlas API root, e.g. http://web:3001/api
    [Parameter(Mandatory)] [string]$ApiKey,       # Built-in crawler API key (fgc_...)
    [Parameter(Mandatory)] [int]$JobId,           # CrawlerJobs.id for live progress reporting
    [Parameter(Mandatory)] [string]$ConfigPath    # Path to JSON config written by the dispatcher
)
```

The dispatcher writes the job config to a temp JSON file and passes the path as `$ConfigPath`.
Read it at the top of your entry point:

```powershell
$Cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
```

The dispatcher cleans up the temp file after the entry point exits (success or error).

### Reserved config keys

The dispatcher injects these keys before writing the file:

| Key | Type | Description |
|---|---|---|
| `_syncMode` | `"full"` \| `"delta"` | Sync mode selected by the operator; honour it or document why you ignore it |

All other keys come directly from the operator-supplied config stored in the database.

### Conventional config keys (not injected — operators set them)

| Key | Used by | Purpose |
|---|---|---|
| `selectedObjects` | entra-id, omada | Hashtable of `phase → bool` to enable/disable individual sync phases |
| `contextObjectTypes` | omada | List of OData entity sets to sync as Identity Atlas Contexts |
| `resourceCategoryMapping` | omada | Maps source category labels to Identity Atlas `resourceType` values |

## Building an OData-based Crawler

1. Create `tools/crawlers/my-source/crawler.json` with `"dependsOn": ["odata"]`
2. Create the entry point with the standard interface
3. Authenticate with `Connect-ODataAPI`, then call `Invoke-ODataPagedRequest`

**crawler.json**
```json
{
  "type": "my-source",
  "displayName": "My OData Source",
  "entryPoint": "Start-MySourceCrawler.ps1",
  "dependsOn": ["odata"],
  "postSyncHooks": ["buildContexts", "accountCorrelation"],
  "configSchema": {
    "type": "object",
    "required": ["baseUrl", "authMethod"],
    "properties": {
      "baseUrl":    { "type": "string" },
      "authMethod": { "enum": ["ApiToken","BasicAuth","OAuth2CC","OAuth2ROPC","CookieString","FormCookie"] },
      "apiToken":   { "type": "string" }
    }
  }
}
```

**Start-MySourceCrawler.ps1**
```powershell
[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [int]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$Cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json

# Connect-ODataAPI is available because "dependsOn": ["odata"] caused the
# dispatcher to dot-source odata library files before this script ran.
Connect-ODataAPI -BaseUrl $Cfg.baseUrl -AuthMethod $Cfg.authMethod -ApiToken $Cfg.apiToken

$Items = Invoke-ODataPagedRequest -Path '/MyEntity' -QueryParams @{ '$filter' = 'Active eq true' }

# Push to Identity Atlas ingest API ...
```

> **Note:** Never run the `odata` crawler type as a job — its `Start-ODataCrawler.ps1` entry point
> throws immediately by design. It exists solely as a `dependsOn` base layer.

# Crawler Architecture

Identity Atlas uses a **pluggable crawler system**. Each data source is a self-contained folder under `tools/crawlers/<type>/`. Adding a new crawler requires no changes to the dispatcher, the module loader, or any CI configuration — drop the folder in, restart the worker container, and the new type appears in the UI.

---

## How It Works

```
tools/crawlers/
├── entra-id/
│   ├── crawler.json               ← manifest
│   └── Start-EntraIDCrawler.ps1   ← entry point
├── omada/
│   ├── crawler.json
│   ├── Get-OmadaHelpers.ps1       ← library (dot-sourced, not an entry point)
│   └── Start-OmadaCrawler.ps1
├── odata/                         ← reusable OData library (no jobs run directly)
│   ├── crawler.json
│   ├── Invoke-ODataAuth.ps1
│   ├── Invoke-ODataGetRequest.ps1
│   └── Invoke-ODataPagedRequest.ps1
├── csv/
│   ├── crawler.json
│   └── Start-CSVCrawler.ps1
└── demo/
    ├── crawler.json
    └── Start-DemoCrawler.ps1
```

At startup the worker module (`setup/IdentityAtlas.psm1`) calls `Get-CrawlerRegistry`, which scans every `crawler.json` file and builds a registry hashtable keyed by `type`. The dispatcher (`setup/docker/Invoke-CrawlerJob.ps1`) looks up the entry point and dependencies from this registry for every job — it never references crawler types by name.

The Node.js API (`app/api/src/routes/jobs.js`) reads the same manifests to discover which job types are valid and to validate configs before queueing jobs.

---

## The `crawler.json` Manifest

Every crawler folder must contain a `crawler.json`:

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | ✅ | Unique registry key. Must match the folder name by convention. Becomes the `jobType` identifier in `CrawlerJobs`. |
| `displayName` | string | ✅ | Human-readable name shown in the UI. |
| `entryPoint` | string | ✅ | Entry point filename, relative to the crawler folder. |
| `dependsOn` | string[] | — | Crawler types whose library `.ps1` files are dot-sourced before the entry point runs. |
| `configSchema` | JSON Schema object | — | Describes config fields. The UI renders a form from this schema. The API validates submitted configs against it before queuing a job. |
| `postSyncHooks` | string[] | — | Named hooks the dispatcher runs after the entry point exits successfully. |

### Minimal `crawler.json`

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
| `buildContexts` | Derives org-unit context membership from synced principal data |
| `accountCorrelation` | Links accounts across systems to shared Identity records |

Most crawlers that sync users should include both hooks.

---

## Dependency System

A crawler can declare other crawlers as dependencies via `dependsOn`. Before the entry point runs, the dispatcher dot-sources all `.ps1` files from each dependency folder — excluding the dependency's own entry point — making their functions available in the caller's scope.

Dependencies are resolved via depth-first search, so chains work automatically. If `my-crawler` depends on `odata`, which in turn depends on `rest`, the load order is: `rest → odata → my-crawler`.

**Circular dependencies** are detected at runtime. The dispatcher throws a clear error naming the cycle rather than hanging.

**Example:** Omada's manifest declares `"dependsOn": ["odata"]`. Before `Start-OmadaCrawler.ps1` runs, the dispatcher dot-sources `Invoke-ODataAuth.ps1`, `Invoke-ODataGetRequest.ps1`, and `Invoke-ODataPagedRequest.ps1`. The Omada script calls `Connect-ODataAPI` and `Invoke-ODataPagedRequest` directly, with no imports.

---

## The OData Base Layer

`tools/crawlers/odata/` is a reusable library for any OData 4.0 REST API. Declare `"dependsOn": ["odata"]` to use it.

The `odata` type is **library-only** — its entry point throws immediately if invoked as a job. It exists solely as a dependency base.

### Functions

| Function | Purpose |
|---|---|
| `Connect-ODataAPI` | Authenticate and store a session. Supported methods: `ApiToken`, `BasicAuth`, `CookieString`, `OAuth2CC`, `OAuth2ROPC`, `FormCookie` |
| `Invoke-ODataPagedRequest` | Fetch all pages of an OData collection; returns a flat array |
| `Invoke-ODataGetRequest` | Single GET with explicit `$top`/`$skip` |
| `Get-ODataAuthRoot` | Return the root URL, stripping any `/odata/dataobjects` suffix |

`Connect-ODataAPI` stores session state in `$script:ODataSession`. All subsequent `Invoke-OData*` calls read from it automatically — no token passing between calls.

---

## Standard Entry Point Interface

Every entry point must accept exactly these four mandatory parameters:

```powershell
[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,
    [Parameter(Mandatory)] [string]$ApiKey,
    [Parameter(Mandatory)] [int]$JobId,
    [Parameter(Mandatory)] [string]$ConfigPath
)
```

| Parameter | Description |
|---|---|
| `$ApiBaseUrl` | Identity Atlas API root, e.g. `http://web:3001/api` |
| `$ApiKey` | Built-in crawler API key (starts with `fgc_`) |
| `$JobId` | `CrawlerJobs.id` — used for live progress reporting |
| `$ConfigPath` | Path to a temp JSON file containing the job config |

The dispatcher writes the operator-supplied config to a temp file and passes the path. Read it at the start of the entry point:

```powershell
$Cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
```

The dispatcher deletes the temp file after the entry point exits, whether it succeeds or fails.

### Reserved config keys (injected by the dispatcher)

| Key | Values | Description |
|---|---|---|
| `_syncMode` | `"full"` \| `"delta"` | The sync mode selected by the operator. Honour it where practical. |

### Conventional config keys (set by operators)

| Key | Used by | Purpose |
|---|---|---|
| `selectedObjects` | entra-id, omada | Map of `phase → bool` to toggle individual sync phases |
| `contextObjectTypes` | omada | OData entity sets to sync as Contexts |
| `resourceCategoryMapping` | omada | Maps source category labels to `resourceType` values |

---

## Building a New Crawler

### 1. Create the folder structure

```
tools/crawlers/my-source/
├── crawler.json
└── Start-MySourceCrawler.ps1
```

No other file changes are needed.

### 2. Write the manifest

```json
{
  "type": "my-source",
  "displayName": "My Source System",
  "entryPoint": "Start-MySourceCrawler.ps1",
  "dependsOn": [],
  "postSyncHooks": ["buildContexts", "accountCorrelation"],
  "configSchema": {
    "type": "object",
    "required": ["apiUrl", "apiKey"],
    "properties": {
      "apiUrl": { "type": "string", "minLength": 1, "description": "Base URL of the source API" },
      "apiKey": { "type": "string", "description": "API key for authentication" }
    }
  }
}
```

The `configSchema` is a standard [JSON Schema](https://json-schema.org/) object. The UI renders a form from it; the API validates configs against it before queuing.

### 3. Write the entry point

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

# Report progress to the UI
$headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
function Write-Progress ([string]$Step, [int]$Pct) {
    Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post -Headers $headers `
        -Body (@{ jobId = $JobId; step = $Step; pct = $Pct } | ConvertTo-Json -Compress)
}

Write-Progress 'Fetching data' 10

# Fetch from the source system ...
$items = Invoke-RestMethod -Uri "$($Cfg.apiUrl)/items" -Headers @{ 'X-Api-Key' = $Cfg.apiKey }

Write-Progress 'Pushing to Identity Atlas' 50

# Push to Identity Atlas ingest API ...
$body = @{ records = $items; syncMode = $Cfg._syncMode; systemId = 1 } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/principals" -Method Post -Headers $headers -Body $body

Write-Progress 'Complete' 100
```

### 4. Building on the OData base layer

If your source system exposes an OData 4.0 API, declare `"dependsOn": ["odata"]` in your manifest and use the built-in OData functions:

```json
{
  "type": "my-odata-source",
  "displayName": "My OData Source",
  "entryPoint": "Start-MyODataCrawler.ps1",
  "dependsOn": ["odata"],
  "postSyncHooks": ["buildContexts", "accountCorrelation"],
  "configSchema": {
    "type": "object",
    "required": ["baseUrl", "authMethod"],
    "properties": {
      "baseUrl":    { "type": "string" },
      "authMethod": { "enum": ["ApiToken", "BasicAuth", "OAuth2CC", "OAuth2ROPC", "CookieString", "FormCookie"] },
      "apiToken":   { "type": "string" }
    }
  }
}
```

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

# Connect-ODataAPI is available because the dispatcher dot-sourced the odata library first.
Connect-ODataAPI -BaseUrl $Cfg.baseUrl -AuthMethod $Cfg.authMethod -ApiToken $Cfg.apiToken

$items = Invoke-ODataPagedRequest -Path '/Users' -QueryParams @{ '$filter' = 'Active eq true' }

# Push to Identity Atlas ingest API ...
```

### 5. Restart and test

Restart the worker container. The new crawler appears in the UI under **Admin → Crawlers → Add Crawler** immediately.

```bash
docker compose restart worker
```

---

## How Job Dispatch Works

1. The scheduler or UI creates a row in `CrawlerJobs` with `jobType = "my-source"`.
2. The worker picks up the job and calls `Invoke-CrawlerJob.ps1 -JobType "my-source" ...`.
3. The dispatcher calls `Get-CrawlerRegistry` to find the manifest for `my-source`.
4. The dispatcher resolves dependencies via DFS and dot-sources library files in topological order.
5. The dispatcher writes the job config to a temp file and calls the entry point.
6. After the entry point exits, the dispatcher runs any `postSyncHooks` declared in the manifest.
7. The temp config file is deleted.

The API side (`routes/jobs.js`) reads the same manifests to populate the `VALID_JOB_TYPES` list and to validate configs via `validateCrawlerConfig(type, config)` before a job is queued.

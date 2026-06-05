# Building a Custom Crawler

Identity Atlas crawlers are self-contained folders. Drop one into `tools/crawlers/<type>/` and the system picks it up automatically — no changes to the dispatcher, module loader, or CI pipelines needed.

For how the system works internally, see [`docs/architecture/crawler-architecture.md`](../architecture/crawler-architecture.md).

---

## Folder Structure

```
tools/crawlers/my-source/
├── crawler.json               ← required manifest
└── Start-MySourceCrawler.ps1  ← entry point declared in manifest
```

Restart the worker container after adding the folder. The new crawler appears in the UI under **Admin → Crawlers → Add Crawler** immediately.

---

## The Manifest (`crawler.json`)

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

| Field | Required | Description |
|---|---|---|
| `type` | ✅ | Unique key — becomes the `jobType` in `CrawlerJobs`. Use the folder name. |
| `displayName` | ✅ | Name shown in the UI. |
| `entryPoint` | ✅ | Entry point filename, relative to the crawler folder. |
| `dependsOn` | — | Other crawler types whose library files are dot-sourced before this one runs. |
| `configSchema` | — | [JSON Schema](https://json-schema.org/) object. The UI renders a form from it; the API validates configs against it before queueing. |
| `postSyncHooks` | — | `"buildContexts"` derives org-unit contexts; `"accountCorrelation"` links accounts across systems. Most user-syncing crawlers should include both. |

---

## The Entry Point Interface

Every entry point must accept exactly these four parameters:

```powershell
[CmdletBinding()]
Param(
    [Parameter(Mandatory)] [string]$ApiBaseUrl,   # Identity Atlas API root, e.g. http://web:3001/api
    [Parameter(Mandatory)] [string]$ApiKey,       # Built-in crawler API key (fgc_...)
    [Parameter(Mandatory)] [int]$JobId,           # CrawlerJobs.id for live progress reporting
    [Parameter(Mandatory)] [string]$ConfigPath    # Path to temp JSON file written by the dispatcher
)
```

The dispatcher writes the operator-supplied config to a temp JSON file and passes the path. Read it at the top:

```powershell
$Cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
```

The temp file is deleted after the entry point exits, whether it succeeds or fails.

### Reserved config keys (injected by the dispatcher)

| Key | Values | Description |
|---|---|---|
| `_syncMode` | `"full"` \| `"delta"` | Sync mode selected by the operator. Honour it where practical. |

### Conventional config keys (set by operators)

| Key | Used by | Purpose |
|---|---|---|
| `selectedObjects` | entra-id, omada | Map of `phase → bool` to toggle individual sync phases |
| `contextObjectTypes` | omada | OData entity sets to sync as Contexts |
| `resourceCategoryMapping` | omada | Maps source category labels to `resourceType` values |

---

## Minimal Entry Point

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

$headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }

function Write-CrawlerProgress ([string]$Step, [int]$Pct) {
    Invoke-RestMethod -Uri "$ApiBaseUrl/crawlers/job-progress" -Method Post -Headers $headers `
        -Body (@{ jobId = $JobId; step = $Step; pct = $Pct } | ConvertTo-Json -Compress)
}

Write-CrawlerProgress 'Fetching data' 10

# Fetch from source system
$items = Invoke-RestMethod -Uri "$($Cfg.apiUrl)/items" -Headers @{ 'X-Api-Key' = $Cfg.apiKey }

Write-CrawlerProgress 'Pushing to Identity Atlas' 50

# Push to Identity Atlas ingest API
$body = @{ records = $items; syncMode = $Cfg._syncMode; systemId = 1 } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/principals" -Method Post -Headers $headers -Body $body

Write-CrawlerProgress 'Complete' 100
```

---

## Building on the OData Base Layer

If your source exposes an OData 4.0 API, declare `"dependsOn": ["odata"]` in the manifest. The dispatcher will dot-source the OData library before your entry point runs, making `Connect-ODataAPI`, `Invoke-ODataPagedRequest`, `Invoke-ODataGetRequest`, and `Get-ODataAuthRoot` available without any imports.

**`crawler.json`:**
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
    },
    "allOf": [
      { "if": { "properties": { "authMethod": { "const": "ApiToken" } } },
        "then": { "required": ["apiToken"] } }
    ]
  }
}
```

**`Start-MyODataCrawler.ps1`:**
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

# Connect-ODataAPI is available because "dependsOn": ["odata"] caused the dispatcher
# to dot-source the odata library before this script ran.
Connect-ODataAPI -BaseUrl $Cfg.baseUrl -AuthMethod $Cfg.authMethod -ApiToken $Cfg.apiToken

$items = Invoke-ODataPagedRequest -Path '/Users' -QueryParams @{ '$filter' = 'Active eq true' }

# Push to Identity Atlas ingest API ...
$headers = @{ Authorization = "Bearer $ApiKey"; 'Content-Type' = 'application/json' }
$body = @{ records = $items; syncMode = $Cfg._syncMode; systemId = 1 } | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri "$ApiBaseUrl/ingest/principals" -Method Post -Headers $headers -Body $body
```

> **Note:** Never run the `odata` type as a job — its entry point throws by design. Use it only as a `dependsOn` base.

---

## See Also

- [`docs/architecture/crawler-architecture.md`](../architecture/crawler-architecture.md) — how the registry, DFS dependency loading, and dispatch work internally
- [`docs/sync/entra-id.md`](entra-id.md) — Entra ID crawler reference
- [`docs/sync/csv-import.md`](csv-import.md) — CSV import reference

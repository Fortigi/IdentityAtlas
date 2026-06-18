# Building a Custom Crawler

Identity Atlas crawlers are self-contained folders. Drop one into `tools/crawlers/<type>/` and the system picks it up automatically — no changes to the dispatcher, module loader, or CI pipelines needed.

For how the system works internally, see [`docs/architecture/crawler-architecture.md`](../architecture/crawler-architecture.md).

---

## Folder Structure

```
tools/crawlers/my-source/
├── crawler.json               ← required manifest
├── Start-MySourceCrawler.ps1  ← entry point declared in manifest
├── CLAUDE.md                  ← developer guide (architecture, data-model mapping, gotchas)
├── Test-MySourceCrawler.ps1   ← CI integration test (optional but recommended)
└── dev/                       ← development and testing utilities (optional)
    ├── README.md              ← what each tool does and how to run it
    └── Seed-MySourceData.ps1  ← example: load-test seeder, fixture generator, etc.
```

### The `dev/` subfolder

The `dev/` folder is the home for scripts that support development and testing of the crawler but are **not part of the production image** and not loaded by the dispatcher. Use it for:

- **Load-test seeders** — scripts that create large volumes of test data in the source system to validate crawler performance and memory usage
- **Fixture generators** — one-off scripts that seed a known, repeatable dataset for manual or exploratory testing
- **Migration helpers** — scripts useful during initial setup or version upgrades of the source system

The dispatcher ignores subdirectories, so nothing in `dev/` is ever executed at runtime. Include a `dev/README.md` that describes what each tool does, how to run it, and (for seeders) how to clean up afterwards.

Restart the worker container after adding the folder. The new crawler appears in the UI under **Admin → Crawlers → Add Crawler** immediately.

---

## The Manifest (`crawler.json`)

```json
{
  "type": "my-source",
  "displayName": "My Source System",
  "entryPoint": "Start-MySourceCrawler.ps1",
  "dependsOn": [],
  "postSyncHooks": ["buildContexts"],
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
| `postSyncHooks` | — | `"buildContexts"` derives org-unit contexts after a sync. Most user-syncing crawlers should include it. The historical `"accountCorrelation"` hook is now a **no-op** — account-to-identity matching moved to the scheduler-driven [Account Linking](../architecture/account-linking.md) engine — so new crawlers should omit it. |

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
  "postSyncHooks": ["buildContexts"],
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

## Integration Testing

Every crawler should include a `Test-<Type>Crawler.ps1` file alongside its `crawler.json`. The PR integration CI discovers and runs all such files automatically — no YAML changes needed.

See `tools/crawlers/CLAUDE.md` for the parameter contract, shared mock server usage, and examples (`Test-ODataCrawler.ps1`, `Test-OmadaCrawler.ps1`).

---

## Feeding the Effective-Access Engine (hierarchical permissions)

If your source has a **containment hierarchy with inherited permissions** — Azure RM scopes,
file-system folders, SharePoint sites, DevOps projects — you do **not** materialise the
inherited access. You emit only the *declared* grants plus the hierarchy, and the
[effective-access engine](../architecture/effective-access-engine.md) computes inheritance
lazily (a grant at a parent shows as `Indirect` on every descendant). You store O(declared),
not O(declared × descendants).

Emit four things through the normal ingest endpoints:

1. **Container nodes** — `Resources` rows for each scope/folder/site.
2. **`Contains` relationships** — `ingest/resource-relationships` with
   `relationshipType='Contains'` (parent→child). Set `extendedAttributes.propagates=false` on
   the edge to a child that **breaks inheritance** (default is `true`).
3. **Capability-resources** — one `Resources` row per *declared* `(capability, node)` only.
   Put `capabilityId` and `targetNodeId` in `extendedAttributes`, and use the **deterministic
   id** so a synthesized inherited row and your stored row collapse into one:
   ```powershell
   . (Join-Path $PSScriptRoot '..' 'shared' 'Get-CapabilityId.ps1')
   $id = Get-CapabilityId -TargetNodeId $scopeId -CapabilityId $roleDefId
   ```
4. **Grants** — `ingest/resource-assignments` to the capability-resource, with `effect`
   (`allow` / `deny` / `eligible`, default `allow`) and `propagationScope`
   (`self` / `descendants` / `selfAndDescendants`, default `selfAndDescendants`).

**Worked example (Azure RM):** emit `Subscription` / `RG` / `VM` resources + `Contains` edges;
one `Contributor @ Subscription` capability-resource with a grant to the user; nothing for the
RG or VM. The engine answers `GET /api/resource/<vm>/effective-access?principalId=<u>` with
`contributor` / `Indirect` — inherited down the tree, never stored.

> Monotonic sources (Azure RM, additive SharePoint levels) just take the `effect`/
> `propagationScope` defaults. Deny-bearing sources (NTFS, DevOps) emit `effect='deny'` and a
> source-specific resolution policy — that path lands in engine phase P3.

---

## See Also

- [`docs/architecture/effective-access-engine.md`](../architecture/effective-access-engine.md) — the engine that computes inherited/effective access
- [`docs/architecture/crawler-architecture.md`](../architecture/crawler-architecture.md) — how the registry, DFS dependency loading, and dispatch work internally
- [`docs/sync/entra-id.md`](entra-id.md) — Entra ID crawler reference
- [`docs/sync/csv-import.md`](csv-import.md) — CSV import reference

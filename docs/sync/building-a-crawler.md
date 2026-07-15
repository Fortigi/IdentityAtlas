# Building a Crawler

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

**If your `configSchema` marks a secret field (`clientSecret`, or one of `password`/`apiToken`/`cookieString`) as `required`** — directly, or conditionally via `allOf`/`if`-`then` keyed off an auth-method property, the way `omada`'s and `midPoint`'s schemas do for `OAuth2CC`/`OAuth2ROPC` — you get correct vault-aware validation for free, with no code on your part. `clientSecret` is stripped out of the stored config JSON on every save (it lives only in the secrets vault), so a config freshly loaded from storage never has it; every place that validates such a config (an edit, a "Run Now", a scheduled run) calls `validateStoredCrawlerConfig(type, config, configId)` instead of the raw schema validator, which checks the vault before concluding the field is genuinely missing. See `app/api/CLAUDE.md` → "Crawler Job System" for the mechanism, and `app/api/src/crawlerManifests.test.js` for the test coverage.

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

# Dot-source the shared ingest helpers. They read $ApiBaseUrl, $ApiKey, and $JobId
# from this scope at call time, so there's no need to hand-roll progress reporting or
# the ingest POST — use Update-CrawlerProgress and Invoke-CrawlerIngestBatch instead.
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')

Update-CrawlerProgress -Step 'Fetching data' -Pct 10

# Fetch from source system
$items = Invoke-RestMethod -Uri "$($Cfg.apiUrl)/items" -Headers @{ 'X-Api-Key' = $Cfg.apiKey }

Update-CrawlerProgress -Step 'Pushing to Identity Atlas' -Pct 50

# Push to the Identity Atlas ingest API. Invoke-CrawlerIngestBatch handles chunking,
# retries with backoff, delta tombstones, and empty-batch scoped deletes for you.
Invoke-CrawlerIngestBatch -Endpoint 'ingest/principals' -SystemId 1 `
    -SyncMode $Cfg._syncMode -Records $items

Update-CrawlerProgress -Step 'Complete' -Pct 100
```

---

## The Ingest API

`/ingest/principals` above is one of many ingest endpoints — the full, authoritative reference is the live OpenAPI spec the running app already serves:

- **Swagger UI:** `<ApiBaseUrl>/docs` (e.g. `http://localhost:3001/api/docs`) — interactive, try-it-out enabled
- **Raw spec:** `<ApiBaseUrl>/openapi.json`

As of this writing the ingest surface covers: `/ingest/systems`, `/ingest/principals`, `/ingest/resources`, `/ingest/resource-assignments`, `/ingest/resource-relationships`, `/ingest/identities`, `/ingest/identity-members`, `/ingest/contexts`, `/ingest/governance/catalogs`, `/ingest/governance/policies`, `/ingest/governance/requests`, `/ingest/governance/certifications`, and `/ingest/refresh-views` — see [Data Model](../concepts/data-model.md) and [Governance Model](../concepts/governance-model.md) for what each table represents. Don't hand-roll a request shape from memory or by copying another crawler — check the spec first (it's hand-maintained in `app/api/src/openapi.yaml`, lint-checked by Spectral in CI for internal consistency, but not auto-generated from the route handlers, so treat the live route's validation as the final authority if the two ever disagree).

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

## UI Integration

Everything above produces a working crawler that runs from the CLI/scheduler. To make it usable from **Admin → Crawlers → Add Crawler** with a proper type-picker entry and configuration form, drop the matching files into the same `tools/crawlers/<type>/` folder. None of this requires touching any file outside that folder — `CrawlersPage.jsx` discovers all of it automatically via `import.meta.glob`.

> **This step isn't optional once your crawler is past the prototype stage.** Without a `CrawlerMeta.js`, the `crawler-manifest` CI check (`pr.yml`) fails the PR — it requires every crawler type to have one, with no exception for new types (only a fixed legacy list of crawlers still mid-migration is exempt).

### `CrawlerMeta.js` — required for the type picker

```js
export default {
  id: 'my-source',           // must match crawler.json's "type" and the folder name
  name: 'My Source System',  // shown in the "Add Crawler" type picker
  description: 'One-line description shown below the name in the picker',
};
```

### `ConfigWizard.jsx` — optional step-by-step config form

If omitted, the UI falls back to a generic JSON config editor — fine for a quick prototype, but a real wizard is what operators actually expect. The component receives a fixed 5-prop contract:

```jsx
import { useState } from 'react';
// Import shared form components via the @ui/ alias (resolved by app/ui/vite.config.js) —
// never a '../../../app/ui/src/...' relative traversal:
import ScheduleEditor from '@ui/components/ScheduleEditor';

export default function MyConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  // onComplete() — call with no arguments when done; the wizard saves its
  //                own config via authFetch before calling this (POST to
  //                create, PATCH .../crawler-configs/:id to update)
  // onCancel()    — call when the user cancels
  // initialConfig — the existing config object when isEdit=true
  // isEdit        — true when editing an existing crawler
  // authFetch     — authenticated fetch helper (same signature as window.fetch)
  const [baseUrl, setBaseUrl] = useState(initialConfig?.baseUrl || '');
  // ... render form fields, call authFetch(...) on save, then onComplete() ...
}
```

The wizard **owns saving its own config** — `CrawlersPage.jsx` never builds the request body for a migrated crawler. See `tools/crawlers/omada/ConfigWizard.jsx` or `tools/crawlers/midpoint/ConfigWizard.jsx` for full multi-step examples (connection → credentials → sync options → schedule), including the credential-field round-tripping rule: only send a secret field when it's non-blank, so leaving it blank on edit means "keep the stored value."

### `Summary.jsx` — optional config-card summary panel

Renders crawler-specific details (e.g. base URL, sync options) inside the card on the "Configured Crawlers" list:

```jsx
export default function Summary({ cfg, config }) {
  // cfg    — config.config, the crawler's own config blob — what most summaries need
  // config — the full config row, for the rare case something outside .config is needed
  return <div className="text-sm text-gray-600 dark:text-gray-400">{cfg.baseUrl}</div>;
}
```

Don't render `lastRunAt`/`lastRunStatus` — the card already shows those generically for every crawler type below the summary panel.

### `discover.js` — optional live-discovery endpoint

If your wizard needs to validate credentials or populate a dropdown from the live source system (entity sets, role archetypes, available attributes, …), drop a `discover.js` and the API exposes `POST /api/admin/crawlers/<type>/discover` automatically — no route changes needed:

```js
export default async function handler(req, res, { db, getConfigSecret }) {
  // req.body — whatever the wizard sent (credentials, or { configId } in edit
  //            mode when the user hasn't re-entered a secret)
  // getConfigSecret(configId) — resolves a vaulted secret in edit mode; never
  //            trust req.body.clientSecret alone, it's stripped from storage
  //            on every save (see app/api/CLAUDE.md re: secrets/vault.js)
  // db — the pg pool (via getPool())
  res.json({ /* whatever your wizard expects back */ });
}
```

See `tools/crawlers/omada/discover.js` and `tools/crawlers/midpoint/discover.js` for real examples, and `tools/crawlers/omada/discover.test.js` for how to test one (mock `fetch` + `getConfigSecret`, no HTTP server needed — co-located with the handler, not under `app/api/src/routes/`; the API's `vitest.config.js` is what picks it up).

### File uploads — only if operators need to attach files

CSV-style crawlers that need the operator to upload data files (rather than pull from a live API) set two manifest fields and drop template files:

```json
{
  "supportsFileUploads": true,
  "uploadFileExtensions": [".csv"]
}
```

This unlocks the generic `GET/POST /api/admin/crawler-configs/:configId/files` + `DELETE .../files/:filename` routes — files land in `/data/uploads/<type>-{configId}/`, a Docker volume shared with the worker. Drop empty, header-only template files in `tools/crawlers/<type>/schema/*.csv` and they're served generically too, via `GET /api/admin/crawlers/<type>/upload-schema`. See `tools/crawlers/CLAUDE.md` → "File uploads" for the full contract and the optional `<type>-slots.json` label/required-annotation file.

### Testing the UI-side files

This is a separate set of conventions from the PowerShell integration test above — co-located `vitest`/Playwright tests, not Pester. See `tools/crawlers/CLAUDE.md` → "JS/UI Testing" for the full guide: the render-smoke-test pattern (and why it can't catch interaction bugs), when to extract wizard logic into pure exported functions so it's unit-testable, the `*.e2e.mjs` + `register(test, expect)` pattern for real Playwright interaction tests, and how to test a `discover.js` handler.

### One rule that applies to everything above

**Nothing specific to your crawler type belongs outside its `tools/crawlers/<type>/` folder** — including its tests. A file named after your crawler type (or one that hardcodes its type string) anywhere under `app/ui/` will fail the `crawler-manifest` CI check once your crawler is past `PENDING_MIGRATION`. See `tools/crawlers/CLAUDE.md` → Rules.

---

## See Also

- [`docs/architecture/effective-access-engine.md`](../architecture/effective-access-engine.md) — the engine that computes inherited/effective access
- [`docs/architecture/crawler-architecture.md`](../architecture/crawler-architecture.md) — how the registry, DFS dependency loading, and dispatch work internally
- [`docs/sync/entra-id.md`](entra-id.md) — Entra ID crawler reference
- [`docs/sync/csv-import.md`](csv-import.md) — CSV import reference

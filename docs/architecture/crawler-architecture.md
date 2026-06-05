# Crawler Architecture

Identity Atlas uses a **pluggable crawler system**. Each data source is a self-contained folder under `tools/crawlers/<type>/`. Adding a new crawler requires no changes to the dispatcher, the module loader, or any CI configuration — drop the folder in, restart the worker container, and the new type appears in the UI.

---

## Folder Structure

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

---

## Registry and Auto-Discovery

At startup, `Get-CrawlerRegistry` (in `setup/IdentityAtlas.psm1`) scans every `tools/crawlers/*/crawler.json` and builds a registry hashtable keyed by `type`. The result is cached for the lifetime of the module session.

The dispatcher (`setup/docker/Invoke-CrawlerJob.ps1`) looks up the entry point and dependencies from this registry for every job — it never references crawler types by name.

The Node.js API (`app/api/src/routes/jobs.js`) reads the same manifests independently at startup to populate the valid job type list and compile config validators.

---

## The `crawler.json` Manifest

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | ✅ | Unique registry key. Becomes the `jobType` identifier. |
| `displayName` | string | ✅ | Human-readable name shown in the UI. |
| `entryPoint` | string | ✅ | Entry point filename, relative to the crawler folder. |
| `dependsOn` | string[] | — | Crawler types whose library `.ps1` files are dot-sourced before the entry point runs. |
| `configSchema` | JSON Schema object | — | Describes config fields. The UI renders a form from this; the API validates configs against it before queueing a job. |
| `postSyncHooks` | string[] | — | Named hooks the dispatcher runs after the entry point exits successfully. |

### `postSyncHooks` reference

| Hook | What it does |
|---|---|
| `buildContexts` | Derives org-unit context membership from synced principal data |
| `accountCorrelation` | Links accounts across systems to shared Identity records |

---

## Dependency System

A crawler can declare other crawlers as dependencies via `dependsOn`. Before the entry point runs, the dispatcher dot-sources all `.ps1` files from each dependency folder (excluding the dependency's own entry point), making their functions available in the caller's scope.

Dependencies are resolved via **depth-first search**, so chains work automatically. If `my-crawler` depends on `odata`, which depends on `rest`, the load order is: `rest → odata → my-crawler`.

**Circular dependencies** are detected at runtime. The dispatcher throws a clear error naming the cycle rather than hanging.

**Example:** Omada declares `"dependsOn": ["odata"]`. Before `Start-OmadaCrawler.ps1` runs, the dispatcher dot-sources `Invoke-ODataAuth.ps1`, `Invoke-ODataGetRequest.ps1`, and `Invoke-ODataPagedRequest.ps1` from the odata folder. The Omada entry point calls `Connect-ODataAPI` directly, with no imports.

---

## The OData Base Layer (`tools/crawlers/odata/`)

A reusable library for any OData 4.0 REST API. Declare `"dependsOn": ["odata"]` in your manifest to use it.

The `odata` type is **library-only** — its entry point throws immediately if invoked as a job. It exists solely as a dependency base.

### Functions provided

| Function | Purpose |
|---|---|
| `Connect-ODataAPI` | Authenticate and store a session. Auth methods: `ApiToken`, `BasicAuth`, `CookieString`, `OAuth2CC`, `OAuth2ROPC`, `FormCookie` |
| `Invoke-ODataPagedRequest` | Fetch all pages of an OData collection; returns a flat array |
| `Invoke-ODataGetRequest` | Single GET with explicit `$top`/`$skip` |
| `Get-ODataAuthRoot` | Return the root URL, stripping any `/odata/dataobjects` suffix |

`Connect-ODataAPI` stores session state in `$script:ODataSession`. All subsequent `Invoke-OData*` calls read from it automatically — no token passing required.

---

## How Job Dispatch Works

1. The scheduler or UI creates a row in `CrawlerJobs` with `jobType = "my-source"`.
2. The worker picks up the job and calls `Invoke-CrawlerJob.ps1 -JobType "my-source"`.
3. The dispatcher calls `Get-CrawlerRegistry` to find the manifest for `my-source`.
4. The dispatcher resolves `dependsOn` via DFS and dot-sources library files in topological order.
5. The dispatcher writes the job config to a temp JSON file and invokes the entry point.
6. After the entry point exits, the dispatcher runs any `postSyncHooks` declared in the manifest.
7. The temp config file is deleted.

The API (`routes/jobs.js`) reads the same manifests at startup to populate `VALID_JOB_TYPES` and to validate configs via `validateCrawlerConfig(type, config)` before a job is queued.

---

## See Also

- [`docs/sync/custom-crawlers.md`](../sync/custom-crawlers.md) — step-by-step guide for building a new crawler
- [`tools/crawlers/CLAUDE.md`](../../tools/crawlers/CLAUDE.md) — dev quick-reference (rules, key files, tests)

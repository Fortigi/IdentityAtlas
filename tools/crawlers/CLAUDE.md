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
├── CrawlerMeta.js              ← UI type picker entry (id, name, description)
├── ConfigWizard.jsx            ← optional step-by-step config wizard for the UI
├── Summary.jsx                 ← optional config-card summary panel for the UI
├── discover.js                 ← optional live-discovery handler (Node.js, ESM)
├── schema/                     ← optional empty/header-only template files (if supportsFileUploads)
│   └── *.csv
├── <type>-slots.json           ← optional per-file label/required metadata for schema/ (e.g. csv-slots.json)
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

## UI Integration

The UI auto-discovers crawlers from the `tools/crawlers/` folder via `import.meta.glob`. No changes to `CrawlersPage.jsx` are needed when adding a new crawler type.

### CrawlerMeta.js — type picker registration

Every crawler that should appear in the UI's "Add Crawler" type picker must export a default object:

```js
export default {
  id: 'my-type',           // must match the crawler.json `type` field and folder name
  name: 'My Crawler',      // display name shown in the type picker
  description: 'One-line description shown below the name in the picker',
};
```

### ConfigWizard.jsx — optional step-by-step wizard

If present, the UI renders this component when the user picks this crawler type. The component receives:

```jsx
export default function MyConfigWizard({ onComplete, onCancel, initialConfig, isEdit, authFetch }) {
  // onComplete()         — call with no arguments when done; the wizard saves its
  //                        own config via authFetch before calling this
  // onCancel()           — call when the user cancels
  // initialConfig        — existing config when isEdit=true
  // isEdit               — true when editing an existing crawler
  // authFetch(url, opts) — authenticated fetch helper (same as window.fetch but with auth headers)
}
```

Import paths from `tools/crawlers/<type>/` must traverse back to `app/ui/src/`:
```js
import ScheduleEditor from '../../../app/ui/src/components/ScheduleEditor';
import Combobox from '../../../app/ui/src/components/inputs/Combobox';
import Select from '../../../app/ui/src/components/inputs/Select';
```

If no `ConfigWizard.jsx` is present, the UI falls back to a generic JSON config editor.

### Summary.jsx — optional config-card summary panel

If present, the UI renders this component inside the crawler's card on the "Configured Crawlers" list, showing the crawler-specific details at a glance (e.g. base URL, sync options). The component receives:

```jsx
export default function Summary({ cfg, config }) {
  // cfg    — the crawler's config blob (config.config); what most summaries need
  // config — the full config row, for the rare case something outside .config is needed
}
```

Don't render `lastRunAt`/`lastRunStatus` here — the card already shows those generically below every summary panel, for every crawler type. If no `Summary.jsx` is present, the card just shows that generic footer with no extra panel.

### discover.js — optional live-discovery endpoint

If present, the API exposes `POST /api/admin/crawlers/<type>/discover` backed by this file. The file must be ESM with a default export matching:

```js
export default async function handler(req, res, { db, getConfigSecret }) {
  // req.body contains the current wizard config (credentials, base URL, etc.)
  // db — the pg pool (via getPool())
  // getConfigSecret(crawlerId, key) — decrypts a stored credential
  // respond with res.json(...)
}
```

The handler is loaded dynamically at request time from `CRAWLER_MANIFESTS_DIR/<type>/discover.js` — it does not need to be imported anywhere.

### File uploads — `supportsFileUploads` + `schema/`

If a crawler type needs the user to upload files (CSV is currently the only one), set `"supportsFileUploads": true` and `"uploadFileExtensions": [".csv"]` (or whatever extensions apply) in `crawler.json`. This unlocks the generic routes in `routes/crawlerFiles.js`:

- `GET/POST /api/admin/crawler-configs/:configId/files`, `DELETE .../files/:filename` — list/upload/delete files for a config of this type. Configs of other types are rejected with a 400.
- Files land in `/data/uploads/<type>-{configId}/` (a Docker volume shared with the worker) — `routes/jobs.js` resolves this path generically via `getUploadFolderPath(type, configId)` and refuses to queue a job if the folder is empty.

If you also drop empty, header-only template files in `tools/crawlers/<type>/schema/*.csv`, they're served generically too — `GET /api/admin/crawlers/<type>/upload-schema` (all templates, concatenated) and `.../upload-schema/<filename>` (one file), loaded dynamically the same way `discover.js` is — no core file needs to know which crawlers have templates. An optional `tools/crawlers/<type>/<type>-slots.json` (array of `{ key, file, label, required }`) adds label/required annotations to the concatenated download's comments; without it the templates still serve correctly, just without that annotation.

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

## JS/UI Testing

The PowerShell side has the `Test-<Type>Crawler.ps1` contract above. The `ConfigWizard.jsx`/`discover.js`/`Summary.jsx` side has its own, separate conventions:

### Where the tests live and run

Co-locate test files next to the plugin: `tools/crawlers/<type>/*.test.{js,jsx}`. They run under the **UI's** vitest, not the API's — `app/ui/vite.config.js`'s `test.include` explicitly adds `'../../tools/crawlers/**/*.test.{js,jsx}'` alongside `src/**/*.test.{js,jsx}`. A test file placed here without that glob entry would simply never execute, silently — there's no error, the suite just doesn't grow. Run them from `app/ui`:

```bash
cd app/ui && npx vitest run ../../tools/crawlers/<type>
```

**ESLint does not cover this folder.** `npm run lint` in `app/ui` runs `eslint .`, which only scans `app/ui`'s own tree — `tools/crawlers/*` files are never linted in CI today. Don't assume a clean `npm run lint` says anything about a wizard file's code quality.

### Render smoke tests (`ConfigWizard.test.jsx`)

A minimal test that renders the wizard via `react-dom/server`'s `renderToStaticMarkup` and asserts on the output HTML. This catches import/relocation mistakes (a missing back-reference to `app/ui/src/components/...`, a bad relative path to a sibling JSON file) because those throw at render time. It does **not** catch interaction bugs — `renderToStaticMarkup` never attaches event handlers, so clicking a button or typing into an input does nothing in this kind of test. See `tools/crawlers/csv/ConfigWizard.test.jsx` for the pattern:

```jsx
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ConfigWizard from './ConfigWizard.jsx';

const html = renderToStaticMarkup(h(ConfigWizard, { onComplete: () => {}, onCancel: () => {}, initialConfig: null, isEdit: false, authFetch: () => new Promise(() => {}) }));
```

### Extract non-trivial logic into pure, exported functions

If a wizard has real branching logic — validation gates, payload-building, fuzzy matching — pull it out of the component closure into a top-level exported function that takes explicit arguments instead of reading `useState` values. This is the only way to unit-test it directly without rendering anything, and it's the same fix CSV needed for `matchSlot`/`fmtBytes` and omada/midpoint needed for `canSubmitCredentials`/`buildCredentialFields` (the per-auth-method "can I submit yet" gate and "which credential fields actually changed" payload builder — both were closures over component state until extracted). Test the function directly:

```js
import { canSubmitCredentials } from './ConfigWizard.jsx';
expect(canSubmitCredentials('ApiToken', { apiToken: '', ... }, /* isEdit */ false)).toBe(false);
```

A regression in this kind of logic is easy to ship invisibly — it either silently blocks a previously-working auth method, lets an incomplete config through to save, or drops a credential field on save. Worth the extraction whenever the logic has more than one or two branches.

### Real interaction tests (Playwright e2e)

When the thing worth testing is an actual user interaction against the real backend — staging files, watching a coverage indicator update, an upload/list/delete round trip — a render smoke test can't reach it (no event handlers fire) and a pure-function unit test doesn't exist (there's no extractable pure function, the behavior *is* the DOM + network interaction). Reach for a Playwright spec under `app/ui/e2e/` instead. See `app/ui/e2e/csv-crawler-wizard.spec.js` (file upload step) and `app/ui/e2e/custom-connector.spec.js` (full wizard flow + real config persisted) for the pattern — both assume `AUTH_ENABLED=false` and a real running backend (either the local mock-mode dev server or, for CI, the full Docker stack via `playwright.ci.config.js`).

### Testing a `discover.js` handler

Call the handler function directly with a mocked `db` and a stubbed global `fetch` — no HTTP server needed. See `app/api/src/routes/omadaDiscover.test.js`:

```js
import handler from '../../../../tools/crawlers/omada/discover.js';
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<xml/>' }));
await handler(req, res, { db: { queryOne: vi.fn().mockResolvedValue({ config: {...} }) } });
```

This lives under `app/api/src/routes/` (API-side vitest), not co-located with the crawler folder, since it's exercising the handler the same way the generic `POST /api/admin/crawlers/:type/discover` route invokes it.

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

# Crawler Development — Quick Reference

Full authoring guide: [`docs/sync/building-a-crawler.md`](../../docs/sync/building-a-crawler.md)
Architecture internals: [`docs/architecture/crawler-architecture.md`](../../docs/architecture/crawler-architecture.md)

## Adding a Crawler

Drop a folder into `tools/crawlers/<type>/` with `crawler.json` + entry point. No changes to `Invoke-CrawlerJob.ps1`, `IdentityAtlas.psm1`, or `pr.yml` needed. Restart the worker to pick it up.

## Folder conventions

```
tools/crawlers/<type>/
├── crawler.json                ← required manifest
├── Start-<Type>Crawler.ps1     ← entry point (thin: orchestration only)
├── <Type>Crawler.Functions.ps1 ← optional: dot-sourced reusable helpers (Pester-unit-tested)
├── <Type>Crawler.Transform.ps1 ← optional: dot-sourced pure record-shapers (Pester-unit-tested)
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

See `docs/sync/building-a-crawler.md` for the full authoring guide including the `dev/` folder convention.

### Keep entry points thin — extract testable logic

A `Start-<Type>Crawler.ps1` body runs live I/O the moment it is dot-sourced, so anything inline in it is unreachable by Pester without a real tenant. Keep the entry point to orchestration (auth, fetch, send, progress) and push the parts worth testing into dot-sourced sibling files:

- **`<Type>Crawler.Transform.ps1`** — **pure** record-shapers: one Graph/source object → one ingest record hashtable. Take everything as **explicit parameters** (no `$script:`/scope capture), do no I/O, and `return` the record (or `$null` to signal "skip"). These unit-test directly against in-memory fixtures with zero mocks — the cheapest coverage you can get. Name them `ConvertTo-<Entity>Record` / `ConvertTo-<Entity><Thing>`.
- **`<Type>Crawler.Functions.ps1`** — reusable helpers whose boundary is a mockable named command (e.g. `Send-IngestBatch` → `Invoke-IngestAPI`). Unit-test by mocking that boundary.

> **Mocking the boundary is not the same as testing the decision.** A test that mocks `Invoke-IngestAPI` and asserts how many times it was called cannot catch a change to *what the helper computed* — the retry predicate, the page offset, the flags on the record. Those need direct tests against the decision function itself. Measured: the Azure/midPoint helper layer sat at 31%–79% mutation score with a full suite of call-count assertions around it; adding direct tests took the same files to 90%–97%. Read **[Writing tests that actually assert](../../docs/contributing/writing-tests-that-assert.md)** before adding crawler tests — it lists the five ways a suite here looked thorough while asserting nothing, and the Pester traps specific to this repo (helpers declared outside `BeforeAll`, `Should -Invoke` counts accumulating across an `It`, `-Times` meaning *at least*).

The entry point dot-sources both right after the shared ingest helpers:

```powershell
. (Join-Path $PSScriptRoot '..' 'shared' 'Invoke-CrawlerIngest.ps1')
. (Join-Path $PSScriptRoot '<Type>Crawler.Functions.ps1')
. (Join-Path $PSScriptRoot '<Type>Crawler.Transform.ps1')
```

Then each phase block shrinks to `... | ForEach-Object { ConvertTo-<Entity>Record -Arg $_ ... }`. Move the body **verbatim** first, add the test, then refactor — and watch for inline state shared *between* phases (a variable set in one phase and read in another): hoist it to the shared setup block so neither phase depends on the other having run. Extracted files must **not** be named `Start-*` (the dispatcher's dependency loader excludes `Start-*` when dot-sourcing). See `tools/crawlers/entra-id/EntraIDCrawler.Transform.ps1` + `test/unit/EntraIDCrawlerTransform.Tests.ps1` for the worked pattern, and the `csv` crawler's `*.Functions.ps1` for the helper variant.

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

Import UI components via the `@ui/` alias — never use `'../../../app/ui/src/'` traversal:
```js
import ScheduleEditor from '@ui/components/ScheduleEditor';
import Combobox from '@ui/components/inputs/Combobox';
import Select from '@ui/components/inputs/Select';
import Stepper from '@ui/components/Stepper';
import useDocsUrl from '@ui/hooks/useDocsUrl';
import { formatDate } from '@ui/utils/formatters';
```

The `@ui` alias is resolved by the Vite config in `app/ui/vite.config.js` (which also runs the vitest suite for crawlers). Editor support comes from `jsconfig.json` at the repo root.

If no `ConfigWizard.jsx` is present, the UI falls back to a generic JSON config editor.

### Summary.jsx — optional config-card summary panel

If present, the UI renders this component inside the crawler's card on the "Configured Crawlers" list, showing the crawler-specific details at a glance (e.g. base URL, sync options). The component receives:

```jsx
export default function Summary({ cfg, config, authFetch }) {
  // cfg       — the crawler's config blob (config.config); what most summaries need
  // config    — the full config row, for the rare case something outside .config is needed
  // authFetch — authenticated fetch helper. Only needed by a type whose summary
  //             self-manages something beyond what the generic card offers (see
  //             "Push-mode crawler types" below) — most Summary.jsx files ignore it.
}
```

Don't render `lastRunAt`/`lastRunStatus` here — the card already shows those generically below every summary panel, for every crawler type. If no `Summary.jsx` is present, the card just shows that generic footer with no extra panel.

### Push-mode crawler types (`Crawlers` vs `CrawlerConfigs`, and capability flags)

Every crawler type renders as a card in the "Configured Crawlers" grid, backed by one `CrawlerConfigs` row per instance — except the data model has a second table, `Crawlers`, for API-key authentication (the Built-in Worker, and Custom Connector). That table exists because push-mode auth material (key hash/salt/prefix, rate limit, rotation/audit history) is a genuinely different concern from a pull-job's settings blob — bolting API-key columns onto every CSV/Omada config, or schedule columns onto every API key, would be worse than two tables. A type that's push-mode (data arrives via the Ingest API rather than a scheduled job) declares `"pushMode": true` in its `crawler.json` and still gets a `CrawlerConfigs` row so it shows up as a normal card — `routes/crawlers.js`'s `POST /admin/crawlers` creates the `Crawlers` row and a paired `CrawlerConfigs` row (`crawlerType` resolved from the `pushMode` manifest flag via `getPushModeType()`, never hardcoded; `config: { crawlerId: <Crawlers.id> }`) in one statement; either delete path (`DELETE /admin/crawlers/:id` or `DELETE /admin/crawler-configs/:id`) cleans up the other row too (gated by `isPushModeType()`). See `tools/crawlers/custom-connector/` for the only current example: its `Summary.jsx` fetches its own `Crawlers` row by `cfg.crawlerId` to show the key prefix, drive the enable toggle and key reset, and render the audit log — none of which exist on a normal `CrawlerConfigs` row.

Because Run/Configure/Export assume a scheduled, editable, exportable `CrawlerConfigs`-driven job, a push-mode type opts out of whichever don't apply via `CrawlerMeta.js`:

```js
export default {
  id: 'custom-connector',
  // ...
  supportsRun: false,       // no scheduled job — pushed via the Ingest API instead
  supportsConfigure: false, // no edit wizard — manage via Summary.jsx instead
  supportsExport: false,    // nothing meaningful to export (no secrets, no settings)
};
```

All three default to `true` when omitted — existing types need no changes.

### discover.js — optional live-discovery endpoint

If present, the API exposes `POST /api/admin/crawlers/<type>/discover` backed by this file. The file must be ESM with a default export matching:

```js
export default async function handler(req, res, { db, getConfigSecret }) {
  // req.body contains the current wizard config (credentials, base URL, etc.)
  // db — the pg pool (via getPool())
  // getConfigSecret(configId) — decrypts the stored clientSecret for that config
  // respond with res.json(...)
}
```

The handler is loaded dynamically at request time from `CRAWLER_MANIFESTS_DIR/<type>/discover.js` — it does not need to be imported anywhere.

### File uploads — `supportsFileUploads` + `schema/`

If a crawler type needs the user to upload files (CSV is currently the only one), set `"supportsFileUploads": true` and `"uploadFileExtensions": [".csv"]` (or whatever extensions apply) in `crawler.json`. This unlocks the generic routes in `routes/crawlerFiles.js`:

- `GET/POST /api/admin/crawler-configs/:configId/files`, `DELETE .../files/:filename` — list/upload/delete files for a config of this type. Configs of other types are rejected with a 400.
- Files land in `/data/uploads/<type>-{configId}/` (a Docker volume shared with the worker) — `routes/jobs.js` resolves this path generically via `getUploadFolderPath(type, configId)` and refuses to queue a job if the folder is empty.

If you also drop empty, header-only template files in `tools/crawlers/<type>/schema/*.csv`, they're served generically too — `GET /api/admin/crawlers/<type>/upload-schema` (all templates, concatenated) and `.../upload-schema/<filename>` (one file), loaded dynamically the same way `discover.js` is — no core file needs to know which crawlers have templates. An optional `tools/crawlers/<type>/<type>-slots.json` (array of `{ key, file, label, required }`) adds label/required annotations to the concatenated download's comments; without it the templates still serve correctly, just without that annotation.

### Manifest capability flags (API behaviour)

Core API code must never branch on a crawler-type string (`if (jobType === 'demo')`). Type-specific behaviour is declared as a boolean flag in `crawler.json` and read through `app/api/src/crawlerManifests.js` helpers, so adding/altering it needs no core edit and the `crawler-manifest` CI check stays green:

| `crawler.json` flag | Helper in `crawlerManifests.js` | Effect |
|---|---|---|
| `"singletonJob": true` | `isSingletonJob(type)` | Only one queued/running job of this type at a time — a second concurrent run is rejected with 409. Used by the demo dataset. |
| `"pushMode": true` | `isPushModeType(type)`, `getPushModeType()` | Data arrives via the Ingest API, not a pull job. Registered via `POST /admin/crawlers` (API-key `Crawlers` row paired with a `CrawlerConfigs` card); see "Push-mode crawler types" above. Used by the Custom Connector. |

To add a new type-specific behaviour, add a flag + a helper here — never a `=== '<type>'` check in a route.

## Rules

- Every `.ps1` file must have `[CmdletBinding()]` — the Pester quality gate enforces this.
- Entry point filenames must be `Start-<Something>.ps1` — the dependency loader excludes `Start-*` when dot-sourcing library files.
- Never run the `odata` type as a job — its entry point throws by design. Use it only as a `dependsOn` dependency.
- `_syncMode` is the only reserved config key injected by the dispatcher. Don't use keys starting with `_` for your own config.
- **Nothing specific to one crawler type belongs outside its `tools/crawlers/<type>/` folder** — not just `ConfigWizard.jsx`/`discover.js`/`Summary.jsx`/`CrawlerMeta.js`, but also that crawler's tests (unit, render-smoke, e2e, *and* the `discover.js` handler test or a test of that crawler's `configSchema` — see JS/UI Testing below) and any helper file. If a file's name or content only makes sense for one crawler type, it goes in that crawler's folder, full stop — including when the natural-feeling place would be a shared `app/ui/e2e/`, `app/ui/src/`, or **`app/api/src/routes/`** test/helper (a `discover.js` handler test, or a detailed "which fields does auth method X require" schema test, are the ones that are tempting to leave in `app/api/src/routes/` next to `jobs.js`, since that's where they're *invoked* from — they still belong in the crawler's own folder; only generic, type-agnostic engine tests — the dispatch route itself (`jobs.discover.test.js`), or `maskConfig`/manifest discovery (`jobs.configValidation.test.js`) — stay in `app/api/src/routes/`). The `crawler-manifest` CI job enforces this across **both** `app/ui/` and `app/api/src/` (it fails on a stray filename containing the type name, or a hardcoded type-string literal in either tree; the gitignored generated `app-bundle.mjs` and `*.test.js` files are excluded). Core must never branch on a crawler-type string — read a manifest capability flag instead (see "Manifest capability flags" below). Still: get it right the first time rather than leaning on CI.

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

Test scripts MUST `throw` or call `exit 1` on failure. The CI runner uses `try/catch` to detect failures — a test that runs clean but never asserts anything will silently pass. Use `Write-Error` + `exit 1` or the `Write-Result` helper pattern from existing tests.

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

Co-locate test files next to the plugin: `tools/crawlers/<type>/*.test.{js,jsx}`.

**Quick-reference — which filename runs under which runner:**

| Filename pattern | Runner | Why |
|---|---|---|
| `ConfigWizard.test.jsx` | UI vitest (`app/ui`) | Imports JSX; needs React plugin |
| `credentialGating.test.js` | UI vitest (`app/ui`) | Pure JS, caught by UI's broad glob |
| `matchSlot.test.js` | UI vitest (`app/ui`) | Pure JS, caught by UI's broad glob |
| `contextValidation.test.js` | UI vitest (`app/ui`) | Pure JS, caught by UI's broad glob |
| `configPayload.test.js` | UI vitest (`app/ui`) | Pure JS, caught by UI's broad glob |
| `discover.test.js` | API vitest (`app/api`) | Exercises Node handler; explicitly included |
| `configValidation.test.js` | API vitest (`app/api`) | Imports `pg` via crawlerManifests; explicitly included and excluded from UI |
| `*.e2e.mjs` | Playwright (via `crawler-plugin-tests.spec.js`) | Full browser interaction; not a vitest file |

Most of these (render smoke tests, pure-function unit tests) run under the **UI's** vitest, not the API's — `app/ui/vite.config.js`'s `test.include` explicitly adds `'../../tools/crawlers/**/*.test.{js,jsx}'` alongside `src/**/*.test.{js,jsx}`. A test file placed here without that glob entry would simply never execute, silently — there's no error, the suite just doesn't grow. Run them from `app/ui`:

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

When the thing worth testing is an actual user interaction against the real backend — staging files, watching a coverage indicator update, an upload/list/delete round trip — a render smoke test can't reach it (no event handlers fire) and a pure-function unit test doesn't exist (there's no extractable pure function, the behavior *is* the DOM + network interaction).

These specs still belong co-located with the crawler, not in `app/ui/e2e/` — but a colocated file **can't** import `{ test, expect }` from `@playwright/test` directly. `@playwright/test` is only installed under `app/ui/node_modules`, and `tools/crawlers/` isn't a descendant of `app/ui`, so Node's module resolution can't reach it (the same root cause as the Docker frontend-build's `node_modules`-hoisting fix — see `app/api/Dockerfile`'s frontend-build stage comment — except there's no equivalent hoisting trick available for local/CI test runs without restructuring how the whole project installs dependencies). The workaround:

- Name the file `tools/crawlers/<type>/<Name>.e2e.mjs` (the `.mjs` extension is required — Playwright's loader doesn't apply Node's "detect module syntax" auto-detection that a plain `.js` file here would need, since there's no ancestor `package.json` declaring `"type": "module"`).
- Export `register(test, expect)` instead of importing `@playwright/test` yourself:

```js
export function register(test, expect) {
  test.describe('My crawler wizard — something', () => {
    test('does the thing', async ({ page }) => { /* ... */ });
  });
}
```

- `app/ui/e2e/crawler-plugin-tests.spec.js` is the one generic loader that discovers every `tools/crawlers/<type>/*.e2e.mjs` file and calls `register(test, expect)` on it — no crawler-specific code needed there, same discovery style as `crawler-wizard-discovery.spec.js`. You don't need to touch it when adding a new crawler's e2e spec.

See `tools/crawlers/csv/ConfigWizard.e2e.mjs` for a full example (file upload step) and `tools/crawlers/custom-connector/ConfigWizard.e2e.mjs` for a simpler one (no file uploads, just the register → API key → getting-started flow). Both assume `AUTH_ENABLED=false` and a real running backend (either the local mock-mode dev server or, for CI, the full Docker stack via `playwright.ci.config.js`).

### Testing a `discover.js` handler

Call the handler function directly with a mocked `db` and a stubbed global `fetch` — no HTTP server needed. Name the file `tools/crawlers/<type>/discover.test.js` (co-located, like every other crawler test — never under `app/api/src/routes/`) and import the handler with a plain relative path:

```js
import handler from './discover.js';
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<xml/>' }));
await handler(req, res, { db: { queryOne: vi.fn().mockResolvedValue({ config: {...} }) } });
```

These run under the **API's** vitest, not the UI's, since they're exercising the handler the same way the generic `POST /api/admin/crawlers/:type/discover` route invokes it (no React, no DOM). `app/api/vitest.config.js`'s `test.include` adds `'../../tools/crawlers/**/discover.test.js'` alongside `src/**/*.test.js` so these are picked up without living in `src/routes/`. (They also happen to pass under the UI's vitest, since `discover.js` files have no React dependency and the UI's broader `tools/crawlers/**/*.test.{js,jsx}` glob matches them too — harmless redundant coverage, not something to route around.) See `tools/crawlers/omada/discover.test.js` or `tools/crawlers/entra-id/discover.test.js` for full examples.

### Testing a crawler's `configSchema`

Detailed assertions about *one* crawler's `crawler.json` schema (e.g. "OAuth2CC requires `clientSecret` and `tokenEndpoint`") test that crawler's own schema design, not the generic engine — they belong next to that crawler, not in `app/api/src/routes/jobs.js`'s tests. Name the file `tools/crawlers/<type>/configValidation.test.js` and call the shared, manifest-driven validator directly:

```js
import { validateCrawlerConfig } from '../../../app/api/src/crawlerManifests.js';
const validateOmada = (config) => validateCrawlerConfig('omada', config);
```

Same discovery mechanism as `discover.test.js`: `app/api/vitest.config.js`'s `test.include` also lists `'../../tools/crawlers/**/configValidation.test.js'` specifically (not a blanket `**/*.test.js`, since most other `tools/crawlers/**/*.test.js` files import their `ConfigWizard.jsx` and need the React/JSX plugin app/api's vitest doesn't have). Generic, type-agnostic engine behavior (`maskConfig`, `VALID_JOB_TYPES` manifest discovery) stays in `app/api/src/routes/jobs.configValidation.test.js`. See `tools/crawlers/omada/configValidation.test.js` for a full example.

Unlike `discover.test.js`, this one is **not** harmless under the UI's vitest too: `crawlerManifests.js` imports `secrets/crawlerSecrets.js` → `secrets/vault.js` → `db/connection.js`, which requires the `pg` package — only installed under `app/api/node_modules`, not `app/ui/node_modules`. The UI's broader `tools/crawlers/**/*.test.{js,jsx}` glob would otherwise pick this file up and fail with `ERR_MODULE_NOT_FOUND`. `app/ui/vite.config.js`'s `test.exclude` carves it back out for exactly this reason — don't remove that exclude when adding a new crawler's `configValidation.test.js`.

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

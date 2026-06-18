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
| `supportsFileUploads` | boolean | — | If `true`, this crawler type's configs may have files attached via the generic `POST/GET/DELETE /api/admin/crawler-configs/:configId/files` routes (`routes/crawlerFiles.js`). Configs of types without this flag get a 400 if something tries to attach files to them. |
| `uploadFileExtensions` | string[] | — | Allowed upload file extensions (e.g. `[".csv"]`), enforced by `crawlerFiles.js`'s multer `fileFilter`. Defaults to `['.csv']` if `supportsFileUploads` is set without this field. |

A crawler that sets `supportsFileUploads` should also drop a `schema/` folder of empty, header-only template files (e.g. `tools/crawlers/csv/schema/Users.csv`) next to its `crawler.json` — these are served generically via `GET /api/admin/crawlers/:type/upload-schema` (and `.../upload-schema/:filename` for one file at a time), the same dynamic-by-type loading pattern `discover.js` uses: no core file lists which crawlers have templates, a missing `schema/` dir just 404s. An optional `tools/crawlers/<type>/<type>-slots.json` (e.g. `csv-slots.json`) can supply per-file `label`/`required` metadata shown in the concatenated download's comments — purely cosmetic, the templates work without it.

### `postSyncHooks` reference

| Hook | What it does |
|---|---|
| `buildContexts` | Derives org-unit context membership from synced principal data |
| `accountCorrelation` | **Legacy / no-op.** Account-to-identity matching is no longer done in a post-sync hook — it is the deterministic [Account Linking](account-linking.md) engine in the web container, which runs on a schedule (`AccountLinkingConfig.schedules`) and on demand from Admin. The hook still resolves but skips: the old `Invoke-FGAccountCorrelation` function no longer ships, so the dispatcher logs "not available — skipping". New crawlers can omit it. |

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

## UI Wizard Plugins and Production Build Pipelines

A crawler's configuration wizard (`tools/crawlers/<type>/ConfigWizard.jsx` + `CrawlerMeta.js`) is discovered by `CrawlersPage.jsx` via a repo-root-relative `import.meta.glob('../../../../tools/crawlers/*/ConfigWizard.jsx')` — see `app/ui/CLAUDE.md` → "Crawler Wizard Plugin System" for how that works in dev. The same auto-discovery is what makes wizards drop-in: no edits anywhere outside the crawler's own folder.

That auto-discovery is also exactly what breaks if a *production build pipeline* doesn't lay files out the way the real repo does, because `import.meta.glob` is resolved against the literal filesystem at build time, not at dev-server time. Two things can go wrong independently:

1. **Silent zero matches.** If `tools/crawlers/` isn't present at all in the build's working copy, the glob just matches nothing — no error, the build succeeds, the wizard is simply missing from the shipped app. This is what broke the Docker image for the midPoint wizard (PR #342): the frontend-build stage only ever copied `app/ui/`.
2. **Hard resolution failure.** `tools/crawlers/*/ConfigWizard.jsx` files import `react` (a bare specifier) and may import shared `app/ui/src/components/*` via a relative path back into app/ui (e.g. midpoint's wizard imports `Select`, `Combobox`, `Stepper`, `ScheduleEditor` this way). Both kinds of import only resolve if `tools/crawlers` sits at its *real relative position* next to `app/ui` — as a true sibling, sharing a `node_modules` that's an ancestor of both. Building straight from `app/ui/` alone can't provide that, since `tools/crawlers` isn't a descendant of `app/ui`.

**The fix, used identically in every pipeline that bundles the UI for production:** stage `app/ui/` and `tools/crawlers/` as siblings under one throwaway root, with `node_modules` installed at that shared root (not nested under `app/ui/`), then build from inside the mirror.

| Pipeline | Where this lives |
|---|---|
| Docker image | `app/api/Dockerfile`'s `frontend-build` stage — `WORKDIR /build`, `COPY app/ui/ ./app/ui/`, `COPY tools/crawlers ./tools/crawlers`, `npm --prefix app/ui run build` |
| Portable Windows build (node-launcher) | `app/desktop/scripts/build-node-launcher.mjs` — stages an equivalent `app/ui` + `tools/crawlers` mirror under `dist-node-launcher/ui-build/` before building |

An alias-based alternative (point `import.meta.glob` and the wizards' `react` import at a vite `resolve.alias` that's repointed per build environment) was considered and rejected: it only protects the one call site you remember to alias, and silently regresses the moment a wizard adds a new relative import (like the `Select`/`Combobox` ones above) that nobody thought to route through the alias. Mirroring the real layout protects *any* relative path a wizard author writes, by construction, with nothing to remember.

**This bit us twice.** The Docker case (#342) was caught by a Playwright e2e test against a real Docker build (`app/ui/e2e/crawler-wizard-discovery.spec.js`). The node-launcher case had no equivalent check and sat broken on `main` from the moment the first wizard (midpoint, #336) merged until it was caught by inspection — not by CI — because `build-node-launcher.mjs` only ever runs on a beta/release cut, not on every PR. The guardrail now: `build-node-launcher.mjs --ui-only` runs on every PR (see `pr.yml`'s `node-launcher-ui-build` job) and asserts every crawler with a wizard actually appears in the built bundle, not just that the build exited 0.

**If you add a third UI-build pipeline:** give it the same sibling-mirror treatment up front, and don't rely on `unit-ui` / `lint-js` to catch a regression here — those test source files, not the production build output. Add a CI job that actually runs the new pipeline's build, the same way `node-launcher-ui-build` does.

---

## See Also

- [`docs/sync/custom-crawlers.md`](../sync/custom-crawlers.md) — step-by-step guide for building a new crawler
- [`tools/crawlers/CLAUDE.md`](../../tools/crawlers/CLAUDE.md) — dev quick-reference (rules, key files, tests)

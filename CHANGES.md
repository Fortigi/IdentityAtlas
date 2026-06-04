## Changes in this PR

- Fixed: launching the portable launcher a second time while Identity Atlas is already running no longer crashes — it now detects the existing instance and opens the browser instead
- Fixed: portable Windows launcher now correctly shows the release version number (e.g. "5.7.0") in the UI version card and footer instead of showing no version

## Changes in this PR

- Security: removed the Admin → "Containers" live-stats view and, with it, the Docker socket mount (`/var/run/docker.sock`) from the web container. Mounting the Docker socket into the web service was a host-takeover risk — a compromise of the web process could control the Docker daemon and the host. The container-stats dashboard didn't justify that exposure. Crawlers, data sync, and all other functionality are unaffected.

## Changes in this PR

- Docs version picker now shows the release version number (e.g. "5.7.0") instead of "stable"
- Cut Beta and Cut Release workflows now accept an optional ref input so releases can be cut from any commit, tag, or branch (default: main); docs deploy from the same ref

## Changes in this PR

- Security: LLM-generated risk-classifier patterns are now matched with a linear-time regular-expression engine (RE2) instead of the built-in engine. A maliciously or accidentally crafted pattern can no longer cause catastrophic backtracking that freezes risk scoring (a denial-of-service / ReDoS risk). Patterns using constructs RE2 cannot run in linear time (e.g. look-ahead) are skipped and logged rather than executed.
- Fixed: portable Windows launcher worker never picked up queued jobs (demo data import, crawlers) because the worker API key was read before the server finished writing it

## Changes in this PR

- Security: hardened the risk-profile URL scraper against server-side request forgery (SSRF). It now resolves and checks every target address and refuses private, loopback, link-local, and cloud-metadata addresses — including decimal/hex and IPv4-mapped encodings and addresses returned via DNS — pins the connection to the validated address to defeat DNS-rebinding, re-validates every redirect hop, and never forwards credentials across a redirect to a different host.

## Changes in this PR

- Security: fixed a guard that was meant to keep read-only API keys (`fgr_…`) out of admin endpoints but never actually triggered — it checked the mount-stripped request path instead of the full URL, so a leaked read-only key could reach admin GET endpoints (information disclosure). The check now uses the full request URL and correctly rejects read-only keys on `/api/admin/*`.

## Changes in this PR

- Security: Microsoft Graph crawler client secrets are no longer stored in plaintext in the database. They are encrypted in the secrets vault and injected only into the job handed to the authenticated worker at run time. Any existing plaintext client secrets are migrated into the vault automatically on upgrade.
- Security: the built-in worker's API key is no longer stored in plaintext in the database. It is kept only as a salted scrypt hash (for verification) plus a private, restricted file that the worker reads — and any previously-stored plaintext copy is removed automatically on upgrade. A read of the database can no longer recover a usable worker credential.

## Changes in this PR

- Security: the built-in worker's API key is no longer stored in plaintext in the database. It is kept only as a salted scrypt hash (for verification) plus a private, restricted file that the worker reads — and any previously-stored plaintext copy is removed automatically on upgrade. A read of the database can no longer recover a usable worker credential.

## Changes in this PR

- Security: the production Docker Compose stack no longer publishes PostgreSQL to all network interfaces. It now binds to localhost (`127.0.0.1`) only by default, so the database is not reachable from other hosts. Set `POSTGRES_BIND_HOST=0.0.0.0` if you deliberately need off-host access.
- Security: the production Docker Compose stack no longer ships a default database password. `POSTGRES_PASSWORD` is now required — the stack refuses to start until a strong value is set. (The local development compose still provides a default for convenience.)
- Azure deployments are unaffected — they use a managed PostgreSQL server rather than the Compose Postgres container.

## Changes in this PR

- Security (behaviour change): a signed-in user whose Entra roles map to no permissions is no longer silently granted full administrator access. Such users are now denied all admin and write actions (fail-closed). Previously, on installs where app roles had not been assigned yet, any authenticated tenant user effectively had admin rights.
- To grant access after enabling authentication, assign users an Entra app role — the default "Admin" role grants full access. If you lock yourself out by enabling auth before assigning a role, recover with the auth CLI (`auth-config.js disable`); see the Permissions & Roles documentation for the bootstrap and recovery steps.
- Added a startup warning when authentication is enabled without `AUTH_REQUIRED_ROLES`, since any signed-in tenant user can still read data until sign-in is restricted to specific roles.
- Security: the API now accepts only Entra ID **access tokens** issued for its own API scope (audience `api://<client-id>`). ID tokens — and any token whose audience is the bare client ID — are rejected. This prevents an ID token (issued on every interactive sign-in and not intended for API authorization) from being used as an API credential.
- This requires the Entra App Registration to expose its API with the default `api://<client-id>` Application ID URI, which the in-app setup walkthrough already configures.

## Changes in this PR

- Replaced `tools/setup-branch-protection.sh` with documentation in `docs/architecture/branching-strategy.md` — the script had drifted from the live ruleset config and a written guide is easier to maintain for a repo that is set up once.

## Changes in this PR

- Fixed granular admin roles: each admin permission is now enforced on its own routes, so a role granted (for example) only crawler access is no longer incorrectly blocked by unrelated admin permissions. Previously only the full-access (wildcard) role worked for admin endpoints.
- Added a "Permissions & Roles" reference page documenting every permission, the default role mapping, and how authorization is enforced.
- Added comprehensive automated tests for the permission model: an allow/deny check for every permission against its real endpoint, the role→permission gate logic, UI tests confirming tabs and controls are hidden when a user lacks the permission, a round-trip test proving that saving a changed role→permission mapping immediately changes access, and validation that signed tokens are rejected when their signature, audience, issuer, tenant, or expiry is wrong.
- Pull request checks now require accompanying tests and a changelog entry whenever code changes (maintainers can override with a label for genuine exceptions).

## Changes in this PR

- Added **Portable Windows Launcher** page to the documentation navigation under Architecture.

## Changes in this PR

- Documentation site now shows a version picker — visitors land on the **stable** docs by default and can switch to **edge** (latest `main`) via the dropdown in the top bar.
- Each GitHub Release automatically publishes a new stable docs snapshot; merges to `main` update the edge docs.

## Changes in this PR

- Added customer-editable role → permission mapping under **Admin → Authentication**. Three roles ship by default — **Admin** (full access), **RoleMiner** (read + Excel/CSV export + the ability to mint read-only `fgr_` API keys for PowerQuery / BI), **Servicedesk** (read-only). Role names in the matrix must match the `Value` strings configured on the Entra app registration's app roles.
- Customers can add their own role names alongside the seed three (one row per Entra app role) and tick which catalog permissions each role grants. Catalog covers read, Excel/CSV export, read-API-key generation, tag / category / risk / certification writes, and the various admin areas (crawlers, systems, LLM, context plugins, CSV import, feature flags, auth itself).
- Excel export buttons (Matrix, Business Roles), the Admin top-level tab, the Admin sub-tabs, and the PowerQuery read-key UI now hide when the signed-in user lacks the matching permission, so Servicedesk operators don't see controls that would 403 on click.
- API enforcement is layered: every mutating / exporting / admin endpoint is gated server-side regardless of what the UI shows, so a leaked or replayed request can't bypass the page-level hiding.
- Backwards compatible — installs that haven't saved a role mapping AND users whose JWT carries no `roles` claim both fall back to "full access," so upgrades don't break existing setups. Enforcement starts the moment you assign Entra app roles to users + save a mapping.
- Self-lockout guard: the save endpoint refuses any change that would strip the editing user's own `admin.auth` permission — there's no path to lock yourself out of the role mapping page short of direct DB access.
- New endpoints: `GET /api/auth-me` returns the calling user's resolved roles + permissions; `GET/PUT/DELETE /api/admin/roles` reads and edits the mapping (gated by `admin.auth`).

## Changes in this PR

- Disabled the Issue Triage & Auto-fix GitHub Actions workflow (no longer triggers on new issues or nightly schedule).

## Changes in this PR

- Fixed: the worker container's job queue silently went dead if it couldn't find the built-in API key within 5 minutes of starting. The intended behaviour (per the comment in `scheduler.ps1`) was "poll until file appears", but the loop bailed after 60 retries and the main job-tick then no-op'd forever. We hit this on a fresh Docker install where the web container's first bootstrap failed (bad master key length) and was fixed via `up -d --force-recreate web` — by the time web wrote the key, worker had given up, and every crawler the user configured afterwards sat in `queued` with nothing to pick it up. Worker now re-checks the key file on every poll tick, so the queue self-heals once web writes it. Startup keeps the 5-minute "loud warning" window for the common misconfiguration case (volume not shared between web and worker), and the warning now explains both root causes instead of just shrugging.

## Changes in this PR

- Fixed: enabling Entra ID auth on a Docker install via env vars (the natural pattern for the README's `Quick Start → Option A`) silently dead-ended in a "setup required" loop. `docker-compose.prod.yml` was wiring `AUTH_ENABLED` through to the web container but had `AUTH_TENANT_ID` and `AUTH_CLIENT_ID` commented out. So someone setting all three in their `.env` would see `AUTH_ENABLED=true` reach the container while the two IDs got dropped on the floor, leaving the API to report `{ enabled:true, configured:false }` and the SPA to render the "Entra ID setup required" page even though everything was filled in. Both vars are now wired through with `${VAR:-}` defaults — behaviour for anyone who hasn't set them is unchanged.

## Changes in this PR

- Improved Vite hot-module reload: non-component exports (hooks, constants, helper functions) moved out of component files so fast refresh works without full page reloads during development
- Consolidated duplicate formatting utilities (duration, relative time, compact numbers, date-only) into shared formatters; removed multiple inline copies scattered across component files
- Extracted shared `ASSIGNMENT_TYPE_STYLES` constant; access packages list now correctly applies dark mode badge colors (was missing dark variants)
- Renamed `getApColor` → `getAccessPackageColor` for clarity

## Changes in this PR

- Fixed: the matrix no longer stays blank after importing the demo dataset in Docker — navigating to the Matrix tab now picks up the newly loaded data and auto-applies the default filter without requiring a page refresh.

## Changes in this PR

- The Image Channels, Environment Variables (Docker Setup), Quick Install (index), and Config File Reference sections in the docs now show separate Linux/macOS and Windows (PowerShell) commands, consistent with the rest of the documentation
- Release notes for new versions are now generated automatically from the changelog instead of using GitHub's default auto-generated PR list

## Changes in this PR

- Release notes for new versions are now generated automatically from the changelog instead of using GitHub's default auto-generated PR list

## Changes in this PR

- Fixed cut-beta and cut-release workflows failing because `app/desktop/package.json` was missing
- Fixed portable ZIP build failing on Linux CI due to esbuild binary being invoked incorrectly
- Fixed cut-beta and cut-release CI running on Node 20 instead of Node 24 to match the bundled node.exe

## Changes in this PR

- Fixed cut-beta and cut-release workflows failing because `app/desktop/package.json` was missing

## Changes in this PR

- Added portable Windows launcher (`IdentityAtlas-portable.zip`) — runs Identity Atlas on any Windows PC without Docker. Unzip and run `Start-IdentityAtlas.ps1` with PowerShell 7.
- Bundled launcher uses the official signed `node.exe` from nodejs.org (OpenJS Foundation certificate), making it compatible with corporate WDAC / application-control policies that block unsigned executables.
- PostgreSQL data is stored in `%APPDATA%\IdentityAtlas\` using PGlite (WebAssembly PostgreSQL) — no subprocess spawned, no executable written to disk at runtime.
- PowerShell crawlers (Entra ID, CSV) are supported as a soft dependency: requires `pwsh.exe` on PATH.
- Fixed: matrix view data was not shown after first data load in portable mode (`pg_class.reltuples` is always 0 in PGlite; dashboard now falls back to an exact `COUNT(*)` when running in desktop mode).
- Fixed: migrations that partially applied (PGlite DDL transaction quirk) no longer cause the server to abort on restart — objects that already exist are recorded as applied and the server continues.
- Fixed: crawler jobs failed to start in portable mode — `Invoke-CrawlerJob.ps1` now accepts the crawler config as either a hashtable (Docker scheduler) or a JSON string (desktop worker), so both callers work correctly.
- Fixed: demo, Entra ID, and CSV crawler jobs failed in portable mode because `Invoke-CrawlerJob.ps1` used hardcoded `/app/` paths; it now resolves scripts relative to `$env:IA_APP_ROOT` (set by the launcher) with `/app` as the Docker fallback.
- Fixed: UI was not served when the zip was extracted to a non-standard path — the Express app now uses the `FRONTEND_DIST` env var set by the launcher instead of a hardcoded relative path that resolved incorrectly inside the esbuild bundle.
- Fixed: portable launcher now starts cleanly on fresh machines — resolved a WASM crash triggered by `CREATE EXTENSION pg_trgm` conflicting with the extension loaded at PGlite init, and a missing CJS compatibility shim in the esbuild bundle that prevented Express from loading.
- Fixed: matrix was empty after loading demo data in portable mode — two causes: (1) `REFRESH MATERIALIZED VIEW CONCURRENTLY` is not supported by PGlite's single-process WASM runtime, desktop mode now always uses plain `REFRESH`; (2) a legacy boolean→integer coercion in the ingest normalizer produced values PGlite rejects for `boolean` columns — booleans are now passed through as-is.
- Fixed: crawler job trace logs were silently lost in portable mode — the dispatcher and API now resolve the log directory from `$env:TRACE_DIR` / `TRACE_DIR` env var (set by the launcher) rather than the hardcoded Docker path `/data/uploads/jobs`.
- Fixed: build script now passes PowerShell commands as an argument array via `execFileSync` instead of shell-interpolating them, preventing backslash characters in paths from being silently dropped.

## Changes in this PR

- Fixed boolean values being incorrectly coerced to integers (0/1) during data ingest, causing failures on strict boolean columns
- Crawler job dispatcher now resolves script paths via `IA_APP_ROOT` environment variable, allowing the worker to run from any installation directory instead of requiring a fixed `/app` path
- Crawler job trace logs and CSV upload paths now respect `TRACE_DIR` and `UPLOAD_ROOT` environment variables, removing the hardcoded Docker paths `/data/uploads/jobs` and `/data/uploads`

## Changes in this PR

- Fixed broken links in architecture docs — source-code cross-references now point to GitHub URLs so the MkDocs strict build succeeds and docs deploy correctly to GitHub Pages.

## Changes in this PR

- Fixed noisy PostgreSQL ERROR log entries on first boot caused by `REFRESH MATERIALIZED VIEW CONCURRENTLY` being attempted before the materialized views were populated; the refresh now checks `pg_matviews.ispopulated` and skips `CONCURRENTLY` on the initial run.

## Changes in this PR

- Fixed: Matrix "Apply" button was disabled when no conditions were added to the wizard, making it impossible to create a matrix without first setting filters. The matrix now loads all subjects and resources when applied with no conditions.
- Fixed: Matrix tab showed a "Create matrix" call-to-action even when the database contained no data. It now shows a "No data available yet — run a crawler" message instead, and the wizard no longer auto-opens when there is nothing to display.
- Improved: Demo dataset (`Ingest-DemoDataset.ps1`) now seeds a default matrix filter so the Matrix tab opens straight to data on first visit, without requiring the wizard.
- Improved: Matrix wizard now warns when the selected slice exceeds 5,000 assignments and blocks Apply above 25,000, preventing accidentally loading very large datasets.

## Changes in this PR

- Security: bumped API dependencies to address npm audit high-severity finding (tmp path traversal).

## Changes in this PR

- Security: bumped postcss (8.5.6 → 8.5.15, moderate) and tmp (0.2.5 → 0.2.7, high) to address npm audit findings. Two remaining moderate vulnerabilities (uuid/exceljs) cannot be fixed without a breaking exceljs downgrade.

## Changes in this PR

- Fixed: assigning or removing a category on a business role from the Access Packages page silently failed — the relationship never got saved. The UI was sending the body field as `accessPackageId`, but the API expects either `resourceId` or `businessRoleId` (leftover from the v3 Access-Package → Business-Role rename). The mismatch produced a 400 that the UI's `for` loop swallowed without surfacing. UI now sends `resourceId`.
- Fixed: `POST /api/categories/unassign` still used the old MSSQL-shim syntax (`p.request().input(...).query('@param')`) from before the Postgres migration. Calls to it would throw at runtime. Converted to the Postgres `db.query(text, [params])` pattern the `assign` endpoint right next to it already uses.

## Changes in this PR

- Crawler memory footprint dropped dramatically on tenants with large sign-in volumes or many access-package assignments. The `SignInLogs` and `Governance/APAssignments` phases used to load every paginated Graph response into one in-memory array before processing — fine on a Docker host with 12 GB, OOM-killed the worker on Azure (capped at 2 GB / 4 GB on the Consumption tier of Container Apps). Both phases now pipe Graph pages through a new `Invoke-FGGetRequestStream` helper that emits items one at a time, so we aggregate as events arrive and never hold more than ~one Graph page (~1000 events) plus the aggregated state. Real-world impact: a customer's 4.5K-user / 9.9K-group tenant had 7 phase OOMs at 1 GB / 2 GB; the same shape will now run cleanly without bumping resources.
- Added `tools/powershell-sdk/graph/Invoke-FGGetRequestStream.ps1` — a streaming counterpart to `Invoke-FGGetRequest`. Same auth/retry/throttling/Retry-After semantics, but emits each `.value` item to the pipeline as pages are fetched instead of accumulating the whole result. Use it whenever the next thing you do is process items in a loop and the response can be paginated — assigning the result to a variable (`$x = Invoke-FGGetRequestStream …`) re-buffers and undoes the benefit.

## Changes in this PR

- Increased the Azure worker container's CPU and memory allowance across all size profiles. PowerShell Graph crawlers spawn one runspace per parallel task via `ForEach-Object -Parallel`, and each runspace duplicates the session state — memory pressure scales fast on real tenants. The previous tiers maxed out at 0.5 CPU / 1 GB memory even on `xl`, which OOM-killed real customer syncs (4.5K users + 9.9K groups + 3.6K service principals — a mid-size tenant). New sizing keeps the same Postgres / App Service tiering but bumps the worker substantially:

  | Profile | Web SKU | Worker (was → now) |
  |---|---|---|
  | xs | B1 | 0.25 CPU / 0.5Gi → **0.5 CPU / 1Gi** |
  | s (default) | B2 | 0.25 CPU / 0.5Gi → **1 CPU / 2Gi** |
  | m | S1 | 0.25 CPU / 0.5Gi → **1 CPU / 2Gi** |
  | l | P1v3 | 0.5 CPU / 1Gi → **2 CPU / 4Gi** |
  | xl | P2v3 | 0.5 CPU / 1Gi → **2 CPU / 4Gi** |

  Marginal cost is small (~€5-15/month per tier) compared with the cost of debugging an OOM crash halfway through a customer's first sync. Existing deployments aren't affected automatically; redeploy or run `az containerapp update --name <worker> --resource-group <rg> --cpu 2.0 --memory 4.0Gi` to bump an existing worker.

## Changes in this PR

- Azure deployments now ship with Entra ID auth turned **on from the first deploy**. The Bicep template sets `AUTH_ENABLED=true` and creates `AUTH_TENANT_ID`/`AUTH_CLIENT_ID` env vars as empty strings. After Step 1 of the walkthrough, opening the deployed Web App's URL shows an **Entra ID setup required** page with the exact remaining steps (register the App in Entra, expose an `access` scope, paste tenant + client IDs into the Web App's Environment variables blade). The previous "open mode after Step 1, then add auth in Step 2" flow is gone — there's no usable unauthenticated state at any point in the install, so a customer can't accidentally end up running an internet-exposed deployment with no sign-in.
- The setup-required page is rendered by the SPA's `AuthGate` when `/api/auth-config` returns `{ enabled: true, configured: false }` — a new `configured` field is true only when both tenant and client IDs are populated. The page shows the current origin (so the redirect-URI step is copy-paste), inlines the same Entra-app-registration walkthrough that's in [docs/architecture/azure-deployment-walkthrough.md](docs/architecture/azure-deployment-walkthrough.md), and adapts the "where to put the IDs" instructions to whether you're running on Azure App Service or a Docker host.
- Local Docker installs are unaffected: `AUTH_ENABLED` still defaults to `false` for `docker compose` deployments. The auth-required-by-default behavior is an Azure-deployment thing.

## Changes in this PR

- Added a **Cut Beta** GitHub Actions workflow (`Actions → Cut Beta`) to publish pre-release Docker images tagged `:beta` and the exact version (e.g. `5.3.0-beta.1`) without touching `:latest`. Users on `docker-compose.prod.yml` are unaffected.

## Changes in this PR

- Fixed: on a fresh Azure deployment, migration `013_matrix_matviews_and_indexes.sql` failed at `CREATE EXTENSION pg_trgm` because Azure Postgres Flexible Server requires the extension to be allow-listed via the `azure.extensions` server parameter before any user can install it. The migration runner aborts the pending batch on failure, so 16 later migrations (including the one that adds `nextRunMode` to `CrawlerConfigs`) also got skipped. Symptom was "Failed to create job" when clicking Run on a crawler in the UI. The Postgres Bicep module now sets `azure.extensions=PG_TRGM` via a `Microsoft.DBforPostgreSQL/flexibleServers/configurations` resource, so future deploys never hit this.
- Fixed: the Docker worker's crawler API key (`fgc_…`) was being rejected by `authMiddleware` before reaching `crawlerAuthMiddleware`, so `POST /api/crawlers/jobs/claim` returned 401 every 30 seconds and the worker never picked up queued jobs. This was an over-correction from the admin-bypass hardening in #160 — `authMiddleware` is mounted on `/api/*` ahead of `crawlerAuthMiddleware` in `index.js`, so worker requests hit the unconditional `fgc_` rejection first. `authMiddleware` now passes `fgc_` tokens through to the next middleware on `/api/crawlers/*` and `/api/ingest/*` (the two prefixes downstream-mounted with `crawlerAuthMiddleware`), while still rejecting them on every other admin/UI path. The original admin-bypass concern stays addressed.

## Changes in this PR

- Added a one-click **Deploy to Azure** button to the README. Provisions a complete production-grade Identity Atlas stack on Azure in ~15 minutes via Bicep: VNet-isolated Container Apps Environment (web + worker), Postgres Flexible Server with a private endpoint, Key Vault holding the master key and DB password, ACR with both images auto-imported from `ghcr.io`, Azure Files share for `/data/uploads`, Log Analytics, and three managed identities scoped via RBAC.
- New `azure/` directory holds `main.bicep` (orchestrator), eleven focused module Bicep files (network, identities, ACR, DNS, Key Vault, Postgres, storage, Container Apps Environment, web app, worker app, bootstrap deployment-script), the compiled ARM JSON used by the Deploy-to-Azure button, an example parameters file, a `deploy.ps1` CLI fallback, and `import-image.ps1` for refreshing images later.
- Estimated cost: ~€100–110/month (West Europe, ex VAT, single-replica, no HA). Full architecture, decisions taken, and ops notes in [docs/architecture/azure-deployment.md](docs/architecture/azure-deployment.md).
- Reworked the Azure deployment to a much simpler "Simple" shape: App Service for Linux Containers (web) + Postgres Flexible Server (public endpoint, firewall-restricted) + Container Apps Environment (worker, always-on) + Storage Account / Azure Files / Key Vault / Log Analytics. No VNet, no private endpoints, no public IPs or load balancers we provision — anyone with Azure-subscription-owner rights can deploy without involving central networking teams. Replaces the previous VNet-isolated shape (saved as a future "Isolated" template for tenants who want it).
- One-click **Deploy to Azure** button still works. The deploy form now asks for a **size profile** (xs / s / m / l / xl) ranging from ~€45/mo (demo) to ~€469/mo (enterprise). Default `s` (~€79/mo) is sized for small production tenants and feels snappy under normal concurrent use.
- **Bring-your-own Log Analytics**: provide an existing workspace resource ID (or workspace customer ID + shared key as a fallback) and the deployment forwards all logs there instead of creating a new workspace. Saves the ~€3-5/mo line and matches enterprise CCoE patterns.
- Deployment time dropped from ~15 minutes to ~5-7 minutes. Architecture, decisions, scaling, and ops notes documented in [docs/architecture/azure-deployment.md](docs/architecture/azure-deployment.md).
- Fixed: the App Service was being deployed with the Postgres password under the wrong env var name (`POSTGRES_ADMIN_PASSWORD`), so the API could not connect to the database after a fresh deploy. The env var is now `POSTGRES_PASSWORD`, matching what `app/api/src/db/connection.js` reads.
- **Entra ID authentication is now ON by default for Azure deployments.** The deploy form has three new fields: `enableEntraAuth` (default TRUE), `entraTenantId`, and `entraClientId`. If `enableEntraAuth=true` but tenant/client are blank, the deploy now fails fast in the bootstrap step with a clear message — so you can't accidentally publish an open-to-the-internet instance. Set `enableEntraAuth=false` explicitly to deploy in OPEN mode for short-lived demos.
- On Azure App Service, the Admin → Authentication and Admin → Containers tabs are now hidden. They both assume a Docker host you can reach; on Azure neither is reachable in the same way, and on Azure auth is enforced via Bicep parameters at deploy time anyway.
- The deploy form now has an `imageChannel` dropdown: **stable** (default, tracks the last `:latest` release tag) or **edge** (tracks every main-branch build via `:edge`). Replaces the previous free-form image fields. Advanced users can still pin to a specific image via `webImageOverride` / `workerImageOverride`.
- Added a portal-only deployment walkthrough at [docs/architecture/azure-deployment-walkthrough.md](docs/architecture/azure-deployment-walkthrough.md). It uses a two-pass deploy pattern — first deploy claims the name in OPEN mode so you can confirm the hostname before creating the Entra App Registration; second deploy turns auth on with the IDs filled in. Avoids wasting App Reg setup work on a name collision.
- Simplified the deploy form to just the happy-path fields: `namePrefix`, `sizeProfile`, `imageChannel`, `existingLogAnalyticsWorkspaceId`, `entraTenantId`, `entraClientId`. Removed ten advanced fields (`location`, `webImageOverride`, `workerImageOverride`, `existingLogAnalyticsCustomerId`, `existingLogAnalyticsSharedKey`, `webAllowedIpCidrs`, `bootstrapForceTag`, `postgresAdminPassword`, `entraRequiredRoles`, `enableEntraAuth`) — region is taken from the resource group, the rest are settable by editing the Bicep or post-deploy from the Web App's Environment variables blade.
- The `enableEntraAuth` toggle is gone; auth state is derived from whether the Entra IDs are filled in. Both blank = first-pass OPEN deploy that claims the hostname; both filled = auth ON. Filling in only one is rejected with a clear error. Less form clutter and one fewer decision for a first-time deployer.
- Input validation now runs in the bootstrap step **before** any module tries to use the values, so a typo fails the deploy in under a minute with a clear error instead of producing a half-built resource group. Validates: the existing Log Analytics workspace ID (when provided) is a full workspace resource ID — not the parent resource group's ID, which was a real-world mistake we hit.
- **Deployment is now two separate templates with non-overlapping concerns.** `main.bicep` deploys the app stack in OPEN mode (no auth); a new `main-auth.bicep` layers Entra ID auth onto an existing deployment by patching only the App Service's app settings. Both have their own Deploy-to-Azure button. The auth template never touches Postgres, Key Vault, or any other resource — so the previous failure modes around re-deploying the same template (Postgres storage-shrink errors, half-applied changes) are gone. Each template's form has only the fields it actually needs.
- `namePrefix` is now auto-generated and deterministic per resource group (`idatlas-` + 7-char hash of the RG ID) — and no longer a parameter, so it doesn't show up in either deploy form. Both templates derive the same prefix when deployed to the same RG, so Step 2 finds the App Service Step 1 created without any input. Customizing the hostname requires editing the Bicep — uncommon enough that the friction reduction is worth it.
- Step 2's auth patch now uses a deployment-script (`az webapp config appsettings set`) instead of a `Microsoft.Web/sites/config` Bicep resource. The Bicep-native approach hit an ARM circular-dependency error — read existing settings + write to the same resource triggers ARM's cycle detector, even though the operations are sequential. `az webapp config appsettings set` is a true merge (adds/updates only the named keys without touching the rest), so it sidesteps the need to read at all. The script reuses Step 1's existing deployment-script managed identity and grants it Website Contributor scoped to just the one App Service.
- Added a **Trends** tab to the Dashboard page. Plots the % of assignments that are governed over time, plus separate charts for users, resources, and assignments growth.
- The chart starts populated on the day this version ships and grows as new days are captured. The scheduler writes one snapshot per UTC day to the new `DashboardSnapshots` table — no historical backfill, so the early section reflects only the snapshots actually captured (not a reconstructed history).
- Range selector switches between 30 days / 90 days / 1 year / 2 years. Charts render as hand-rolled SVG; no new frontend dependency.
- Added Playwright e2e coverage for the new Dashboard tab strip and Trends tab: verifies tab switching, chart container presence, and the range selector behaviour.
- New `docs/architecture/dashboard-trends.md` documents the snapshot architecture, the no-backfill decision, the API surface, and the chart rendering details.
- Pointers in `app/ui/CLAUDE.md` so future AI contributors find the new components.

## Changes in this PR

- Fixed inconsistent docker startup commands: all documented `docker compose up` invocations now consistently use `--pull always` to ensure the latest image is pulled on every start.

## Changes in this PR

- Fixed security vulnerability: crawler API keys (`fgc_`) were incorrectly passed through JWT auth middleware, allowing any string with the `fgc_` prefix to reach admin endpoints without valid credentials.

## Changes in this PR

- Fixed CodeQL alert 50: replaced plain null-prototype object with `Map` in ingest normalization to eliminate remote property injection risk from user-supplied field names.

## Changes in this PR

- Fixed remaining CodeQL warnings: removed unused internal helper functions, eliminated a TOCTOU file-system race in the job-log endpoint, and hardened ingest normalization against prototype-injection via user-supplied property names.

## Changes in this PR

- Fixed log-injection vulnerability in ingest validation logging — only the record count is logged, never user-supplied content
- Fixed client-side request-forgery risk in the authentication context default — the fallback stub no longer calls fetch
- Fixed server-side request-forgery in the risk-profile scraper routes — added inline CodeQL suppression with evidence of the existing mitigation in `scraper.js` (http(s) only, private/loopback hosts blocked)
- Fixed server-side request-forgery risk in the Azure OpenAI provider by adding inline CodeQL suppression with evidence of the existing `validateAzureEndpoint` mitigation (HTTPS required, private/loopback hosts blocked)

## Changes in this PR

- Removed unused imports and variables flagged by CodeQL across API route files (admin, contexts, correlationRulesets, details, governance, permissions, resources, tags), ingest engine and sessions, and the secrets vault
- Removed unused variable declarations in Playwright end-to-end test files (access-packages, detail-pages, identities, matrix, multi-filter)
- Removed unused state setter in RiskScoringPage

## Changes in this PR

- Fixed log injection in context plugin dry-run and ingest routes by sanitising user-controlled values before logging
- Fixed remote property injection in ingest normalisation by iterating the trusted column set instead of request-supplied keys
- Hardened CORS configuration: replaced permissive wildcard origin with an explicit localhost allowlist for development; production defaults to same-origin only
- Added rate limiting to the SPA HTML fallback route
- Added tenant ID format validation in MSAL AuthGate to prevent client-side request forgery via a crafted server config response

## Changes in this PR

- Fixed SSRF vulnerabilities in LLM web scraper and Azure OpenAI provider by blocking requests to private/loopback addresses
- Upgraded API key hashing from SHA-256 to scrypt (PBKDF) with automatic legacy key detection and migration on startup
- Fixed path traversal vulnerability in job log endpoint using path containment check
- Fixed TOCTOU race conditions in master key file handling and CSV folder detection
- Fixed regex polynomial ReDoS in Azure OpenAI endpoint URL handling
- Fixed bad HTML tag filter patterns in LLM scraper (script/style/nav block stripping)
- Fixed double-escaping of HTML entities in LLM scraper text extraction

## Changes in this PR

- Fixed WCAG 2.0 AA contrast failures in MatrixFilterWizard: separator characters, percentage labels, orientation labels, hint text, and delete button labels were rendered in gray-300/400 (failing contrast) and upgraded to gray-500/600
- Fixed low-contrast "all" placeholder and loading indicator in MatrixFilterSummary
- Fixed SVG axis label color in TimeSeriesChart (gray-500 → gray-600, from ≈4.6:1 to ≈7.5:1 margin)
- Fixed remaining pre-existing contrast violations across 44 UI components (gray-400/300 text on light backgrounds, blue-400 and red-400 status text)
- Added ESLint rule `local/no-low-contrast-text` that blocks Tailwind `text-{color}-300` and `text-{color}-400` classes in JSX `className` attributes, enforcing WCAG 2.0 AA compliance at build time

## Changes in this PR

- Fixed matrix view crash ("Something went wrong / Cannot read properties of undefined") caused by a bad rebase conflict resolution in the CodeQL fixes PR (#148) that accidentally reverted the MatrixView.jsx wizard refactor from PR #147

## Changes in this PR

- Fixed six CodeQL code-scanning alerts: unused loop variable, misleading string concatenation, useless initial assignment, unused dead-code variable, and two unused variables in e2e tests

## Changes in this PR

- Added a **Trends** tab to the Dashboard page. Plots the % of assignments that are governed over time, plus separate charts for users, resources, and assignments growth.
- The chart starts populated on the day this version ships and grows as new days are captured. The scheduler writes one snapshot per UTC day to the new `DashboardSnapshots` table — no historical backfill, so the early section reflects only the snapshots actually captured (not a reconstructed history).
- Range selector switches between 30 days / 90 days / 1 year / 2 years. Charts render as hand-rolled SVG; no new frontend dependency.
- Added Playwright e2e coverage for the new Dashboard tab strip and Trends tab: verifies tab switching, chart container presence, and the range selector behaviour.
- New `docs/architecture/dashboard-trends.md` documents the snapshot architecture, the no-backfill decision, the API surface, and the chart rendering details.
- Pointers in `app/ui/CLAUDE.md` so future AI contributors find the new components.

## Changes in this PR

- Added a new crawler phase that imports application role assignments from Entra ID. For each enterprise app the crawler pulls the catalog of `appRoles[]` and the `appRoleAssignedTo` list, then writes one `AppRole` resource per (app, role), an `Application → AppRole` relationship, and one `ResourceAssignment` per user assignment. Group-typed assignments are expanded to per-user `AppRoleViaGroup` rows via `/transitiveMembers` so the matrix surfaces indirect access too.
- Wired up the existing "Apps & AppRoles" checkbox in the Crawlers wizard so toggling it actually runs the new phase. Requires `Application.Read.All` on the app registration (already required for service principals; the permission validator was already enforcing it).
- New matrix badges: `R` (App Role — direct) and `R` in a lighter shade (App Role — via group), so analysts can tell direct vs inherited app-role access at a glance.
- The dev `docker-compose.yml` now sets `restart: unless-stopped` on the postgres and web containers (the worker already had it; the prod compose file already had it for all three). After a host reboot, a Docker daemon restart, or an unexpected crash, the whole stack now auto-recovers without needing a manual `docker compose up -d`.
- Expanding a group in the matrix now fans out **any** resource that group is assigned to, not just nested parent groups. App roles a group grants its members appear as expanded sub-rows, with cells showing each user's `Indirect` (via this group) and/or `Direct` membership of that role. Previously only group-in-group nesting was visible.
- The crawler now writes the group→AppRole assignment itself (alongside the per-user expansion), so the relationship is queryable directly rather than reconstructed from the user-level rows. An idempotent backfill from existing `AppRoleViaGroup` data is applied automatically on the next bootstrap.
- Fixed three CI regressions on the PR:
  - Matrix matview `REFRESH` failed on large datasets after the badge-collapse migration when a single `(resourceId, principalId)` had both a `Direct` and a `Governed` row (or any other two rows that collapsed to the same `membershipType`) — both ended up at the unique index. Migration 026 dedupes via `GROUP BY (resourceId, principalId, membershipType)` with `bool_or` on `managedByAccessPackage`.
  - Playwright matrix test now walks the wizard (it used to wait for a table directly; the matrix tab now lands on an empty state until a filter is applied). Two other tests' `Matrix` button selectors gained `exact: true` so they don't match the wizard's "Create matrix" button.
  - Added a permissive authenticated-API rate limiter (600 req/min per IP) so `app.use('/api', authMiddleware, …)` no longer trips CodeQL's "authorization without rate limiting" rule.
- Fixed: user detail page showed "Identity 0" even when the user was linked to an Identity. The backend was 500-ing on `/api/identities/by-user/:userId` because the secondary query referenced columns (`userId`, `userPrincipalName`) that don't exist on `IdentityMembers`. The query now correctly joins to `Principals` to surface the UPN.
- Restored the matrix row-expand button on groups that have nested groups. The `/api/groups-with-nested` and `/api/group/:id/nested-groups` endpoints filtered `principalType LIKE '%group%'` — PostgreSQL `LIKE` is case-sensitive, and the data stores `principalType='Group'` (capital G), so the filter never matched and the UI thought no groups had nested members. Switched to `ILIKE` so case is irrelevant (same fix pattern as the recent Tag-all-matching repair).
- Fixed: on the user detail graph, the OAuth2 Grants fanout collapsed every consent into a single "Microsoft Graph PowerShell" node (the client app), and clicking it opened the client app instead of the scope. The fanout now shows one node per granted scope (e.g. "User.Read.All on Microsoft Graph"), and clicking opens the scope's Resource detail page so the actual permission and its consent metadata are visible.
- Fixed the search box on every Risk Scoring subpage (users / resources / business roles / org units / identities). The queries used `LIKE` (case-sensitive in postgres) on unquoted camelCase columns (`p.displayName` rather than `p."displayName"`) — so typing into the search field returned zero rows whether the data matched or not. Five queries flipped to `ILIKE` with proper identifier quoting. Caught by the new postgres-LIKE audit test.
- Fixed: "Tag all N matching" on the Users/Resources/Identities pages did nothing. The bulk-by-filter endpoint had been silently broken since the v5 postgres migration — it still referenced the dropped temporal `ValidTo` column, used the SQL-Server-specific `@@ROWCOUNT` system variable, and left camelCase column/table names unquoted (which postgres lowercases). The endpoint now reports the real inserted count and works against the postgres schema. Search is also now case-insensitive (`ILIKE`).
- The matrix now shows every type of user/resource assignment by default — OAuth2 grants, governed business-role assignments, and any future assignment type are no longer silently dropped. Previously only Direct/Owner/Eligible/Governed memberships flowed through. As a result you'll see new rows for delegated permissions, application roles, and similar resources for the principals that have them.
- Added matrix cell badges for Governed (G) and OAuth2 Grant (A) so cells that carry those membership types render with a labelled badge instead of a generic `?`.
- Replaced the Matrix tab's inline filters with a three-step filter wizard. The matrix stays empty until a filter is applied, removing the "Top 25 most-permissioned users tenant-wide" default that often hid the slice analysts actually wanted to see.
- Step 1 picks the row type — **User × Resource** (one row per account) or **Identity × Resource** (one row per correlated person, with cells unioned across the identity's accounts).
- Steps 2 and 3 narrow the subjects and resources with include/exclude conditions on **contexts** (with optional "include descendants") and **attribute values** (any column from Principals / Identities / Resources, plus `ext.*` keys inside `extendedAttributes`).
- Every step shows live counts: subject count vs. total, resource count vs. total, and the resulting number of assignments — so the size of the sub-selection is always visible while building the filter.
- Filters can be **saved org-wide** under a name, loaded again from a dropdown at the top of the wizard, and **shared** via the Matrix tab's "Share Link" button (the entire filter is encoded in the URL).
- Dropped from the Matrix toolbar: the User slider, search box, "User Filters" bar, context-filter chip bar, and the Type/Tags column-header filter dropdowns. All of those are subsumed by the wizard. IST / SOLL / Managed / Gaps toggle, Excel export and Share Link stay.
- Added an "Adjust filter" button to the toolbar that re-opens the wizard pre-populated with the current filter.
- New backend endpoints (`POST /api/matrix/data`, `POST /api/matrix/preview`, `GET /api/matrix/columns`, and `GET|POST|PUT|DELETE /api/matrix/saved-filters`). The legacy `GET /api/permissions` endpoint stays for backward compatibility, but new flows always go through `/api/matrix/data`.
- New `SavedMatrixFilters` table (migration 023) for the org-wide named filters.
- The matrix badge column now reports only *how* a user holds a resource (D / I / O / E), not the source of the assignment. Business Role assignments, OAuth2 consents, and direct app-role assignments all render as **D** (Direct) — the user holds these directly; the fact that they came through a governance process or a user consent is already conveyed by the resource type and (for governed rows) by the cell's Access-Package coloring. App-role assignments inherited via group membership render as **I** (Indirect).
- Test coverage caught up with the recent additions: ingest validation tests cover the new `assignmentType` values (`OAuth2Grant`, `AppRole`, `AppRoleViaGroup`) and the new `relationshipType` (`HasAppRole`); the nightly Entra crawler test asserts that app-role resources are reachable, the `/identities/by-user` endpoint responds 200, and the matrix view's `membershipType` column never leaks a source-attribute type.
- Added a static-analysis test that fails the build if any route handler reintroduces a plain `LIKE` (instead of `ILIKE`) on a column where case-insensitivity was historically load-bearing — the same SQL-Server-vs-postgres footgun bit three different endpoints during the v5 migration.
- Docs caught up too: `CLAUDE.md` no longer points at the deleted `Sync-FGEntraAppRoleAssignment.ps1`, the resource-type and relationship-type tables now list `AppRole`, `Application`, `DelegatedPermission`, `HasAppRole`, `DelegatesScope`. New `docs/architecture/matrix.md` consolidates the matrix grid model — badge collapse rules, why groups don't appear as columns, expand semantics — that was previously spread across migration comments. The ingest-API doc lists the current enum values.

## Changes in this PR

- Split CLAUDE.md into per-area subdirectory guides (Functions/, app/api/, app/ui/) so only relevant conventions are loaded per context; root file reduced from 1110 to 251 lines
- Moved open maintenance items to docs/maintenance-backlog.md; removed all resolved entries

## Changes in this PR

- Added a three-way Theme toggle (Light / Auto / Dark) to the settings dropdown, replacing the previous on/off switch. The "Auto" setting follows the OS color scheme and updates live when the system preference changes. Existing dark-mode preferences are automatically migrated on first load.
- Fixed WCAG 2.0 AA contrast violations in tag and category badge colors: all ten colors were replaced with darker equivalents, achieving a minimum 4.5:1 contrast ratio.
- Fixed additional WCAG 2.0 AA contrast violations across the UI: "missing permissions" text (red-400 → red-600), "core" attribute label (indigo-500 → indigo-700), staleness indicator colors (amber-600/blue-500 → amber-700/blue-700), empty-state dashes and separators (gray-400 → gray-500), "No changes recorded" text, close button icons, "Identity not found" text, and the risk tier "None" badge label (gray-400 → gray-500).

## Changes in this PR

- Added `.gitattributes` to enforce LF line endings on all text files, preventing CRLF from being introduced on Windows checkouts

## Changes in this PR

- CI automation (version bumps, releases, hotfixes) now authenticates via the Fortigi CI Bot GitHub App instead of a personal access token, so repository rules apply to all human contributors without exception

## Changes in this PR

- Added CodeQL static analysis scanning on all pull requests — automatically detects security vulnerabilities and code quality issues in JavaScript and TypeScript

## Changes in this PR

- Updated GitHub Actions to Node.js 24 runtime: checkout@v6, setup-node@v6, setup-python@v6, upload-artifact@v7, deploy-pages@v5, docker/setup-buildx-action@v4, docker/build-push-action@v7, docker/login-action@v4
- Updated Node.js install version in CI workflows from 20 (EOL) to 22 LTS

## Changes in this PR

- Fixed version link in footer not navigating to Admin → About when clicked from admin pages

## Changes in this PR

- Fixed "What is new" link on the dashboard — it now points to the changelog for the installed version instead of always showing the latest.

## Changes in this PR

- Fixed the Crawlers wizard incorrectly reporting `DelegatedPermissionGrant.Read.All` as missing when it had been granted. The wizard was checking for the GUID that belongs to `DelegatedPermissionGrant.ReadWrite.All`, so the real Read.All grant was never detected. `ReadWrite.All` is now correctly recognised as a superset of `Read.All`.
- Fixed the Entra ID crawler silently dropping OAuth2 delegated-grant resource-relationships (every consent was rejected with a 400). The validation whitelist was missing `DelegatesScope`, the relationship type introduced with the OAuth2 grants feature.
- Fixed the Entra ID crawler silently failing every `assignmentPolicies` fetch (so Access Packages showed blank Type/Review columns). Microsoft removed the `assignmentPolicies` segment from the `/beta` Graph surface — the call now goes via `/v1.0` (which still exposes it). The unused `$expand=accessPackage` and `$top=999` parameters were also dropped; `accessPackageId` is already on the base object, and this endpoint rejects `$top`.
- Fixed the Entra ID crawler dropping OAuth2 delegated-grant *assignments* with a 400 error. The `ASSIGNMENT_TYPES` validation whitelist was missing `OAuth2Grant`, the assignment type introduced with the OAuth2 grants feature. (Sibling fix to the `DelegatesScope` relationship-type entry.)
- Sign-in log sync now slices the window into 1-day chunks instead of fetching the whole 7-day window as one request. A single expired `$skiptoken` (Graph returns 400 mid-pagination on long slow fetches) used to abort the entire phase — now it loses one day, not the week, and the rest still ingests.
- Fixed the `/identities/by-user/:userId` endpoint returning 500 errors. It referenced column names (`primaryAccountUpn`, `primaryAccountId`) that only exist as aliases in other queries — now reads the real columns (`email`, `primaryPrincipalId`) and aliases them consistently.
- Entra ID crawler now fails the job (with a summary message) when any main sync phase errors out. Previously the crawler reported "completed successfully" even after several 400 responses had silently dropped entire object types.
- Sped up large ingests (e.g. 250k group memberships on a first-run tenant) by sending 1000 rows per INSERT statement instead of 200. The improvement is partially offset on first-run tenants by the new audit-history trigger now actually firing for these tables (previously it silently did nothing), so real-world wall-clock savings depend on whether history is in use — but statement count into Postgres is cut 5×.
- The nightly Entra ID test now asserts every permission returned by the wizard's validate endpoint is granted (catches GUID-mapping regressions like the one above), and the Full-Sync scenario enables every Entra object type — including Service Principals, PIM, Sign-in Logs, and OAuth2 Delegated Grants — with per-type presence checks on the resulting data.
- Crawlers wizard: step indicator is now clickable when editing an existing crawler — jump directly to any step instead of clicking Next repeatedly.
- Crawlers wizard: new Advanced section on the last step exposes `signInLogsDays` (1–30) and `aiNamePatterns` (extra regex fragments classifying service principals as AI agents). Previously these were only configurable by hand-editing the database.
- Added Export and Import buttons on the Crawlers page. Export downloads a crawler's configuration as JSON with the client secret stripped — safe to commit to a repo or share across tenants. Import opens the wizard pre-populated with the exported values; the user only has to re-enter the client secret.
- Fixed blank page when browsing the stack over plain HTTP (e.g. a dev VM on `http://hostname:3001`). The `upgrade-insecure-requests` CSP directive and Strict-Transport-Security (HSTS) header are now only emitted when `BEHIND_TLS=true` is set, i.e. when a TLS terminator sits in front of the container. Plain-HTTP deployments no longer have their asset URLs silently rewritten to HTTPS.
- Fixed scheduled Entra ID crawler runs failing with `400 Bad Request` on the first delta-mode day after the delta token was primed. Graph's `/users/delta` returns only the fields that changed per record, so the ingest API would reject records missing `displayName` and silently null every unchanged field on the ones that got through. The server now does `COALESCE(EXCLUDED.col, existing.col)` on delta upserts and skips the required-field check for delta payloads.
- Ingest validation errors are now logged with the first few concrete record-level errors (field name + reason), not just a count. Previously a 400 on the worker produced `"5 record error(s)"` in the web log with no hint which field was at fault.
- The Entra ID crawler now captures the response body of a non-2xx ingest API call via `$_.ErrorDetails.Message` (the PS 7 location — the old stream-read fallback was returning empty). Worker logs now show the actual validation error rather than just `"Response status code does not indicate success: 400"`.
- The Principals, Service Principals, Resources (groups) and Assignments (group members) phases are now wrapped in the same catch-and-continue pattern as the already-wrapped Sign-in Logs, PIM and Governance phases. A transient failure in one of these no longer aborts the entire crawl — the job continues to the remaining phases, and the final `phases` breakdown on the job record shows which phase(s) failed. The job still ends in `failed` state with a summary if any phase errored.
- Added a Sizing section to the [Docker Setup](docs/architecture/docker-setup.md) guide with recommended RAM and disk for small / medium / large tenants, plus a callout that activity-data sync (sign-in logs, and future audit/MFA feeds) is the dominant driver of growth — not principal or resource counts. The README now links there from Prerequisites.
- Each crawler job's full console output is now captured to `/data/uploads/jobs/{id}.log` via `Start-Transcript`, and the job-details modal on the Crawlers page has a new **Trace** tab showing the live transcript. It follows the tail while the job is running (polls every 3 s) and presents the final text once the job terminates — no more SSH-ing into the worker to see which access package is timing out or what the actual ingest 400 response body said. The 20 most recent logs are kept on disk; older ones are cleaned up on each new job.
- Fixed the Entra ID crawler skipping every access review definition in the Governance/AccessReviews phase, which surfaced in the UI as every access package showing "Pending first review" even when historical reviews existed, and 0 reviews on the dashboard. Graph's access-review scope shape evolved from a single `scope.query` to `resourceScope.query` (with `principalScope` carrying the reviewer side); the crawler only checked the old location, so every current-shape definition was silently dropped. The phase now inspects `scope.query`, `resourceScope.query`, and `scopes[].query` in turn, accepts both the path-style (`accessPackages/<uuid>`) and filter-style (`accessPackage/id eq '<uuid>'`) access-package identifiers, and logs a summary line at the end (`N total; skipped X (no scope) + Y (no AP id); kept Z`) so operators can see at a glance whether the filter is still dropping too much.
- Access review decisions fetch no longer passes `$top=999` to `/identityGovernance/accessReviews/definitions/{id}/instances/{iid}/decisions`. Graph caps that collection at 100 per page and returned 400 Bad Request for every instance — the fix earlier in this release unblocked 451 definitions, but each instance's decisions call was still failing silently, so `CertificationDecisions` stayed at zero rows. We now drop the `$top` query-string entirely and rely on `@odata.nextLink` pagination, and log the Graph response body on any remaining failures.
- The Crawlers page job list now shows a **Details** button for *every* job, not just completed/failed ones. Clicking it on a running or queued job opens the same modal with the new Trace tab live-tailing the worker's console — previously there was no way to see what a stuck-looking job was actually doing without SSH'ing into the container.
- The Governance/AccessReviews phase now emits a progress heartbeat every 25 definitions (`Access reviews: 175 of 451 definitions...`), and sets an explicit top-level step name (`Syncing access review decisions`) when it starts. The umbrella governance banner used to stay frozen on *"Catalogs, access packages, policies, reviews..."* for the full ~30 minutes the sub-phase took on a large tenant; now the UI shows actual movement.
- Fixed the Entra ID crawler's scheduled runs failing with `"records must be an array"` whenever the delta path happened to return *exactly one* changed principal or resource (every other count was fine). PowerShell's `ConvertTo-Json` silently collapses a single-element array stored as a hashtable value into a bare object (`@{records = @($user)} | ConvertTo-Json` → `{"records": {...}}` instead of `{"records": [{...}]}`), which the server's envelope validator correctly rejected. The crawler's ingest helper now wraps every array field in a `List[object]` which always round-trips as a JSON array regardless of cardinality.
- Each schedule entry can now independently specify its sync mode — **Delta (fast)** or **Full (authoritative)**. This supports the common pattern of running multiple fast deltas per day with one weekly full-refresh as a backstop (e.g. deltas at 02/08/14/20 and a full sync on Sunday at 04:00). The schedule editor shows a **Mode** dropdown per row; the worker scheduler reads the schedule's `syncMode`, falls back to the crawler's `Force full next run` override if set, and otherwise defaults to delta.
- The Recent Jobs table gained a **Mode** column showing a `full`/`delta` badge per run so you can see at a glance which scheduled runs took which path, and the job-details modal's header surfaces the same badge. Jobs queued before this change — which predate the per-schedule mode — render a `—` and continue to run in delta mode as before.
- Replaced the single **Run Now** button + separate *"Force full sync next run"* toggle on each crawler card with two explicit buttons: **Run Delta** (indigo) and **Run Full** (amber). One click queues the intended run directly — no more "set a toggle, wait for state to save, then click Run". The `POST /api/admin/crawler-jobs` endpoint accepts an optional `syncMode` body field (`"full"` or `"delta"`) for API callers; the stored `nextRunMode` column still works as a fallback for the scheduler when a schedule entry doesn't specify its own mode.

## Changes in this PR

## Context redesign (v6) — unified Contexts model + plugin framework + UI rewrite

### Data model & schema

- **Breaking (v6):** Replaced the old single-purpose `Contexts` table with a unified model: three variants (`synced` / `generated` / `manual`) and four target types (`Identity` / `Resource` / `Principal` / `System`). Membership lives in a new `ContextMembers` table. The legacy `Identities.contextId`, `Principals.contextId`, and `Resources.contextId` columns are removed; a principal can now belong to many contexts.
- New tables: `Contexts` (rewritten), `ContextMembers`, `ContextAlgorithms`, `ContextAlgorithmRuns`. The `_history` audit trigger is wired onto `Contexts`.
- Migration `019` drops the legacy `GraphResourceClusters` / `GraphResourceClusterMembers` tables (clustering is now a plugin).
- Migration `020` drops `GraphTags` / `GraphTagAssignments` and replaces them with **VIEWS** over `Contexts` + `ContextMembers`. Existing tag-JOIN queries (in `permissions.js`, `resources.js`, `details.js`) keep working unchanged. Tag IDs are now UUIDs; the UI treats them as opaque strings so no frontend change was needed.
- Migration `021` re-keys the `ix_Contexts_externalId` unique index from `(scopeSystemId, externalId)` to `(sourceAlgorithmId, scopeSystemId, externalId)` so different plugins can use the same `externalId='root'` on the same system without colliding.

### Backend — context API surface

- Rewrote `/api/contexts` routes from scratch: list / tree / detail / paginated members, plus full CRUD for non-synced contexts. `DELETE` allows manual + generated; synced is rejected. `POST/DELETE /:id/members` accept analyst writes on both manual and generated contexts (the plugin runner preserves `addedBy='analyst'` rows across re-runs).
- `GET /api/contexts/:id/members?include=descendants` walks `parentContextId` recursively and returns `DISTINCT ON (memberId)` so a subtree's members are visible in one paginated list.
- `GET /api/contexts` and `/api/contexts/tree` sort by `totalMemberCount DESC, displayName ASC` so big subtrees bubble up.
- `recalcMemberCountsForChain(id)` helper in `contexts/memberCounts.js` keeps `directMemberCount` and `totalMemberCount` accurate after every analyst write. Wired into the five paths that mutate `ContextMembers`: contexts member POST/DELETE and three tags routes (assign / unassign / assign-by-filter).
- `/api/contexts/:id` adds `contextCount` to the user/resource/identity detail responses and exposes `/api/<entity>/:id/contexts` lazy-load endpoints — the entity-detail graph uses these to populate the new "Contexts" fanout.

### Plugin framework (generated contexts)

- **Plugin contract** in `app/api/src/contexts/plugins/`: registry, runner, types. Plugins are in-tree Node modules; registered plugins seed into `ContextAlgorithms` at startup.
- **Runner** does a **two-pass FK-safe upsert** (insert with `parentContextId=NULL` first, then `UPDATE` parent links) so plugins can emit nodes in arbitrary order without hitting the parent-FK constraint.
- After every run, the runner rolls up `totalMemberCount` over the produced subtrees via a recursive CTE.
- **HTTP**: `GET /api/context-plugins`, `POST /api/context-plugins/:name/dry-run`, `POST /api/context-plugins/:name/run` (async, returns `runId`), `GET /api/context-plugins/runs`, `GET /api/context-plugins/runs/:id`.
- **Plugins shipped in this PR:**
  - `manager-hierarchy` — builds a tree from `Principals.managerId`. Node displayName is `"<Department> (<Name>)"` when available. Accepts `excludeNamePatterns` (regex array) so external-consultancy admin-managers (e.g. `\(Quanza\)`) can be filtered out persistently — their reports reattach to the synthetic root.
  - `ad-ou-from-dn` — parses an LDAP DN into a nested OU tree. Accepts a `dnField` parameter (default `extendedAttributes.onPremisesDistinguishedName`) resolved through a whitelisted SQL-expression helper.
  - `resource-cluster` — token-based clustering. Splits resource names on any non-alphanumeric, drops short/numeric/stopword tokens, creates one cluster per surviving token that appears in ≥`minMembers` resources. A resource can belong to multiple clusters. Tunable `minMembers` (default 4), `minTokenLength`, `maxTokenCoverage`, `additionalStopwords` for tenant-specific noise. See `docs/architecture/resource-cluster-algorithm.md`.
- **Plugins removed during the build** because they didn't carry their weight or weren't ready: `department-tree` (manager-hierarchy already shows department in displayName), `app-grouping-by-pattern` (`resource-cluster` does this better with no config), `business-process-llm` (stub — comes back when the LLM-call wiring lands).

### Matrix filtering by context

- New chip widget on the Matrix toolbar lets analysts pick one or more contexts to filter by, each with an "+sub" checkbox to include descendants. Filters AND together.
- `/api/permissions` accepts a `contextFilters` JSON query param. The `contexts/contextFilters.js` helper compiles the filter into SQL fragments using a recursive CTE on `parentContextId`. Identity/Principal-targeted filters constrain the row axis; Resource and System targets constrain the column axis.
- The filter is also pushed into the top-N user subquery — otherwise the matrix picked the 25 most-permissioned users tenant-wide and then intersected, leaving the view empty whenever the top-25 and the filtered context didn't overlap.
- Filter selections live in the matrix hash so filtered views can be bookmarked.

### Tags as Contexts

- Tags become a specialisation of manual Contexts (`contextType='Tag'`). The UI contract is unchanged.
- `bootstrap.js#ensureTagRoots()` runs at every container start and creates one synthetic `Tags` root per `targetType` (Principal / Resource / Identity), then reparents any orphan tag rows. New tags from `POST /api/tags` attach under the appropriate root via `getOrCreateTagRoot()`.
- The matrix `__userTag` filter and the resource detail tag chips keep working unchanged through the `GraphTags` / `GraphTagAssignments` views.
- Admin bulk-import of tags still targets the legacy table names — deferred to a follow-up because the admin-import path is scheduled for its own cleanup.

### Crawler integration

- CSV crawler (`tools/crawlers/csv/Start-CSVCrawler.ps1`) sends the new `Contexts.csv` / `ContextMembers.csv` shape and ingests them via the `/api/ingest/contexts` endpoint. The `/ingest/refresh-contexts` derive-from-`Principals.department` call is gone.
- Entra crawler no longer has a `Context` object type — context derivation is plugin work, not crawler work.

### UI — Contexts tab

- New **Contexts** tab with a two-pane layout: left selector grouped by `contextType (targetType)`, right pane with **Tree** or **List** view. Each tree node is a rounded pill with a ringed variant-colored bubble; L-shaped connector lines show the hierarchy.
- Tree + selector show **`<direct> · <total>`** member counts when a subtree carries indirect members.
- "**+ New**" on the selector opens a three-card dispatcher: Import (jumps to Crawlers), Run plugin, Create manual.
- **RunPluginModal** — picker grouped by target type, parameter form auto-generated from each plugin's `parametersSchema` (with `scopeSystemId` rendered as a system picker and array/object params editable as JSON), Dry-run preview with counts + samples, Run that queues async + opens RunDetailPage.
- **RunDetailPage** polls `/api/context-plugins/runs/:id` every 1s until terminal; shows status, reconciliation counts, parameters, and any error.
- **ManualContextEditor** — rename, set parent, set owner, edit description, delete-with-confirm. Parent picker is the new shared **ContextPicker** modal (tree + list views, search with auto-expand on match, exclude self+descendants).
- **ContextMemberPicker** — debounced typeahead hitting `/api/identities`, `/api/resources`, `/api/users`, `/api/systems` based on `targetType`. Members are addable on both manual and generated contexts; per-row Remove on each. Remove buttons on algorithm-added rows say "Remove (will return)" so the analyst knows tuning plugin parameters is needed for a persistent removal.
- **GeneratedContextActions** panel for generated contexts — Delete-with-confirm + caveat that re-running the plugin will recreate the row unless parameters change.
- **Tree-delete** button on the right-pane header lets the analyst nuke an entire tree (root + descendants + members) without drilling in.

### UI — entity detail rework

- Detail pages (User / Resource / Identity / Access Package) use a shared two-column layout: **AttributesTable** on the left (real columns + `extendedAttributes` merged), **EntityGraph** on the right.
- AttributesTable uses `table-fixed` with a 40/60 colgroup so long extension-attribute labels wrap rather than squeezing the value column. No internal scroll — the panel grows to its natural height.
- **EntityGraph** is pannable via pointer drag and zoomable via wheel (clamped 0.4× – 3×). A "Reset view" button overlays the top-right when the user has moved away from default. `touch-action: none` so trackpad/touch swipes pan instead of scrolling the page.
- The graph's "Contexts" fanout uses the new `contextCount` + `/contexts` endpoints — clicking it shows every context the entity belongs to and drilling in opens that context's detail page.

### Risk Scoring page changes

- Cluster sections retired. Default view is "Users". A "View clusters →" link jumps to the Contexts tab. The `/api/risk-scores/clusters*` routes are removed; clustering lives in the `resource-cluster` plugin.

### Bootstrap / quickstart fixes

- `BEHIND_TLS=true` opt-in for HSTS + CSP `upgrade-insecure-requests`. The default `http://host:3001` quickstart no longer traps browsers into HTTPS-only for a year.
- `/api/users` was returning 500 because it still SELECT'd the dropped `u."contextId"` column. Fixed.

### Tests

- 8 new vitest test files, **216 tests total** (was 175 before this branch):
  - `contexts/contextFilters.test.js` — 13 tests for the matrix-filter SQL helper
  - `contexts/memberCounts.test.js` — 5 tests for the count-refresher (walk-up, direct/total updates, cycle safety)
  - `contexts/plugins/manager-hierarchy.test.js` — 10 tests covering the algorithm + `excludeNamePatterns`
  - `contexts/plugins/ad-ou-from-dn.test.js` — 10 tests including injection guards on `dnField`
  - `contexts/plugins/resource-cluster/tokenize.test.js` — 16 tests for the tokenizer + stopwords
  - `contexts/plugins/resource-cluster/index.test.js` — 10 integration tests for the plugin's `run()` against a mocked db
  - `bootstrap.tagRoots.test.js` — 3 tests for `getOrCreateTagRoot`

### Cleanup

- Removed `OrgChartPage.jsx` and the `Org Chart` tab. A minimal `/api/org-chart` adapter remains (3 endpoints: manager / reports / availability) to keep the entity-detail graph and the Department detail page working until those callers are rewritten to read from the manager-hierarchy plugin tree directly.

## Changes in this PR

- Redesigned User, Identity, and Resource detail pages with a two-column layout: a single unified Attributes table on the left (core columns and extendedAttributes merged, with an "ext" tag marking JSON-derived fields) and an interactive relationship graph on the right.
- The graph shows the entity in the center with relationship nodes orbiting around it (for a user: Manager, Direct Reports, Context, Groups split by Direct/Indirect/Owner/Eligible, Access Packages, OAuth2 Grants, and Identity). Node size scales with the count and active nodes pulse in the logo's lime palette.
- Clicking a relationship node reveals the full list of items below the graph — e.g. clicking "Groups (Direct)" shows every direct membership, clicking "Direct Reports" shows every report — with clickable rows that open the entity's own detail tab.
- Clicking a satellite item now fans its relationships out as a further ring, drilling into that entity's own graph. Clicking the same node again collapses it; switching to a different root node replaces the chain. Works across users → access packages → resources → users, etc.
- Business Role / Access Package detail pages now share the same graph + fanout + attributes layout as users and resources.
- New "Recent Changes" timeline on every entity detail page. Shows relationship-level events from the last 30 days — assignments in/out, manager changes, resource containment shifts, linked-account add/remove — so investigating a permission issue starts with "what moved recently". Each event links to the affected counterparty's detail tab.
- Recent additions and removals also show up in the graph itself: a "Recently Added" root node (amber tint) and "Recently Removed" node (rose tint) appear when applicable, and items added in the window are tinted amber when they appear inside regular fanouts.
- Identities tab is now a simple Resources-style list (name, email, accounts, department, job title, tags) with search, filters, and bulk-tag actions. Account-correlation controls (verify / confirm / reject, HR anchor badges, orphan status, confidence bars) were removed from the list — they will return in a dedicated correlation UI later.
- Identities now support tags. Tag CRUD accepts entityType='identity'; identity rows carry their tags in the list API; a new `/api/identity-columns` endpoint feeds the filter-bar dropdowns.
- New endpoints `GET /api/user/:id/recent-changes`, `/api/resources/:id/recent-changes`, `/api/access-package/:id/recent-changes`, `/api/identities/:id/recent-changes`. Each returns up to 50 events in the last 30 days with `{ at, operation, summary, counterpartyKind, counterpartyId, counterpartyLabel }`.
- Migration 018 rewires the `_history` audit trigger so it writes a composite-key row identifier for `ResourceAssignments`, `ResourceRelationships`, and `IdentityMembers` — tables where the primary key is a tuple of foreign keys. Before this migration those inserts and deletes were silently skipped, so Recent Changes only picks up events from the migration forward.
- Identities now show aggregate counts across all linked accounts (groups, governed roles, owned resources, eligible memberships, OAuth2 grants) and a new `/api/identities/:id/assignments?type=…` endpoint returns the flattened list when a node is clicked.
- User detail endpoint now returns `membershipByType` (broken down by Direct/Indirect/Owner/Eligible) and `directReportCount`; resource detail endpoint returns `assignmentByType` (Direct/Governed/Owner/Eligible) — both used to populate the graph without loading full lists.
- HSTS and CSP `upgrade-insecure-requests` are now opt-in via `BEHIND_TLS=true`. The default quickstart serves over plain HTTP on port 3001, and these headers were trapping browsers into HTTPS-only mode with no TLS listener behind them.
- New `Test-EntityGraphNodes.ps1` nightly test walks every active node on every entity detail graph, asserts the matching list endpoint returns non-empty rows with displayName fields, and probes the `/recent-changes` endpoint shape for all four entity kinds.

## Changes in this PR

- Fixed org chart direct reports not showing due to invalid ValidTo filtering (temporal tables were removed in v5)

## Changes in this PR

- Fixed business role assignments not displaying in the detail page (API was returning `state` instead of `assignmentState` and missing the `id` field)

## Changes in this PR

- Added dark mode support across the entire UI; toggle via the user avatar settings dropdown
- Dark mode preference is persisted per browser in localStorage
- All pages, tables, cards, modals, and the matrix view adapt to dark mode
- Access Package column colors switch to a darker saturated palette in dark mode so they remain distinct and legible
- Risk tier badges (Critical/High/Medium/Low/Minimal) use appropriately shifted dark variants

## Changes in this PR

- The Crawlers page now shows **one progress card per running or queued crawler** instead of collapsing everything to a single card. Starting two crawlers back-to-back shows two cards stacked: the running one with its live step + percentage, and the queued one with a "Waiting for the worker" amber card (no fake 0% progress bar). Each card is labelled with the source config's display name so two Entra tenants are distinguishable at a glance. Cards can be dismissed individually once the job finishes.
- Added **OAuth2 Delegated Grants** as a new object type in the Entra ID crawler. When enabled, the crawler pulls `/oauth2PermissionGrants` and ingests every per-user consent (user X authorized client app Y to call target API Z on their behalf with scope S). Tenant-wide admin consents (`consentType='AllPrincipals'`) are skipped because they don't represent an individual user's authorization decision.
- New Graph permission surfaced in the Crawlers wizard: `DelegatedPermissionGrant.Read.All`. The wizard now warns if the app registration doesn't have it when the OAuth2 Grants object type is selected. `DelegatedPermissionGrant.ReadWrite.All` counts as granted (superset).
- Modelled each (client-app, target-API, scope) combination as a child `Resources` row of the client app (resourceType `DelegatedPermission`, linked via a new `ResourceRelationships.relationshipType='DelegatesScope'`). Each user's consent becomes a `ResourceAssignments` row with `assignmentType='OAuth2Grant'`. The deterministic scope-resource IDs make re-runs idempotent, and the distinct relationshipType keeps the sync from interfering with Access Package `Contains` relationships.
- Added an **OAuth2 Delegated Grants** collapsible section to the User detail page, listing every (client app, target API, scope) the user has consented to. Clicking the client-app name opens its detail tab. The section only renders when the user has at least one grant.
- Removed the hardcoded "Open in Entra ID" button from every detail page (User, Group, Resource, Access Package). The button was built from UI-side URL computation duplicated across four files, which drifted whenever Microsoft changed portal URLs.
- Replaced with a data-driven path: the crawler-calculated `ext.Link` attribute now renders as a clickable "Open in Entra ID" hyperlink directly in the Extended Attributes / Attributes table on every detail page. Single source of truth — if the crawler knows the portal URL for an object, you see it; if it doesn't, the row simply isn't there (no more links that 404).
- Bonus: any other `http(s)://…` attribute value renders as a clickable link showing the URL text, so future calculated fields (wiki links, ticket references, etc.) get the same treatment automatically without each detail page needing to opt in.
- Added a dedicated **`PrincipalActivity`** table (migration `017_principal_activity.sql`) for sign-in timestamps. Activity data no longer lives in `Principals.extendedAttributes`, which eliminates the `_history` churn that previously generated one audit row per user per daily crawl. History-trigger-free by design — only the latest known activity per combination is kept.
- The Entra ID crawler now populates **per-user sign-in activity** from the existing `signInActivity` property on `/users`, sending it to `/ingest/principal-activity` as aggregate rows (granularity A) keyed by principal.
- **Service-principal sign-in activity** is newly captured via `/beta/reports/servicePrincipalSignInActivities`. For each synced SP the crawler uploads an aggregate row with `lastSignInDateTime` and `lastNonInteractiveSignInDateTime` from the report, plus `applicationAuthenticationClient` and `delegatedClient` flavours in `extendedAttributes`. Previously ~96% of principals (SPs / MIs / AI agents) had zero activity data.
- New crawler object type **"Sign-in Logs (per-app activity)"** (`signInLogs`) pulls `/auditLogs/signIns` and aggregates to per-`(user, app)` last-activity rows (granularity B). Answers "when did user X last sign in to app Y?". Window configurable via `signInLogsDays` (default 7, capped at Graph's 30-day retention). Skipped events (no `userId`/`appId`, or app not yet synced) are logged but don't fail the run.
- Risk scoring engine now reads the stale-sign-in signal from `PrincipalActivity` first, falling back to the old `extendedAttributes.signInActivity` path so scores don't regress for tenants that haven't re-crawled yet.
- Seven new vitest cases covering `principal-activity` envelope + record validation, the aggregate-row sentinel path, the per-pair path, and pinning `AGG_RESOURCE_ID` to the migration's `DEFAULT` value.
- Fixed the Crawlers page showing "Force Stop" on every crawler config of the same type when any one of them was running. With two Entra ID crawlers side-by-side, starting one made the other's card light up as if it were running too, and clicking "Force Stop" on the wrong card would kill the real running job. The page now matches each running job back to the specific config that started it. Manual "Run Now" jobs are also stamped with their source config id on the backend so the scheduler and the UI agree on which config each job belongs to.

## Changes in this PR

- Added per-phase timing to the Entra ID crawler. Each `SyncXxx` block (Principals, ServicePrincipals, Resources, Assignments, PIM, Governance, RefreshViews) now wraps a `Stopwatch` and the final log prints a breakdown table: `Principals  42.3s  (4.7%)` etc., plus an "Other" line covering setup and anything outside the instrumented blocks. No behaviour change — just instrumentation — so operators can see exactly where a slow crawl spent its time before deciding where to optimise.
- Added two calculated fields to every Entra-synced object's `extendedAttributes`: a **`Link`** deep-link into the Entra admin portal (same URL the Identity Atlas UI opens on its "Open in Entra ID" buttons), and **`<fieldName>_OuPath`** — a forward-slash-separated OU path derived from any DN-shaped value on the object. Example: `CN=100001,OU=Users,OU=Accounts,OU=Clients,DC=krypton,DC=ad,DC=novastream,DC=com` becomes `Clients\Accounts\Users`.
- Works across **all synced object types** (users, groups, service principals, managed identities, AI agents). Every DN-shaped attribute on each record is converted — the conversion is opt-in by DN shape, not by hardcoded field name, so custom `fgGroupDN` / `ownerDN` / etc. extensions get translated too.
- `onPremisesDistinguishedName` is now fetched by default on the user sync so on-prem-synced users get an `_OuPath` out of the box. Cloud-native users leave it null and emit no extra field.
- Four new helper functions under `tools/powershell-sdk/helpers/`: `Add-FGEntraCalculatedAttributes`, `Get-FGEntraPortalLink`, `Test-FGDistinguishedName`, `Convert-FGDistinguishedNameToOUPath`. 21 new Pester tests pin the DN detection rules, the canonical OU-path conversion example, and each portal-URL blade shape.
- Fixed the worker running "orphaned" crawl jobs after a web container restart. When the web container restarts mid-crawl, its bootstrap marks any `running` CrawlerJob as `failed`. Previously the worker had no way to know its current job had been killed and would keep processing for another 60–90 minutes until the crawl finished naturally, blocking every queued job behind it. The crawler's progress endpoint already returned HTTP 409 when asked to update a non-active job — the crawler was silently swallowing that signal. It now propagates 409 as a clean abort, the dispatcher marks the job failed, and the worker moves on to the next queued job within one poll cycle (~30 seconds).

## Changes in this PR

- Added a one-click Excel Power Query workbook download under **Admin → Data → Excel Power Query Workbook**. Clicking "Generate token & download workbook" mints a read-only API key, embeds it in the workbook's Settings sheet alongside the API URL, and streams the file back. Data analysts can drop the file on any machine and refresh from any deployment without ever editing M code.
- Tabs included: Systems, Principals, Resources, Assignments, Identities, IdentityMembers, ResourceRelationships. Each tab includes pre-written paginated Power Query M code that the user pastes into Power Query Editor (Data → Get Data → Other Sources → Blank Query). A future iteration will swap in a hand-built template that loads queries automatically — the rest of the plumbing is already in place.
- New read-only API token type (`fgr_…`). Tokens are accepted on GET requests to non-admin endpoints only — they cannot mutate data or reach any admin endpoint, even if leaked. Stored as SHA-256 hashes; plaintext is shown to the operator exactly once at creation. Tokens can be revoked from the same admin section, which immediately stops every workbook holding them from refreshing.
- New bulk list endpoints for the join tables that previously had no flat listing: `/api/assignments`, `/api/identity-members`, `/api/resource-relationships`. All are paginated (`?limit=1000&offset=N`, max 10 000 per page) with optional `?systemId=N` filter, returning `{ data, total }` like every other list endpoint.

## Changes in this PR

- Fixed Docker image publishing not triggering automatically after PR merges to main

## Changes in this PR

- Fixed Quick Start documentation: Image channel switching code now includes Windows PowerShell syntax

## Changes in this PR

- Replaced long-lived release branches with git tags for release management — hotfixes now ship only the fix, without features already merged to main
- Added "Cut Release" workflow: tags vX.Y.Z on main HEAD, triggers :latest publish
- Added "Cut Hotfix" workflow: tags a hotfix branch commit as a new patch version, triggers :latest publish
- Removed release branch concept — no more "Compare & pull request" banner confusion after cutting a release

## Changes in this PR

- Added branching and versioning strategy reference page under docs/architecture
- Added `--pull always` flag to Quick Start commands in README, quickstart, docker-setup, and index docs so users always get the newest image
- Added `.env` setup step (copy from template) to all Quick Start sections
- Added tabbed Linux/macOS and Windows code blocks throughout docker-setup and local-dev docs
- Fixed version pinning example in quickstart to use release format (5.2.0.0) instead of edge timestamp format
- Fixed history.md to link to the branching strategy doc instead of referencing CLAUDE.md
- Aligned local-dev.md with docker-setup.md: added --build note for first run, tabbed stop/reset commands

## Changes in this PR

- Added an About page showing the MIT license text and Software Bill of Materials
- The version string in the footer is now a clickable link to the About page

## Changes in this PR

- Added Service Principals to the Entra ID crawler. When the "Service Principals" object type is selected, the crawler now pulls all Entra service principals (enterprise apps, managed identities, AI agents) and writes them to the Principals table alongside user accounts — unblocking future Azure RM role-assignment imports that reference these identities.
- New classification helper (`Get-FGServicePrincipalType`) tags each service principal as `ManagedIdentity`, `AIAgent`, or `ServicePrincipal` based on Graph's `servicePrincipalType`, well-known Microsoft AI platform tags (CopilotStudio, PowerVirtualAgents, AzureOpenAI, CognitiveServices), the Entra Agent ID markers (`AgenticInstance`, `AgenticApp`, `power-virtual-agents-*`), and display-name heuristics. Custom AI-name patterns can be supplied per crawler config via `aiNamePatterns`.
- Extra SP metadata (`appId`, `servicePrincipalType`, `publisherName`, `homepage`, `tags`, `servicePrincipalNames`, `notes`) is stored in `extendedAttributes` so it shows up in the Users filter dropdown and detail pages.
- Added principal-type sub-tabs to the Users page ("All / Users / Service Principals / Managed Identities / AI Agents") so the list stays navigable after an SP sync adds thousands of non-human identities. The active tab is preserved in the URL hash (`#users?type=AIAgent`).

## Changes in this PR

- Fixed the Cut Release workflow rejecting valid version inputs like "5.2" due to a non-portable regex

## Changes in this PR

- Fixed the "Filters" dropdown on the Users and Resources pages — attribute fields (Department, Job Title, etc.) and their values are populated again. The list had regressed to showing only "User Tag" because column discovery was looking up table names in the wrong case after the PostgreSQL migration.
- Added regression tests pinning the PostgreSQL table and column casing used by column discovery, so the same mismatch can't slip back in.
- Added extended-attribute fields to the Users and Resources filter dropdowns. Keys stored inside the `extendedAttributes` JSON blob (e.g. `userType`, `onPremisesSyncEnabled`, `extensionAttribute5`, `city`, `country`) are now filterable via the UI, labelled with a "(ext)" suffix so they're distinguishable from regular columns.

## Changes in this PR

- Added stable release branch model: `release/vX.Y` branches are cut from `main` and receive only bugfixes, giving customers a stable `:latest` Docker image that does not change when new features land on `main`
- New `cut-release.yml` workflow creates a release branch and sets the initial version (e.g. `5.2.0.0`) with one click from GitHub Actions
- Main branch builds now push the `:edge` Docker tag instead of `:latest`, so customers on `:latest` only receive intentional releases
- Production hotfixes merged to a release branch increment the patch version (`5.2.0.0` → `5.2.1.0`) and push `:latest` automatically
- `docker-compose.prod.yml` now supports an `IMAGE_TAG` environment variable to select the image channel (`latest`, `edge`, or a pinned version); customers get `latest` by default
- The footer now shows the running version; edge builds display a prominent amber "edge" badge so it is immediately obvious which channel is running
- README and Docker Setup documentation updated with step-by-step `.env` setup for both customers and developers, image channel selection guide, and a full environment variable reference
- Fixed PR checks (lint, unit tests, integration tests) to also run on pull requests targeting `release/**` branches, so hotfixes receive the same gate as feature PRs
- Fixed release cut workflow: the initial `X.Y.0.0` image is now published to `:latest` immediately after the release branch is created, not only after the first bugfix merges
- `release/**` branches are now protected: direct commits are blocked, a pull request is required, and the `PR Summary` status check must pass before merging; repository admins retain bypass rights so the automated version bump can still land

## Changes in this PR

- Fixed Risk Scoring card on Dashboard to link directly to Admin → Risk Scoring subtab
- Added Software Bill of Materials (SBOM) documentation listing all components, dependencies, and infrastructure elements
- Fixed SBOM navigation entry in mkdocs.yml to ensure proper documentation site build
- Added automatic scheduling for risk scoring runs (similar to crawler scheduling)
- Risk classifiers can now have multiple schedules configured via Admin → Risk Classifiers
- Scheduled scoring runs execute in the background and re-score all entities with the active classifier
- Schedules support hourly, daily, and weekly frequencies
- Added "Select All" and "Deselect All" buttons to the attribute picker in the EntraID crawler wizard, making it easier to manage large attribute lists
- Fixed automated version bumps failing due to branch protection requiring pull requests
- Fixed Dashboard Risk Scoring card link to properly navigate to Admin → Risk Scoring sub-tab
- Fixed direct reports not showing in demo dataset (org chart queries now filter for current records in temporal Principals table)
- Added in-browser wizard for generating account correlation rulesets via LLM (Admin → Account Correlation)
- Users can now create correlation signals and account type rules through a conversational UI instead of PowerShell commands
- Wizard follows the same pattern as Risk Scoring: Sources → Generate & Refine → Save
- Fixed Risk Scoring page not refreshing automatically after completing the risk profile wizard
- Fixed crawler schedules not firing when created via legacy wizard (scheduler now supports both `schedule` and `schedules` config formats)
- Fixed detail page tabs not updating when switching between different users, resources, or other entities — tabs now show the correct entity data immediately
- Fixed Org Chart UI so all departments are visible when scrolled horizontally; departments no longer fall off the edge of the viewable area
- Fixed Extended Attributes displaying "[object Object]" for complex values like sign in activity — now shows properly formatted JSON
- Automated version bumping on PR merge — `bump-version.yml` Action increments the Minor version in `setup/IdentityAtlas.psd1` and updates the timestamp on every PR merge to `main`. Branches no longer touch the version file, eliminating recurring merge conflicts on `setup/IdentityAtlas.psd1`.
- Automated changelog merging on PR merge — branches now create a fragment file in `changes/` instead of editing `CHANGES.md` directly. The same `bump-version.yml` Action collects all fragments and prepends them to `CHANGES.md` on merge, eliminating recurring merge conflicts on `CHANGES.md`.
- Fixed Sync Log empty state message to reference adding a crawler instead of Start-FGSync
- Added historical performance graphs to Containers tab showing last 10 minutes of CPU, memory, and network usage for each container
- Added syntax highlighting and collapsible sections to JSON display in risk profile wizard for improved readability
- Fixed upgrade instructions to use `--pull always` instead of a separate `pull` + `up -d`, so a single command always fetches the latest image from the registry
- Merged issue triage and nightly auto-fix into a single unified workflow that classifies and fixes bugs immediately when an issue is opened
- Added automatic issue classification: bugs vs feature requests, with priority labels (critical, high, medium, low)
- Feature requests are now labeled as `enhancement` with a priority but require manual triage before auto-fix
- Added nightly re-evaluation job (23:00 Amsterdam time) that checks issues labeled `needs-clarification` or `cant-autofix` for new comments — if enough detail has been added, the issue is promoted to `ready-to-fix` and auto-fixed
- Fixed auto-fix prompt to use changelog fragments instead of editing CHANGES.md and setup/IdentityAtlas.psd1 directly

## Changes in this branch

- **Auto-fix workflow: CI-validated fixes with retry** — Reworked the nightly auto-fix into a two-attempt pipeline: Claude investigates and fixes the issue, submits a draft PR, waits for the full CI pipeline (integration tests, Playwright E2E, load tests) to validate it. If CI fails, Claude gets the failure logs and tries to fix the broken tests in a second attempt. Three possible outcomes: `auto-fixed` (PR + CI green), `cant-autofix` with reason (couldn't produce a fix), or `cant-autofix` with PR link (fix exists but CI still failing — needs human review). The prompt now instructs Claude to think step-by-step before implementing. Issues labeled `cant-autofix` or `auto-fixed` are excluded from future runs (remove the label to retry).
- **Clean up deprecated claude-code-action input names** — Replaced `direct_prompt` with `prompt`, moved `model` and `allowed_tools` into `claude_args`, and removed `timeout_minutes` (already covered by the job-level `timeout-minutes`). Fixes the "Unexpected input(s)" warnings in all three nightly workflows.
- **Fix nightly workflows failing with OIDC token error** — All three nightly workflows (Auto-fix, Docs Review, Test Coverage Review) were failing because `anthropics/claude-code-action@v1` requires the `id-token: write` permission to authenticate via OIDC, but the workflows only declared `contents: write` and `pull-requests: write`. Added `id-token: write` to the `permissions` block of each job that uses the Claude Code action.
- **Nightly test coverage review workflow** — Added `test-coverage-review.yml`, a scheduled workflow (04:00 UTC daily, plus manual dispatch) that reviews source code changes from the last 24 hours and identifies gaps in test coverage. Claude Code reads the changed files, finds existing tests, and writes new Jest, Playwright, or PowerShell tests where coverage is missing. Non-source changes (docs, config, CI, version bumps) are automatically skipped. Jest tests are syntax-checked during the run. If no new tests are needed, the workflow completes cleanly. When tests are added, a draft PR is opened on a `test/nightly-coverage-YYYYMMDD` branch for human review.
- **Nightly documentation review workflow** — Added `docs-review.yml`, a scheduled workflow (03:00 UTC daily, plus manual dispatch) that reviews code changes from the last 24 hours against the project documentation. Claude Code reads the recent commits and changed files, checks each relevant doc page, and makes targeted updates where the docs have fallen behind the code. If no updates are needed, the workflow completes cleanly without creating a branch or PR. When docs do need updating, a draft PR is opened on a `docs/nightly-review-YYYYMMDD` branch for human review before merge.
- **Nightly auto-fix workflow replaces event-driven trigger** — Rewrote `issue-autofix.yml` from a `labeled` event trigger to a nightly scheduled workflow (02:00 UTC, plus manual dispatch). The old approach couldn't work because GitHub Actions events created by `GITHUB_TOKEN` don't trigger other workflows. The new workflow: (1) finds all open issues with `ready-to-fix` but not `fix-in-progress`, (2) applies `fix-in-progress` label to prevent double-processing, (3) uses Claude Code to implement each fix on a `bugfixes/autofix-issue-N` branch from `main`, (4) opens a draft PR and comments on the issue with a link. If Claude Code fails, `fix-in-progress` is removed so the issue re-enters the queue next night. Also fixed the branch target from the non-existent `dev` to `main`. Issues are processed one at a time (max 10 per run).
- **Unified step indicator across all crawler wizards** — The CSV crawler and Custom Connector wizard now use the same numbered-circle step indicator (indigo for current/completed, gray for pending, → separators) as the Entra ID crawler. The shared render logic was extracted into a single `StepIndicator` component used by all three wizards.
- **Automated issue triage and auto-fix workflows** — Added two GitHub Actions workflows for issue management. (1) `issue-triage.yml` triggers when a new issue is opened: sends the issue title and body to the Claude API for analysis, automatically applies labels (`bug`, `ui`, `demo-data`, `needs-clarification`, `ready-to-fix`), and posts a clarification comment when the issue lacks detail. Issues written in Dutch are handled correctly. (2) `issue-autofix.yml` triggers when the `ready-to-fix` label is applied (either by triage or manually): uses the `anthropics/claude-code-action@v1` to check out the repo, implement a fix, update version and CHANGES.md per project conventions, and open a draft PR targeting `dev`. The PR requires human review before merge. Requires two dedicated secrets: `TRIAGE_ANTHROPIC_API_KEY` and `TRIAGE_LLM_MODEL`.
- **PR integration test gate for main branch** — Added `.github/workflows/pr-integration.yml`, a comprehensive Docker-based integration test suite that runs on every PR targeting `main`. Three parallel jobs: (1) **Integration Tests** (~20 min) — builds the full Docker stack, verifies postgres schema (25+ tables), loads demo data, cleans and re-loads, smoke-tests 18 read endpoints, then runs all PowerShell test scripts (Ingest API, CSV edge cases, detail page counts, account correlation, custom connector, secrets vault, LLM substrate, deterministic risk scoring). Secret-dependent tests (Entra ID crawler, LLM-based risk scoring) run when GitHub Actions secrets are configured, skip gracefully otherwise. (2) **Playwright E2E** (~15 min) — runs all 18 Playwright specs against the Docker backend via a new `playwright.ci.config.js` (Chromium only, no local dev servers). (3) **Load & Soak** (~50 min) — 1.5M-row load test + 15-minute soak test with memory-leak detection. All three jobs must pass before the PR can be merged. Includes log collection on failure (uploaded as artifacts) and a summary job that reports per-job status. Secrets to configure in repo Settings: `TEST_GRAPH_TENANT_ID`, `TEST_GRAPH_CLIENT_ID`, `TEST_GRAPH_CLIENT_SECRET`, `TEST_LLM_API_KEY`, `TEST_LLM_PROVIDER`, `TEST_LLM_MODEL`, `TEST_RISK_PROFILE_DOMAIN` (and Azure OpenAI fields if applicable).
- **Unified step indicator across all crawler wizards** — The CSV crawler and Custom Connector wizard now use the same numbered-circle step indicator (indigo for current/completed, gray for pending, → separators) as the Entra ID crawler. The shared render logic was extracted into a single `StepIndicator` component used by all three wizards.
- **Fix demo data load failing with 500 on contexts ingest** — Migration 014 added `DEFAULT gen_random_uuid()` to UUID primary key columns so callers can omit explicit IDs. The ingest engine's `discoverColumns()` query treated any column with a `gen_random_uuid()` default as an identity column and excluded it from `activeColumns`, so the temp table was built without the `id` column. That broke both the `ON CONFLICT ("id")` upsert and the `scopedDelete` index creation, producing a 500 on contexts, identities, principals, resources, and all governance tables. Fixed by removing `gen_random_uuid()` from the identity-detection query — only true sequence columns (`nextval(`) and `IS_IDENTITY` columns are auto-generated identities; UUID defaults are just fallbacks for when callers don't supply explicit IDs.
- **Regression tests for slider totalUsers fix and detail-page section counts** — Added `test/nightly/Test-DetailPageCounts.ps1` (Phase 4f3b in the nightly runner). Seeds its own isolated data via the Ingest API and covers: (1) `GET /api/permissions` `totalUsers` stability — verifies that users with no assignments are still counted in `totalUsers` so the slider max doesn't snap when the limit is lifted; (2) user-detail `historyCount` shape — field is an integer (not a boolean), `hasHistory` derives from it; (3) resource-detail `parentResourceCount` vs `accessPackageCount` — the AP count is restricted to BusinessRole parents only, while parent count covers all relationship types; (4) access-package-detail `pendingRequestCount` — field is non-null even when the AssignmentRequests table is empty (was hardcoded `null` before PR #16).
- **Fix 16 nightly test failures (2026-04-14 run)** — Three root causes identified and fixed: (1) **UUID columns without DEFAULT** — `Principals`, `Resources`, `Contexts`, `Identities`, and 5 governance tables had `UUID PRIMARY KEY` without `DEFAULT gen_random_uuid()`, causing the ingest engine to insert NULL when callers (CSV crawlers, custom connectors, test scripts) don't provide an explicit ID — fixed via migration 014 and updated `discoverColumns()` to recognize `gen_random_uuid()` defaults as auto-generated columns. Resolves Ingest/Principals, Ingest/Resources, Ingest/ResourceAssignments, CustomConnector/IngestUser, CustomConnector/DataLanded (5 tests). (2) **CSV test auth header** — `Test-CSVEdgeCases.ps1` sent `X-API-Key` header instead of `Authorization: Bearer`, causing all 6 CSV edge-case tests to return 401. (3) **Correlation test response parsing** — `Test-AccountCorrelation.ps1` tried to extract system IDs from `$response.created[0].id` / `.updated[0].id` / `.ids[0]`, but the ingest API returns `systemIds` array; fixed to use `$response.systemIds[0]`. Resolves all 5 Correlation tests. Remaining 5 failures: Container-Stats-Live (WIP), Static-Spectral (Docker tooling), LLM-Config/Save + Vault/EncryptionVerified (needs manual investigation), LoadTest/SystemCount (intermittent).
- **Fix slider snapping back when dragged to the maximum** — In the Matrix tab, dragging the Users slider to the right-most position (e.g. 28) and releasing it caused it to snap back to a lower number (e.g. 23). The "All" button also showed the amber "Showing 23 of 28 users" warning even though no limit was active. Root cause: the "no limit" branch of the permissions API counted `totalUsers` as distinct member IDs in the result set (only users with at least one assignment), while the limited branch counted all Principals — so `totalUsers` shrank when the limit was lifted, shrinking the slider max and snapping it. Fixed in two places: (1) the "no limit" API branch now runs the same `COUNT(*) FROM Principals` query as the limited branch so `totalUsers` is stable; (2) when showing All, the amber warning now reads "Showing 23 of 28 users (5 have no assignments)" so it's clear why those users are absent, rather than implying the slider is cutting them off.
- **Detail pages show section counts before expanding** — Business role, resource, and user detail pages now show the count in each collapsible section header immediately on page load, without requiring the section to be expanded first. API changes: resource detail endpoint (`/api/resources/:id`) now returns `memberCount`, `accessPackageCount`, `parentResourceCount`, and `historyCount`; access-package and user/group detail endpoints now return `historyCount` (integer) instead of only `hasHistory` (boolean). The pending request count on business role pages is now fetched as a cheap `COUNT(*)` during core load rather than being deferred. Unnamed business roles show "Unnamed" in grey italic; null `parentResourceId` rows are excluded from counts and results to prevent 400 errors on navigation.
- **Dashboard sync log entries link to Sync Log tab** — The "N sync log entries" text at the bottom of the stats card on the Dashboard is now a clickable link that navigates directly to the Sync Log tab.
- **Extract `Section` and `CollapsibleSection` to `DetailSection.jsx`** — both components were defined identically inside four detail page files (UserDetailPage, GroupDetailPage, ResourceDetailPage, AccessPackageDetailPage), causing React to recreate them on every render. Extracted to a shared `components/DetailSection.jsx`. No behavior change.
- **Extract `useDebouncedValue` hook** — the `useState` + `useEffect` debounce pattern was duplicated in four places (`useEntityPage`, `AccessPackagesPage`, `IdentitiesPage`, `OrgChartPage`). Extracted to `app/ui/src/hooks/useDebouncedValue.js`. No behavior change.
- **Extract shared tier styles to `utils/tierStyles.js`** — `TIER_STYLES` (bg, text, border, dot, avatar, box, boxBorder per tier) and `tierClass(tier)` helper were duplicated across 7 files (RiskScoreSection, RiskScoringPage, OrgChartPage, DepartmentDetailPage, IdentityDetailPage, IdentitiesPage, UserDetailPage). All copies removed; each file now imports from `app/ui/src/utils/tierStyles.js`. No behavior change.
- **Extract shared formatter utilities to `utils/formatters.js`** — `formatDate`, `formatValue`, `computeHistoryDiffs`, and `friendlyLabel` were defined identically in four detail page components (UserDetailPage, ResourceDetailPage, GroupDetailPage, AccessPackageDetailPage) and `formatDate` again in GovernancePage. All five copies removed; each file now imports from the new shared `app/ui/src/utils/formatters.js`. No behavior change.
- **Fix black borders on Crawlers page and Add Crawler wizard** — The Custom Connector wizard introduced 56 bare `border` classes without a color modifier, causing Tailwind to fall back to the current text color (black). Added `border-gray-200` to all uncolored borders, matching the fix applied to other Admin pages in PR #4.
- **Fix orange confidence bar and malformed "null%" label on identities with no correlation run** — `ConfidenceBar` was not guarded against a null confidence value: null failed every threshold comparison and fell through to `bg-orange-500`, and `{null}%` rendered as a bare `%`. Now shows a solid grey bar with `—%` and a hover tooltip when confidence is null. Extracted `ConfidenceBar` to a shared component (`ConfidenceBar.jsx`) used by both `IdentitiesPage` and `IdentityDetailPage`.
- **Custom Connector wizard on Crawlers page** — Enabled the "Custom Connector" crawler type (previously marked "Coming soon") on the Admin → Crawlers page. Clicking it opens a 3-step wizard: (1) **Register** — enter a connector name and optional description, creates a new crawler via `POST /api/admin/crawlers` and receives a one-time API key. (2) **API Key** — displays the key (with copy button and warning that it won't be shown again) and the API base URL. (3) **Getting Started** — three quick-link cards (Swagger UI at `/api/docs`, downloadable OpenAPI spec at `/api/openapi.json`, CSV Schema Reference on the docs site), tabbed code examples in curl / Python / PowerShell showing the full ingest flow (register system → push users → push resources → push assignments), and an ordered explanation of how the Ingest API works (Systems → Principals → Resources → Assignments → Relationships → Identities → Refresh Views). The existing `openapi.yaml` already documents all 16 ingest endpoints and 8 crawler management endpoints with full request/response schemas — no backend changes needed, this is a UI-only feature.
- **Fix "0 identities have no HR anchor" banner showing on demoset** — The `OrphanedAccountsNotice` guard compared `orphanCount === 0` with strict equality, but PostgreSQL `pg` returns `SUM()` aggregates as JavaScript strings (`"0"` not `0`). A string `"0"` is truthy and does not strict-equal the number `0`, so the orange warning banner was incorrectly rendered with a zero count. Fixed by using `Number(orphanCount)` in the guard, which coerces any string representation of zero to falsy.
- **Fix 8 nightly test failures (2026-04-13 run)** — Fixed 6 "Cannot index into a null array" failures (Account-Correlation, CSV-Edge-Cases, Ingest-API-Tests, LoadTest, Secrets-Vault, Soak-Test) caused by callback scriptblocks using `$script:results` which resolved to the child test script's scope instead of the runner's scope; callbacks now capture the results hashtable via a local variable + `.GetNewClosure()`, matching the pattern already used by the LLM and Entra ID callbacks. Fixed ESLint errors: moved `SortHeader` component out of `ClusterTable` render body in `RiskScoringPage.jsx` (6 `react-hooks/static-components` errors), fixed `useMemo` dependency in `UsersPage.jsx` and `GroupsPage.jsx` (2 `react-hooks/preserve-manual-memoization` errors), fixed `useCallback` dependency in `GovernancePage.jsx`, replaced impure `Date.now()` call during render with state-driven timestamp in `CrawlersPage.jsx`. Downgraded `react-hooks/set-state-in-effect` and `react-hooks/refs` to warnings in `eslint.config.js` — these flag the standard data-fetching `setLoading(true)` pattern used across all detail pages and the MSAL auth gate; fixing them properly requires a Suspense/useTransition migration. Container-stats 500 and Spectral failures are environmental (container running older image; Spectral can't find its ruleset in Docker).
- **Fix "Cannot access 'p' before initialization" crash when opening the Add Crawler wizard** — The `useEffect` that defaults Boolean identity-filter values to `'true'` referenced `userAttrCatalog` in its dependency array before that state variable was declared, causing a JavaScript temporal dead zone error. Moved the discovery `useState` declarations above the `useEffect` to fix the initialization order.
- **Comprehensive nightly test coverage expansion (Tier 1/2/3)** — Added 6 new PowerShell test scripts, 4 new Playwright E2E specs, cross-browser testing, and accessibility scanning. The nightly suite now covers ~75 minutes of testing (up from ~25 min) including a full 1.5M-row load test. New phases: **Phase 4f2 (Ingest API)** — direct POST tests against all `/ingest/*` endpoints with known-good payloads (happy-path: systems, principals, resources, assignments) and known-bad payloads (empty body, missing systemId, invalid syncMode, no auth). **Phase 4f3 (CSV edge cases)** — malformed inputs: missing columns, header-only files, empty displayName, 10K-char fields, SQL injection attempt in displayName, duplicate externalIds in one batch. **Phase 4f4 (Account correlation)** — create 2 principals in 2 systems, link to 1 identity, verify linkage via `/identities` endpoint. **Phase 4f5 (Secrets vault)** — save/read/tamper/cleanup cycle: writes a test LLM key, verifies ciphertext != plaintext via direct psql, corrupts the GCM authTag and verifies the API detects tampering, then cleans up. **Phase 4f6 (Container stats live)** — verifies `/admin/container-stats` returns real metrics when Docker socket is mounted, degrades gracefully when not. **Phase 4l (1.5M-row load test)** — generates the full synthetic dataset via `Generate-LoadTestData.ps1` (80K users, 80K resources, 1.5M assignments, 300K certifications), ingests via CSV crawler, verifies dashboard counts (>=1.4M assignments), refreshes materialized views, tests matrix query performance (<15s), and runs the benchmark suite. **Phase 7 (Soak test)** — 15 minutes of sustained API requests cycling through 6 endpoints, sampling memory every 60s, asserting no memory leak (final < 2x initial) and <1% error rate. New Playwright specs: multi-filter combinations (search narrows results on Users/Resources), accessibility (axe-core WCAG 2.0 AA on 5 pages, fails only on critical/serious), export validation (Excel download produces valid XLSX with PK magic bytes), visual regression (screenshot comparison for 4 pages with 5% diff tolerance). Cross-browser: added Firefox + WebKit projects to `playwright.config.js`. Added `@axe-core/playwright` dev dependency. New skip flags: `-SkipLoadTest`, `-SkipSoakTest`.
- **Fix 10 nightly test failures (first-run triage)** — After the first nightly run (142/152 passed), fixed the 10 failures across four categories: (1) **Docker fallback `--omit=dev` bug** — the ESLint and Backend-Unit-Tests docker fallback paths ran `npm ci --omit=dev` which skips devDependencies, but ESLint and vitest ARE devDependencies; dropped `--omit=dev` so the Docker one-shot containers install the full dependency tree. (2) **Playwright-E2E missing `$hasNpm` guard** — Phase 5 called `npx` directly without checking whether Node.js is on PATH; added a guard that skips gracefully when npx isn't available (same pattern as Phase 0). (3) **`/admin/container-stats` returning 500** — the container-name regex still matched `fortigigraph-*` instead of `identityatlas-*` (FortigiGraph → IdentityAtlas rename residue); updated to match both; also changed the Docker socket error from a hard 500 to a graceful 200 with `unavailable: true` since this is a monitoring endpoint. (4) **Identity-Only/UsersExist asserting on users instead of identities** — the Identity-Only scenario syncs only identities (cross-system correlation), not users/principals, so checking `/users` returned 0; changed to verify `/identities` endpoint is queryable instead. (5) **npm audit vulnerabilities** — ran `npm audit fix` in both `app/api/` (patched `express-rate-limit` IPv6 bypass, `path-to-regexp` ReDoS, `qs` DoS — 3 high/moderate fixed, 5 moderate remain in dev-only `esbuild`/`vitest` chain requiring breaking `--force`) and `app/ui/` (all 7 fixed, 0 remaining). (6) **PSScriptAnalyzer `PSAvoidUsingConvertToSecureStringWithPlainText`** — added `[SuppressMessage]` attribute to `Get-FGSecureConfigValue.ps1` with justification (migrating existing plaintext config to DPAPI-encrypted storage requires this pattern). (7) **LLM-Config/Save 500** — couldn't diagnose without server logs; improved error reporting in `Configure-LLM.ps1` to capture the HTTP response body on failure so the next occurrence shows the actual server error instead of just "500 Internal Server Error".
- **Dashboard no longer shows `-1` for Systems and sync log entries** — `pg_class.reltuples` starts at `-1` for unanalyzed tables and is only updated by `ANALYZE`, so the dashboard could show negative counts even when rows existed. Fixed in two ways: (1) `Systems` and `GraphSyncLog` are small tables that now use exact `COUNT(*)` so their counts are always accurate; (2) `refreshMatrixViews()` in [app/api/src/routes/ingest.js](app/api/src/routes/ingest.js) now includes `Systems`, `CertificationDecisions`, `GraphSyncLog`, and `RiskScores` in its post-refresh `ANALYZE` pass so `reltuples` stays current for the remaining estimate-based counters.
- **`Register-NightlySchedule.ps1`: fix `repoRoot` computation off by one level** — `$repoRoot` was computed as `Split-Path $PSScriptRoot -Parent`, which from `test\nightly` only goes up one level to `test\` instead of two levels to the repo root. Two consequences: (1) the printed status messages showed a duplicated path segment like `C:\source\IdentityAtlas\test\test\nightly\results\latest.md`, which was misleading; (2) the registered scheduled task got `WorkingDirectory = C:\source\IdentityAtlas\test` instead of the actual repo root. The functional impact is zero in practice because [test/nightly/Run-NightlyLocal.ps1:46](test/nightly/Run-NightlyLocal.ps1#L46) derives its own `RepoRoot` from `$PSScriptRoot` and doesn't depend on the launching process's working directory — but this was a latent bug waiting to bite a future change. Fixed to `Split-Path (Split-Path $PSScriptRoot -Parent) -Parent` with a comment explaining the two-level walk. Already-registered tasks keep the wrong `WorkingDirectory` until you re-run [test/nightly/Register-NightlySchedule.ps1](test/nightly/Register-NightlySchedule.ps1) (which silently re-registers); since it's harmless, re-registering is optional.
- **CSV crawler: handle quoted fields in `Resources.csv` fast-path parser** — `Read-CsvFast` in [tools/crawlers/csv/Start-CSVCrawler.ps1](tools/crawlers/csv/Start-CSVCrawler.ps1) is the hand-rolled fast parser used only for `Resources.csv` (it's the biggest table — 1.5M rows in the load-test dataset, where the PSCustomObject allocation in `Import-Csv` becomes the bottleneck). It correctly stripped a UTF-8 BOM from the header line but did a naive `.Split($delimiter)` that left literal `"` characters baked into both header keys and data cells. Files produced by PowerShell's `Export-Csv` — which always wraps every field in double quotes — tripped this on the very first check: header `"ExternalId"` ≠ `ExternalId`, throw `Resources.csv missing required columns ExternalId / DisplayName`. The Identity Atlas demo flow hits this directly because [tools/csv-templates/transforms/omada-to-identityatlas.ps1](tools/csv-templates/transforms/omada-to-identityatlas.ps1) uses `Export-Csv` to produce the `demodataTransformed/` files. Fix: after splitting on the delimiter, strip surrounding `"..."` from each header and each cell — O(1) per field (length + first/last char check, then optional `Substring`), keeps the tight-loop perf characteristics that make `Read-CsvFast` worth having. The supported quoting is now: each field MAY be wrapped in plain double quotes; embedded delimiters inside a quoted field, embedded newlines, and `""` escape sequences are still NOT supported (use the slow `Read-CsvFile` / `Import-Csv` path if you need any of those — but `Resources.csv` is the only file using `Read-CsvFast` and the canonical schema doesn't put delimiters inside Resource descriptions). Comment block updated to document the new contract.
- **Fix broken `:latest` web image and pull missing perf optimizations** — Added [app/api/src/config/authConfig.js](app/api/src/config/authConfig.js), the hot-reloadable auth-config loader imported by `app/api/src/index.js`, `app/api/src/middleware/auth.js`, and `app/api/src/routes/admin.js`. The file existed in the FortigiGraph source repo but was never copied across in the initial IdentityAtlas import, so every published `ghcr.io/fortigi/identity-atlas:latest` build since the rename had been crash-looping on startup with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/backend/src/config/authConfig.js'`. CI happily kept publishing the broken image because the build only validates that the bundle compiles, not that it starts. Discovered while running the Quick Start against a clean machine. Also pulled across `setup/config/.env.example` and `setup/config/tenantname.json.template`, which were missing for the same reason. In the same commit, picked up four perf-related route updates from the FortigiGraph "Optimizations after Load test" and "Load test updates" commits that had fallen between docs syncs and been left behind: [app/api/src/routes/admin.js](app/api/src/routes/admin.js) now uses `pg_class.reltuples` estimates for the dashboard counts instead of slow `COUNT(*)` (massive win on the 1.5M-row load-test dataset); [app/api/src/routes/ingest.js](app/api/src/routes/ingest.js) runs `ANALYZE` on the matviews and big base tables right after every refresh so the planner stats stay fresh enough for the new reltuples-based dashboard path; [app/api/src/routes/permissions.js](app/api/src/routes/permissions.js) constrains the AP-mapping subquery to just the top-N users in the result set instead of scanning the full 410k-row matview; [app/api/src/routes/systems.js](app/api/src/routes/systems.js) drops a now-redundant `LEFT JOIN` fallback in `ra_counts` since `ResourceAssignments.systemId` is always denormalized in v5. Refreshed [test/benchmark/BENCHMARK.md](test/benchmark/BENCHMARK.md), [test/benchmark/Run-Benchmark.ps1](test/benchmark/Run-Benchmark.ps1), and [test/benchmark/results/BENCHMARK.md](test/benchmark/results/BENCHMARK.md) with the latest narrative + numbers from those runs.
- **Quick Start: `--pull always` + dedicated Upgrading section** — The default start command in [docs/quickstart.md](docs/quickstart.md) is now `docker compose -f docker-compose.prod.yml up -d --pull always` (both the Linux/macOS and Windows tabs) so first-time and returning users always get the current `:latest` image from ghcr.io instead of a cached one. Added a `!!! tip` callout explaining why — `docker compose up` without `--pull always` reuses any cached `:latest`, which masks new releases. Added a new "**Upgrading to a new version**" section below the verification steps covering: the two-command `pull` + `up` flow for updating an existing deployment (data volume is preserved, migrations auto-apply on restart), three ways to check the running version (Dashboard Version card, `GET /api/version`, `docker compose images`), and a "Pinning to a specific version" subsection explaining how to swap the `:latest` tag in `docker-compose.prod.yml` for a version-stamped tag (`5.0.yyyyMMdd.HHmm`) for reproducible production deployments. Triggered by a user report that `docker compose up` was silently running an older cached image despite a newer version being published to ghcr.io.
- **Thorough v4 residue cleanup and docs restructure** — Deleted four large plan/status files that were left over from the v4→v5 migration and had nothing to say about current state: `docs/architecture/postgres-migration.md` (429 lines), `docs/architecture/postgres-migration-status.md` (187 lines), `docs/architecture/implementation-plan.md` (344 lines), and `docs/architecture/testing-plan.md` (576 lines) — ~1,536 lines of stale migration planning referencing `Connect-FGSQLServer`, `Invoke-FGSQLBulkMerge`, `Start-FGSync`, `dbo.`, SQL Server temporal tables, `_Test/`, `Functions/`, and other v4-era APIs. Renamed `docs/reference/temporal-tables.md` → `docs/architecture/audit-history.md` (the file was already rewritten as a postgres audit-history guide; only the filename was still wrong). Rewrote the "Sync Functions" section in `docs/concepts/governance-model.md` from a list of 10 `Sync-FGAccessPackage*` + `Connect-FGSQLServer` function calls into a short explanation that "governance data is fed by the crawlers — see Admin → Crawlers → Add Crawler". Updated the principalType and Source System Mapping tables in `docs/concepts/data-model.md` to name crawlers instead of old `Sync-FGPrincipal`/`Sync-FGEntraDirectoryRole`/`Sync-FGCSVBusinessRole` functions. Rewrote the intro + motivation of `docs/architecture/ingest-api.md` in past tense ("Before v5, Identity Atlas had two tightly-coupled sync paths…") and replaced the 140-line "Impact Analysis / Implementation Plan / Validation Plan / Open Questions / Risks & Mitigations" migration-planning tail with a short "Observed performance" section linking to the new Scaling page. Fixed `_Test/` → `test/`, `FortigiGraph-App` → `IdentityAtlas-App`, and `UI/frontend/e2e/` → `app/ui/e2e/` in `docs/architecture/demo-dataset.md`. Fixed the hardcoded `fortigigraph-worker-1` container name in `docs/architecture/docker-setup.md` to `docker compose exec worker`. Removed the re-added "Lead developer Wim van den Heijkant" line from the Creators section of `docs/about.md`. Updated the `fgc_` prefix explanation in `docs/architecture/ingest-api.md` to stop referencing "FortigiGraph Crawler" as the origin of the name. Added Windows PowerShell (`Invoke-WebRequest` / `Invoke-RestMethod`) equivalents to `docs/quickstart.md` via `pymdownx.tabbed` so Linux/macOS and Windows users each get a tab with copy-pasteable commands.
- **Restructured the docs navigation** — Reorganised `mkdocs.yml` nav from the old 10-section layout (which had "Architecture" bloated with project plans and "Reference" containing a removed feature) to a task-based 11-section layout: **Home → Quick Start → Concepts** (what it is) **→ Data Sources** (new — Entra ID, CSV Import, CSV Schema Reference, replacing the old two-page "Sync" group) **→ Using Identity Atlas** (renamed from "Role Mining UI") **→ Risk Scoring** (unchanged) **→ Architecture** (trimmed to Docker Setup, Ingest API, Audit History, LLM & Risk Scoring Internals — only current-state architectural docs) **→ Operations** (expanded from 1 to 4 pages: Scaling, Demo Dataset, Nightly Review, Troubleshooting — everything production-related in one place) **→ API Reference** (unchanged) **→ Reference** (pure lookup — Configuration, Database Views) **→ About**. Every page now lives where a reader would look for it: "how do I size this" goes to Operations, "how does the ingest API work" goes to Architecture, "how do I set this up on Windows" goes to Quick Start. Verified nav ↔ filesystem are exactly in sync (32 nav entries = 32 `.md` files, zero orphans, zero broken intra-docs links).
- **New "Scaling & Load Testing" docs page** — Added [docs/architecture/scaling.md](docs/architecture/scaling.md) documenting the largest workload Identity Atlas has been run against. Covers the synthetic ~2.17M-record load-test dataset produced by `test/load-test/Generate-LoadTestData.ps1` (20 systems, 80k users, 80k resources, 1.5M assignments, 300k certification decisions, etc.), the observed phase-by-phase ingest timings from the real sync log (~30 minutes end-to-end on a VM with 6 cores @ 3.70 GHz, 16 GB RAM, SAS SSD; CPU 73%, memory 87%, disk 1% — memory is the limiting factor, not CPU or disk; ResourceAssignments at ~1,250 rows/sec sustained across 20 MERGE batches of 75k each), instructions for reproducing the test (committed fixtures at `test/load-test/data/` or regenerating with the script), and practical guidance for readers sizing their own tenant. Wired into the Architecture nav between "Docker Setup" and "CSV Import Schema".
- **Docs site themed to match the Identity Atlas React UI** — New `docs/assets/extra.css` applies a Tailwind lime palette driven by `[data-md-color-primary=custom]` overrides, Inter / JetBrains Mono typography, rounded-2xl admonition cards with a soft lime gradient mirroring the UI dashboard, lime table headers, and lime-tinted inline code. Light + dark mode both tuned. The docs site now visually matches the React UI a user opens after `docker compose up`, instead of looking like a different product.
- **FortigiGraph → IdentityAtlas URL sweep + lead-dev removal** — Eighteen references across twelve files rewritten to point at Fortigi/IdentityAtlas, including the React dashboard's `GITHUB_BASE` and `DOCS_URL` constants, the broken Changelog link (now `/releases`), `README.md`, `docker-compose.prod.yml`, four docs pages, the PowerShell module metadata, `CLAUDE.md`, the OpenAPI contact URL, and the testing guide. Also dropped the "lead developer Wim van den Heijkant" singleton from the docs footer copyright, the about-page contact list, and the LinkedIn social icon tooltip — Identity Atlas is now positioned as a Fortigi product, not a one-developer project.
- **Identity Atlas brand logo on the docs site** — `docs/assets/logo.png` is now rendered in the docs header and as the favicon via `theme.logo` and `theme.favicon` in `mkdocs.yml`. The docs site finally has the same brand mark as the React UI.
- **Risk scoring: full port of the v4 4-layer engine to postgres** — The lightweight v5 scorer was only running Layer 1 (direct classifier match) + a 5-point small-group bonus, which missed almost everything interesting. [app/api/src/riskscoring/engine.js](app/api/src/riskscoring/engine.js) now implements all four layers with v4's exact weights (0.50 / 0.20 / 0.10 / 0.20) and layer caps (membership 40, structural 25): direct classifier matches (Layer 1), membership-based propagation through nested groups (Layer 2), structural hygiene signals (Layer 3 — orphaned ownership, dormant high-privilege accounts), and cross-entity propagation (Layer 4 — risk flowing from a high-risk resource to its members and from a high-risk identity to the resources it touches). Hierarchy walking is now postgres-native via recursive CTEs instead of the v4 in-memory traversal. Resource clustering helpers added so the wizard can group structurally similar resources into a single classifier target. Three new nightly test scripts (`Configure-LLM.ps1`, `Test-RiskScoring.ps1`, `Test-RiskScoringLLM.ps1`) cover the full pipeline including LLM provider switching. The worker container still has zero LLM dependency — risk scoring runs in the web container.
- **Fix 60 mkdocs --strict warnings on docs links to source code** — The docs workflow's second post-cutover run still failed because the previous fix only addressed broken `.md` cross-references; mkdocs `--strict` also rejects relative links to source code files that resolve outside the `docs/` tree. Rewrote all such links to absolute Fortigi/IdentityAtlas GitHub blob/tree URLs across `architecture/llm-and-risk-scoring.md` (1), `architecture/postgres-migration-status.md` (52), and `architecture/postgres-migration.md` (7). Local link scan now reports zero broken links across all 35 doc pages.
- **Fix mkdocs --strict docs build** — The first post-cutover `Deploy documentation` workflow run failed at the very first build step. Fixes: removed two dead nav entries (`sync/scheduling.md`, `ui/deployment.md`) from `mkdocs.yml`, added five orphan pages to Architecture, added a new Operations section, and updated leftover FortigiGraph references in `site_url` / `repo_url` / `repo_name` and the social link to point at Fortigi/IdentityAtlas. Rewrote 11 broken inline markdown links in `docs/architecture/postgres-migration.md` — 8 as proper mkdocs-relative paths, 3 as absolute Fortigi/IdentityAtlas GitHub blob URLs for files outside `docs/`.
- **Phase 0 static checks in nightly runner** — Mirrors the four `pr.yml` checks (PSScriptAnalyzer, ESLint, Spectral, `npm audit high`) as a fail-fast phase in `test/nightly/Run-NightlyLocal.ps1` so local nightly runs catch the same issues as the GitHub PR pipeline before spending ~10 min on Docker integration + Playwright. Each check skips cleanly when its tooling is missing and falls back to a one-shot `node:20-slim` container when `npm` is not on the host PATH.
- **Fix Remove button on external crawlers doing nothing** — DELETE `/api/admin/crawlers/:id` was failing with a 500 because the manual `DELETE FROM "CrawlerAuditLog" WHERE crawlerId = @id` query used an unquoted camelCase column name, which PostgreSQL folds to lowercase (`crawlerid`). Since `CrawlerAuditLog` already has `ON DELETE CASCADE`, the manual pre-delete was unnecessary and has been removed. Also fixed the soft-delete path which used `SET enabled = 0` instead of `= false` for the boolean column.
- **Unified step indicator across all crawler wizards** — The CSV crawler and Custom Connector wizard now use the same numbered-circle step indicator (indigo for current/completed, gray for pending, → separators) as the Entra ID crawler. Shared render logic extracted into a single `StepIndicator` component.
- **Closing a detail tab returns to the tab it was opened from** — Closing a detail tab now navigates back to the page or tab it was opened from (its originating tab), rather than jumping to an adjacent open tab. When an originating tab is itself closed, all tabs that referenced it are reparented to its origin, so the chain always resolves correctly. If no originating page is recorded (e.g. a bookmarked URL opened directly), the fallback is unchanged: Matrix for users/groups/APs, Resources for resource tabs, Org Chart for departments/contexts, Identities for identity tabs.
- **E2E tests for detail tab close navigation** — Three new Playwright test cases in `app/ui/e2e/detail-pages.spec.js`: (1) closing the active tab navigates to the originating page; (2) closing an inactive tab does not change the current URL; (3) closing an originating tab reparents its children so the cascade resolves to the grandparent. Tests that require live data in the table skip gracefully when no data is present.
- **Fix 11 Playwright E2E failures in CI** — (1) Fixed a backend bug in `DELETE /api/tags/:id` where the `GraphTags` table name was unquoted, causing PostgreSQL to fold it to lowercase and fail with "relation not found". (2) Updated `access-packages.spec.js` to expect "Business Roles" title (renamed from "Access Packages") and matching search placeholder. (3) Updated `groups-page.spec.js` to expect "Resources" title and matching search placeholder. (4) Fixed `matrix.spec.js` cold-start timing by using `waitForLoadState('networkidle')` and longer timeouts. (5) Fixed `identities.spec.js` selectors — CSS class-based locators (`[class*="card"]`) replaced with text-based locators matching actual Tailwind class output. (6) Fixed `users-page.spec.js` search test to verify navigation stability instead of assuming table visibility after search. (7) Fixed `custom-connector.spec.js` to match actual wizard step title ("Custom Connector" h3 instead of "Custom Connector — Register").
- **Fix Reset Key not updating the key prefix until page refresh** — After resetting an external crawler's API key the table showed the old key prefix until the page was reloaded. Fixed by calling `fetchCrawlers()` immediately after the reset succeeds.
- **Fix "External Crawlers" / "Custom Connectors" naming inconsistency** — The section heading on Admin → Crawlers now reads "Custom Connectors" to match the type selector and wizard title.
- **Fix identity graph truncated at the bottom on Dashboard** — The SVG height of the identity data model diagram was 360px, cutting off the bottom nodes (Contexts, Reviews) and their labels. Increased to 400px.
- **Fix Identity Members showing 0 with demo data** — `IdentityMembers` was missing from the `ANALYZE` table list in `refreshMatrixViews()`, so `pg_class.reltuples` was never updated after demo data ingestion and the dashboard estimate stayed at 0.
- **Fix dashboard showing "Crawlers: None" when external crawlers are configured** — The dashboard-stats query only counted `CrawlerConfigs` (wizard-configured Entra ID/CSV crawlers). External connectors registered via the Custom Connector wizard live in the `Crawlers` table and were not counted. Fixed to sum both tables, excluding the auto-created Built-in Worker.
- **Fix two mssql-shim SQL compatibility bugs** — (1) Toggling a crawler's enabled state passed `1`/`0` as the parameter value for a PostgreSQL `BOOLEAN` column — changed to `true`/`false`. (2) Updating a crawler config used `SYSUTCDATETIME()` (SQL Server only) — replaced with `now()`.
- **Fix unquoted camelCase column names causing 500 errors** — Two more mssql-shim routes used unquoted camelCase identifiers that PostgreSQL folds to lowercase: `GovernanceCategoryAssignments.resourceId` (category unassign endpoint) and `SystemOwners.systemId`/`userId` (remove system owner endpoint). Both queries would 500 in production. Fixed by adding double-quotes around table and column names.

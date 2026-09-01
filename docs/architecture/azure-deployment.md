# Azure deployment — Simple shape

> Companion to the Bicep in [`/azure`](https://github.com/Fortigi/IdentityAtlas/tree/main/azure).
> One-click install: see the [README's Deploy to Azure button](https://github.com/Fortigi/IdentityAtlas/blob/main/README.md#deploy-to-azure).
> **Target:** customers whose networking is owned by a central CCoE. No VNet, no private endpoints, no public IP that you provision.

## What you get

```
                                    Internet
                                       │
                                       ▼  https://<app>.azurewebsites.net
                                       │  (Microsoft-managed TLS cert)
                    ┌──────────────────────────────────────┐
                    │  App Service Plan (Linux)            │
                    │  ┌──────────────────────────────┐    │
                    │  │  App Service                 │    │
                    │  │  Pulls ghcr.io/fortigi/      │    │
                    │  │   identity-atlas:latest      │    │
                    │  │  Mounts /data/uploads        │    │
                    │  │  KV refs for master key +    │    │
                    │  │   DB password                │    │
                    │  └──────────────────────────────┘    │
                    └──────────────────────────────────────┘
                                       │
            ┌──────────────────────────┼─────────────────────────────┐
            ▼                          ▼                             ▼
   ┌──────────────────┐     ┌────────────────────┐        ┌──────────────────┐
   │ Postgres Flex    │     │ Azure Files share  │        │ Key Vault         │
   │ Public endpoint, │     │ (Storage Account)  │        │ Public endpoint,  │
   │ "Allow Azure     │     │ /data/uploads      │        │ RBAC-only.        │
   │  services"       │     │ shared with worker │        │ master key +      │
   │ firewall rule    │     └────────────────────┘        │ DB password.      │
   └──────────────────┘                                   └──────────────────┘

                ─── Container Apps Environment (Consumption, no VNet) ───
                                       │
                                       ▼
                    ┌──────────────────────────────────────┐
                    │  Container App: worker (always-on)   │
                    │  Pulls ghcr.io/fortigi/              │
                    │   identity-atlas-worker:latest       │
                    │  Mounts the same /data/uploads share │
                    │  Polls App Service /api for queued   │
                    │   crawler jobs every 60s             │
                    └──────────────────────────────────────┘
```

**Inventory: 8 resource families** (App Service Plan + App Service, Postgres, Storage, Key Vault, Log Analytics, ACA Environment, ACA App, managed identities). No VNet, no private endpoints, no NSG.

## Sizing — pick at deploy time

The Deploy-to-Azure form shows a `sizeProfile` dropdown. Pick what matches your tenant.

| Profile | App Service | Postgres | Worker | ~€/mo | Use case |
|---|---|---|---|---|---|
| **xs** | B1 (1 vCPU / 1.75 GB) | B1ms Burstable (1 vCPU / 2 GB) | 0.25 vCPU / 0.5 GB | **45** | Demo / proof-of-concept / non-production |
| **s** ✅ default | B2 (2 vCPU / 3.5 GB) | B2s Burstable (2 vCPU / 4 GB) | 0.25 vCPU / 0.5 GB | **79** | Small production — single team of analysts, < 10k principals |
| **m** | S1 (+ staging slot) | B2s Burstable | 0.25 vCPU / 0.5 GB | **113** | Mid-sized, 10-25k principals, blue/green deploys |
| **l** | P1v3 (2 vCPU / 8 GB) | D2ds_v5 GeneralPurpose (2 vCPU / 8 GB) | 0.5 vCPU / 1 GB | **244** | Large tenant, 25-50k principals, sustained throughput |
| **xl** | P2v3 (4 vCPU / 16 GB) | D4ds_v5 GeneralPurpose (4 vCPU / 16 GB) | 0.5 vCPU / 1 GB | **469** | Enterprise — 50k+ principals, multiple concurrent analyst teams |

(All West Europe, ex VAT, single replica, no HA, Linux. Costs assume BYO Log Analytics; add ~€3-5/mo if a new workspace is created.)

**Scaling later** = re-click the button (or rerun `deploy.ps1`) with a different `sizeProfile`. Azure resizes the App Service Plan + Postgres in place — no data loss, ~2-3 min of Postgres downtime while the SKU swap happens.

**One-way ratchet:** `l` and `xl` use Postgres `GeneralPurpose`. You can't scale a Postgres Flex server from `GeneralPurpose` back to `Burstable` — only within the same tier. Pick `l`/`xl` only when you actually need the GP compute.

## "Fast and snappy" design choices

- **Always On** on the App Service Plan (B1+) — no cold start on first request.
- **Worker as ACA App, always-on** — `Sync now` picks up jobs within 60s (matches the docker-compose worker behaviour).
- **App Service health probe** on `/api/health` — drops sick replicas before users hit them.
- **Postgres autogrow on, HA off** — no failover blip during a sync.
- **Materialised matrix view refreshed at end of every crawl** — matrix renders from indexed pre-computed rows.

xs has caveats under concurrent load (3+ analysts on the matrix); it's labelled "non-production." Default `s` is where snappy starts being free of caveats.

## BYO Log Analytics

If your CCoE owns a central Log Analytics workspace and you want logs forwarded there instead of creating a new one, fill in **one** of these two parameter pairs:

**Option 1 — workspace ID (preferred, 1 field):**
```
existingLogAnalyticsWorkspaceId: /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<name>
```
The template uses an `existing` resource lookup to derive the workspace customer ID + shared key. **The deployer needs `Log Analytics Reader` on the workspace.**

**Option 2 — customer ID + key (fallback when you can't read the workspace, 2 fields):**
```
existingLogAnalyticsCustomerId: <GUID>     (shown in the LA "Overview" blade as "Workspace ID")
existingLogAnalyticsSharedKey:  <primary or secondary key>
```
Use this when the deployer can't be granted Reader. The template plumbs the values through directly; no read access needed.

**Leave all three empty** → template creates a fresh workspace in your resource group (~€3-5/mo).

The deployment's outputs include `logAnalyticsCreated: true|false` so you can tell which path was taken.

## How it deploys (timing)

1. **Storage, Log Analytics (or lookup), Managed Identities, Key Vault** — all parallel, < 1 min.
2. **Bootstrap deployment script** — runs as the deployScript managed identity. Generates the master key + Postgres admin password, writes both to KV. ~30 s.
3. **Postgres Flexible Server** — slowest single step, ~3-4 min.
4. **App Service Plan + App Service** — App Service starts the container image (first pull from ghcr.io, ~1-2 min).
5. **Container Apps Environment + Worker App** — ~2 min.

**Total: ~5-7 minutes** wall clock. Output: the public URL of your Identity Atlas.

## First-run post-deploy steps

1. **Open the App URL.** First paint takes ~20-30s while the App Service container warms up (subsequent loads are sub-second because Always On is enabled).
2. **Admin → Crawlers** → "Load demo data" to explore, or "Add Crawler" to connect Microsoft Graph.
3. **(Optional) Admin → Authentication** to switch on Entra ID sign-in. Until then the app is open (so an IP allow-list at the App Service level is the recommended interim).

## Operational notes

### Startup & migrations

The web container **binds its port before running DB migrations** — migrations
run in the background right after the server starts listening. This matters on
App Service: the platform kills a container that doesn't answer on its port
within the cold-start probe window (`WEBSITES_CONTAINER_START_TIME_LIMIT`, 230s
by default), so a migration slower than that used to leave the port closed and
crash-loop the container into an "Application Error" page.

- The app comes up immediately and `/api/health` returns `200` (with a
  `schemaReady` field) while a migration is still running.
- Crawler job-claim and ingest endpoints return `503 Retry-After: 30` until the
  schema is ready, so no crawler runs against a half-migrated database. The
  worker just retries.
- If a migration fails, the container no longer crash-loops — it stays up, logs
  the error, and retries with backoff, self-healing once the cause clears.
- The template also sets `WEBSITES_CONTAINER_START_TIME_LIMIT=1800` (the 30-min
  platform max) as an extra backstop for very large one-time schema upgrades.

**Track `:latest`, not `:edge`, in production.** `:latest` is the stable
customer release; `:edge` is the latest merged commit on `main` and may carry
unvetted migrations that reach your production the moment they merge. Pin the
channel by redeploying with `imageChannel=stable` (the default) — pass
`imageChannel=edge` instead to opt into the latest `main` build.

### Updating the container images

```powershell
# Restart the App Service — re-pulls the :latest tag from ghcr.io
az webapp restart --name <namePrefix>-web --resource-group <rg>

# Restart the worker — same
az containerapp revision restart --name <namePrefix>-worker --resource-group <rg> --revision <latestRevisionName>
```

To pin to an exact version tag rather than a channel, edit `_imageTag` in `main.bicep` directly and redeploy — the CLI/portal `imageChannel` parameter only offers the `stable` / `edge` channels above.

### Logs

```bash
# App Service stdout, live
az webapp log tail --name <namePrefix>-web --resource-group <rg>

# Worker container logs, live
az containerapp logs show --name <namePrefix>-worker --resource-group <rg> --follow
```

Or query Log Analytics (whether created here or BYO):
```kql
AppServiceConsoleLogs | where _ResourceId endswith "<namePrefix>-web"
ContainerAppConsoleLogs_CL | where ContainerAppName_s == "<namePrefix>-worker"
```

### Postgres access

Postgres has a public endpoint with a firewall rule allowing Azure services. To run psql from a workstation:
1. Add a temporary firewall rule for your IP: `az postgres flexible-server firewall-rule create --resource-group <rg> --name <pgname> --rule-name temp-yourip --start-ip-address <ip> --end-ip-address <ip>`.
2. Fetch the admin password from Key Vault: `az keyvault secret show --vault-name <kv> --name postgres-admin-password --query value -o tsv`.
3. `psql "postgres://identityatlas:<pw>@<pgFqdn>:5432/identity_atlas?sslmode=require"`.
4. Delete the firewall rule when done.

### Tearing down

```bash
az group delete --name <rg> --yes
```

Key Vault has soft delete + purge protection (7-day retention). To redeploy with the same KV name within those 7 days, either wait or deploy into a different resource group — the name prefix is derived from the resource group ID, so it can no longer be chosen directly.

## Decisions taken (and why)

| Decision | Choice | Why |
|---|---|---|
| **Architecture** | App Service + Postgres Flex + ACA worker | Matches the customer's CCoE pattern — no networking provisioning. |
| **Postgres endpoint** | Public + "Allow Azure services" firewall | App Service outbound IPs come from a Microsoft-owned pool; this rule covers them without enumeration. |
| **Key Vault endpoint** | Public, RBAC-only | Access is gated by `Key Vault Secrets User` role, not network. Anonymous access returns 403. |
| **App Service image source** | Direct pull from public `ghcr.io` | No ACR needed (~€5/mo saved + simpler deploy). Add ACR later if a tenant demands a private registry. |
| **Worker model** | ACA App (always-on), not ACA Job | "Sync now" should respond in <2 s. Job would have a 60-300 s schedule lag. |
| **Master key + DB password** | Generated by deployment script, stored in KV, exposed to the app via KV references | Zero secrets in the template, the deployment history, or ARM. App reads them via managed identity at startup. |
| **Auth** | `AUTH_ENABLED=false` by default | Avoids requiring an App Registration before first login. Configurable post-deploy via Admin → Authentication. |
| **HA** | Off | Single-replica everywhere. Keeps cost predictable. |
| **Application Insights** | Skipped | Log Analytics covers stdout + system metrics. AI is for distributed tracing, not needed at this scale. |
| **VNet integration** | Not in the Simple shape | If a customer demands private Postgres / KV later, a separate "Isolated" template will add it with the customer's CCoE-provided subnet IDs. |

## Limitations

- **No HA / zone-redundancy.** Single AZ, single replica. Adding zone redundancy is two Bicep params away — future iteration.
- **No custom domain on App Service.** Free `*.azurewebsites.net` cert covers v1. Custom domain + customer TLS cert is a 2-step manual setup post-deploy.
- **No GitHub Actions deploy workflow.** Use Deploy-to-Azure button + `deploy.ps1` for now.
- **No Entra App Registration auto-creation.** Done manually if/when enabling Entra auth.
- **Public Postgres / KV endpoints.** A future "Isolated" template will add private endpoints when a customer wants them.

## File index

| File | Purpose |
|---|---|
| [`azure/main.bicep`](https://github.com/Fortigi/IdentityAtlas/blob/main/azure/main.bicep) | Top-level orchestrator |
| [`azure/main.json`](https://github.com/Fortigi/IdentityAtlas/blob/main/azure/main.json) | Compiled ARM (used by the Deploy to Azure button) |
| [`azure/main.parameters.example.json`](https://github.com/Fortigi/IdentityAtlas/blob/main/azure/main.parameters.example.json) | Example parameter file |
| [`azure/deploy.ps1`](https://github.com/Fortigi/IdentityAtlas/blob/main/azure/deploy.ps1) | CLI deploy + post-deploy summary |
| `azure/modules/log-analytics.bicep` | New workspace OR BYO lookup OR pass-through |
| `azure/modules/storage.bicep` | Storage Account + Azure Files share |
| `azure/modules/identities.bicep` | 2 user-assigned managed identities |
| `azure/modules/key-vault.bicep` | Key Vault + RBAC (public endpoint) |
| `azure/modules/bootstrap.bicep` | One-shot deployment script for secrets |
| `azure/modules/postgres.bicep` | Postgres Flex + firewall |
| `azure/modules/app-service.bicep` | App Service Plan + App Service for Containers |
| `azure/modules/aca-env.bicep` | Container Apps Environment (Consumption) |
| `azure/modules/aca-app-worker.bicep` | Worker Container App (always-on) |

# Azure deployment

> Companion to the Bicep templates in [`/azure`](../../azure).
> One-click install: see the [README's Deploy to Azure button](../../README.md#deploy-to-azure).

## What you get

A production-shaped Identity Atlas environment on Azure:

```
                                    Internet
                                       │
                                       ▼  HTTPS  (Entra ID auth optional)
                    ┌──────────────────────────────────────┐
                    │  Container App  •  WEB               │
                    │  Public ingress, IP-allowlist option │
                    │  Mounts /data/uploads (Azure Files)  │
                    │  Reads master key + DB URL from KV   │
                    └──────────────────────────────────────┘
                                       │ HTTPS internal
                                       ▼
                    ┌──────────────────────────────────────┐
                    │  Container App  •  WORKER (no ingress)│
                    │  Same image family, scheduler.ps1    │
                    │  Mounts the same /data/uploads share  │
                    └──────────────────────────────────────┘
                                       │ private endpoint
                                       ▼
                    ┌──────────────────────────────────────┐
                    │  Postgres Flexible Server            │
                    └──────────────────────────────────────┘

  All resources sit inside a VNet (10.40.0.0/16) with two subnets:
    - apps (10.40.0.0/23) — delegated to Container Apps
    - pe   (10.40.2.0/24) — Postgres + Key Vault private endpoints
```

**Out of band:** Azure Container Registry (basic SKU, public network — Container Apps pull via managed identity), Log Analytics workspace, Storage Account + Azure Files share, three user-assigned managed identities, two private DNS zones (postgres + Key Vault).

## Cost (West Europe, ex VAT)

| Resource | Default | ~€/mo |
|---|---|---|
| Postgres Flexible — `Standard_B2s`, 32 GB, no HA | Burstable | 34 |
| 2× Container Apps (web 1 vCPU/2 GB, worker 0.5 vCPU/1 GB, mostly idle) | Consumption | 40–50 |
| Azure Container Registry | Basic | 5 |
| Key Vault + private endpoint | Standard | 8 |
| Storage Account + 5 GiB Azure Files | Standard LRS | 2 |
| VNet + NSGs + 2× private DNS zones + 2× private endpoints | — | 8–10 |
| Log Analytics | PerGB2018 (~1 GB/mo) | 5 |
| **Total** | | **~€100–110** |

Scale up: switch Postgres to `Standard_D2ds_v5` for steady GP load (+€60). Enable Postgres zone-redundant HA (+100%). Bump web `maxReplicas` for traffic spikes.

## How it deploys

1. **One-click button** in the README opens `https://portal.azure.com/#create/Microsoft.Template/uri/...` pointing at the compiled `main.json` on the `main` branch.
2. **Portal form** asks for a resource group, location, and prefix.
3. **`az deployment group create`** under the hood walks the Bicep dependency tree:
   - VNet, subnets, NSGs, Log Analytics, 3× managed identities, ACR, private DNS zones — all parallel.
   - Key Vault + private endpoint (depends on subnet + DNS zone).
   - **Bootstrap deployment script** (`Microsoft.Resources/deploymentScripts`) runs as the deploy-script managed identity. It:
     1. Generates a 32-byte master key, writes it to KV as `identityatlas-master-key`.
     2. Generates a Postgres admin password, writes it to KV as `postgres-admin-password`.
     3. `az acr import`s both `identity-atlas:edge` and `identity-atlas-worker:edge` from `ghcr.io/fortigi` into the new ACR.
     4. Idempotent — re-running the deploy doesn't rotate secrets or re-import unless you bump `bootstrapForceTag`.
   - Postgres Flexible Server with private endpoint (depends on bootstrap → reads the password back via `kvForSecrets.getSecret(...)`).
   - Storage Account + Azure Files share.
   - Container Apps Environment (VNet-integrated, Log Analytics-connected, with the file share registered as a named storage).
   - Web Container App + Worker Container App.

Total deploy time: ~15 minutes.

## Decisions baked in

| Decision | Choice | Rationale |
|---|---|---|
| **Master key** | Generated at deploy time → Key Vault → injected as `IDENTITY_ATLAS_MASTER_KEY` env var via `secretRef`. | The app already reads this env var. Zero code change. |
| **Postgres auth** | Password-based. Password lives in KV; the web app reads it via managed identity. | Ships fast. Entra-to-Postgres needs a Node `pg` Entra plugin we don't have. |
| **Easy Auth on web** | Off. The app handles authentication via its existing flow (Admin → Authentication enables Entra). | Avoids forcing an App Registration before first login. The existing UI is designed for this. |
| **Worker ingress** | None at all. The worker only makes outbound calls to the web app. | Simpler than "internal-only" ingress; Container Apps supports no-ingress mode. |
| **HA** | Off. Single replica, single AZ. | Keeps cost at ~€110/mo. One Bicep flag away. |
| **Image source** | `az acr import` from public `ghcr.io/fortigi/identity-atlas[:tag]` → private ACR. | One-shot import, no build infra in Azure. Pinning to a release tag is a parameter change. |
| **Shared `/data/uploads`** | Azure Files share mounted in both Container Apps. | Built-in worker API key, CSV uploads — both apps need to see the same files. |
| **Public ACR (basic SKU)** | Acceptable. Container Apps pull via managed identity (AcrPull). | Premium SKU + private endpoint adds €50/mo and only matters if outside-the-VNet pulls are a concern. |

## First-run post-deploy steps

1. **Open the app URL** from the deployment outputs. First paint may take ~30s while the web container warms up.
2. **Load demo data** via Admin → Crawlers → "Load demo data", or **add a real crawler** with Microsoft Graph credentials.
3. **(Optional) enable Entra ID sign-in.** Admin → Authentication → toggle Entra ID, fill in tenant + client ID. This is read from a DB-backed config and takes effect for new browser sessions immediately — no redeploy needed.

## Operational notes

### Updating to a new image

```powershell
./azure/import-image.ps1 -ResourceGroup ia-prod -WebTag 5.30.20260518.1154 -WorkerTag 5.30.20260518.1154
```

The script reads the ACR from the resource group, runs `az acr import --force`, and restarts the Container App revisions so they pull the new `:latest`.

To re-import the `:edge` tag (e.g. after a `main` merge), call with no `-WebTag/-WorkerTag` (defaults to `edge`).

### Logs

`az containerapp logs show --name <namePrefix>-web --resource-group <rg> --follow` — streams the web container's stdout. Same for `-worker`. Or query Log Analytics: `ContainerAppConsoleLogs_CL | where ContainerAppName_s == 'identityatlas-web'`.

### Database access

Postgres has no public endpoint. To run psql:
1. Connect a workstation to the VNet via Bastion, point-to-site VPN, or a private peering.
2. Resolve the FQDN via the private DNS zone (`<server>.privatelink.postgres.database.azure.com`).
3. Fetch the admin password from Key Vault: `az keyvault secret show --vault-name <kv> --name postgres-admin-password --query value -o tsv`.

### Backups

Postgres Flexible Server's automated backups are on by default (7-day retention, geo-redundant-backup disabled). To restore: Portal → Postgres → Restore. Container Apps state is ephemeral; the file share holds the master key (auto-regenerable on a fresh deploy if you keep the KV).

### The "ME_…" resource group that appears next to yours

After the deployment Azure creates a second resource group with a name like `ME_identityatlas-cae_<yourRg>_<region>`. This is the **Managed Environment infrastructure RG** — Container Apps puts the load balancer and other Microsoft-managed plumbing there. You can't put anything in it and shouldn't touch it. It's deleted automatically when the Container Apps Environment in your main RG is deleted.

### Tearing down

`az group delete --name <rg> --yes` deletes everything. Key Vault has soft delete with 7-day retention plus **purge protection** enabled — to fully reclaim the KV name within those 7 days you'd need to wait, OR delete the KV with `--purge`-able config (not the current setting). Adjust the `enablePurgeProtection` in `azure/modules/key-vault.bicep` if you want easier teardowns in dev environments.

## Limitations of this first cut

- **No GitHub Actions deploy workflow.** Re-deploys / drift detection are out of scope for the first PR. Use `deploy.ps1` for manual re-runs.
- **No App Registration auto-creation.** ARM templates can't create Entra App Registrations cleanly (needs Graph API access). User does this manually if/when enabling Entra auth.
- **No zone-redundancy.** Single-AZ. Add `zoneRedundant: true` on Postgres + the Container Apps Environment in a future PR if needed.
- **No Application Insights.** Skipped per the design review. Log Analytics covers Container Apps console + system metrics; AI is the missing piece for distributed tracing.
- **ACR is Basic / public network.** Pull via managed identity is RBAC-enforced. If your tenant requires private ACR, switch SKU to Premium and add a third private endpoint mirroring `key-vault.bicep`.

## Lightweight alternative

If €110/mo is too much for a small deployment, a single B2s VM running `docker-compose.prod.yml` brings total cost to ~€42/mo. Tradeoffs: manual patching, no managed Postgres backups, no Key Vault, no VNet isolation. **Not** included in this PR — separate roadmap item.

## File index

| File | Purpose |
|---|---|
| `azure/main.bicep` | Top-level orchestrator |
| `azure/main.json` | Compiled ARM (committed for the Deploy to Azure button) |
| `azure/main.parameters.example.json` | Example parameter file |
| `azure/deploy.ps1` | CLI deploy + post-deploy summary |
| `azure/import-image.ps1` | Re-import images into an existing ACR |
| `azure/modules/*.bicep` | One module per resource family (network, KV, Postgres, etc.) |

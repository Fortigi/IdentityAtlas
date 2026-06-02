# Identity Atlas (FortigiGraph)

> Universal authorization intelligence — sync, analyze, and govern permissions from any identity system.

Permissions are scattered across identity systems, directories, and SaaS platforms. Identity Atlas syncs them all into a unified PostgreSQL model with trigger-based audit history, surfaces access gaps and risks through a visual role mining UI, and adds LLM-assisted identity risk scoring — without sending sensitive identity data to any external service. Source systems include Entra ID, Omada, SailPoint, SAP/Pathlock, SharePoint, Azure RBAC, Azure DevOps, or any system that can produce a CSV export.

## Quick Start

**Prerequisites:** Docker and Docker Compose. See [Sizing](docs/architecture/docker-setup.md#sizing) for RAM/disk guidance — 4 GB suffices for a demo or a small tenant, but tenants above ~2k principals with activity sync enabled should plan for 12 GB or more.

```bash
# 1. Download the compose file and environment template
curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/setup/config/.env.example

# 2. Create your .env file
cp .env.example .env
# For a quick local evaluation the defaults are fine.
# For any networked or production deployment, open .env and set:
#   POSTGRES_PASSWORD=<strong-password>
#   IDENTITY_ATLAS_MASTER_KEY=<random-32-char-string>

# 3. Start the stack (first run: ~2 min to pull images; --pull always ensures
#    Docker fetches the newest :latest instead of reusing a cached copy)
docker compose -f docker-compose.prod.yml up -d --pull always

# 4. Open http://localhost:3001
#    Go to Admin > Crawlers, then click "Load Demo Data" to explore with sample data, or
#    click "Add Crawler" to connect your Entra ID tenant.
```

The in-browser crawler wizard walks you through credentials, permission validation, object type selection, and scheduling — no PowerShell or command-line setup required.

> **Image channels:** The default pulls the latest stable release (`:latest`). To run the development build instead, set `IMAGE_TAG=edge` in your `.env`. See [Docker Setup](docs/architecture/docker-setup.md) for details.

---

## Deploy to Azure

<a href="https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2FFortigi%2FIdentityAtlas%2Fmain%2Fazure%2Fmain.json" target="_blank" rel="noopener noreferrer"><img src="https://aka.ms/deploytoazurebutton" alt="Deploy to Azure"></a>

One-click install into your Azure subscription. The deployment uses PaaS services that any Azure-Subscription-owner can deploy without touching central networking:

- **App Service for Linux Containers** (web) — pulls `ghcr.io/fortigi/identity-atlas:latest`. Managed public HTTPS with auto-renewed TLS.
- **Postgres Flexible Server** — public endpoint, firewall rule restricted to Azure services.
- **Key Vault** — holds the auto-generated master key + DB password. App Service reads via managed identity.
- **Storage Account + Azure Files share** — `/data/uploads` shared with the worker.
- **Container Apps Environment + worker app** — always-on, no ingress, runs the crawler scheduler.
- **Log Analytics** — auto-created OR bring your own (single parameter).

**Pick a size at deploy time:**

| Profile | ~€/mo | Use case |
|---|---|---|
| **xs** | 45 | Demo / proof-of-concept |
| **s** ✅ | 79 | Small production — single team of analysts, <10k principals (default) |
| **m** | 113 | 10-25k principals, blue/green via App Service staging slot |
| **l** | 244 | 25-50k principals, GP Postgres compute |
| **xl** | 469 | 50k+ principals, enterprise concurrent use |

Deployment is three steps. **Auth is ON from the first deploy** — visiting the Web App's URL after Step 1 shows a "Set up Entra ID" page with the exact remaining steps. There is no usable open-mode state, so a customer can't accidentally use an unauthenticated instance.

1. **Step 1 — Deploy the app stack** ([`azure/main.json`](azure/main.json)). Click the **Deploy to Azure** button above. The form takes `sizeProfile`, `imageChannel`, and optionally a BYO Log Analytics workspace. ~6 min. After it finishes, opening the URL shows the **Entra ID setup required** page.
2. **Register an Entra App Registration** in your tenant using the URL from Step 1 as the SPA redirect URI, then expose an `access` API scope. ~5 min in the portal — the setup page on the deployed Web App walks you through it.
3. **Set the IDs as env vars** on the Web App (`AUTH_TENANT_ID`, `AUTH_CLIENT_ID`). Web App → Environment variables → Apply. ~1 min. The Web App restarts; refresh and you'll sign in with Entra.

Full step-by-step (permissions, RP registration, App Reg setup, troubleshooting, "how to change X later"): [docs/architecture/azure-deployment-walkthrough.md](docs/architecture/azure-deployment-walkthrough.md).

For the architecture, scaling, and ops notes: [docs/architecture/azure-deployment.md](docs/architecture/azure-deployment.md).

**CLI alternative** if you'd rather script it:

```powershell
git clone https://github.com/Fortigi/IdentityAtlas.git
cd IdentityAtlas/azure
./deploy.ps1 -ResourceGroup ia-prod -SizeProfile s
```

**Customer with strict no-public-endpoint policy?** The Simple shape uses public endpoints (with RBAC + firewall) for Postgres and Key Vault. A future Bicep template (`azure/main-isolated.bicep`, separate PR) wraps everything in a customer-CCoE-provided VNet with private endpoints. Tracked for v2.

---

## Portable Windows Launcher

For environments where Docker and WSL are blocked by security policy — no installation, no administrator rights required.

Download `IdentityAtlas-portable.zip` from the [Releases page](https://github.com/Fortigi/IdentityAtlas/releases), extract, and run:

```powershell
pwsh -ExecutionPolicy Bypass -File .\Start-IdentityAtlas.ps1
```

Then open `http://localhost:3001`. To load the bundled demo dataset:

```powershell
.\bundled-scripts\test\demo-dataset\Ingest-DemoDataset.ps1 `
    -ApiKey (Get-Content "$env:APPDATA\IdentityAtlas\.builtin-worker-key")
```

The launcher bundles the official signed `node.exe` from nodejs.org (OpenJS Foundation certificate), so it works on locked-down corporate laptops with WDAC / application-control policies. Uses [PGlite](https://pglite.dev) (WebAssembly PostgreSQL) running in-process — no subprocess is spawned, no executable is extracted to disk at runtime.

Requires PowerShell 7 (`pwsh.exe`): `winget install Microsoft.PowerShell`

For the full guide and architecture notes: [docs/architecture/desktop-portable.md](docs/architecture/desktop-portable.md)

---

## What Identity Atlas Does

### Unified Permission Model
- Stores permissions from any system in a single PostgreSQL schema: Systems, Resources, Principals, ResourceAssignments, ResourceRelationships
- Trigger-based audit history tracks every change as JSONB snapshots in a shared `_history` table
- Business roles, governed assignments, and resource grants share the same tables as direct permissions

### Role Mining UI
- Visual permission matrix with IST/SOLL comparison (actual vs governed access)
- Business role management with category-based column grouping and multi-type membership badges
- Entity detail pages for users, groups, and business roles with full version history
- Excel export, drag-and-drop row reordering, and server-side scaling for large environments

### Identity Risk Scoring
- LLM-assisted organizational profiling and classifier generation (public context only — no identity data sent externally)
- Multi-provider LLM support: Anthropic Claude, OpenAI, and Azure OpenAI
- Four-layer scoring: direct classifier match, membership analysis, structural hygiene, cross-entity propagation
- Risk tiers from Critical (90-100) to None (0), with analyst override controls and full audit trail

### Multi-System Governance
- Native sync for Entra ID (users, groups, PIM, access packages, app roles, directory roles)
- CSV-based import for any other system (Omada, SailPoint, SAP/Pathlock, SharePoint, Azure RBAC, DevOps)
- Ingest API for building custom crawlers in any language

---

## Supported Source Systems

| System | Sync Method | What Gets Synced |
|--------|-------------|------------------|
| Entra ID / Azure AD | Built-in Graph API sync | Users, groups, PIM eligibility, app roles, directory roles, access packages, access reviews |
| Omada, SailPoint, SAP/Pathlock | CSV import | Business roles, role assignments, certifications, policies |
| SharePoint, Azure RBAC, DevOps | CSV import | Resources, resource assignments, resource relationships |
| Any system | CSV import or Ingest API | Principals, resources, assignments — any authorization data |

---

## PowerShell SDK

The FortigiGraph PowerShell module is available separately for users who want to interact with Microsoft Graph API directly or run crawlers outside Docker.

```powershell
Install-Module -Name FortigiGraph -Scope CurrentUser
```

See [tools/powershell-sdk/](tools/powershell-sdk/) for the Graph API wrapper functions.

---

## Documentation

Full docs at **[https://fortigi.github.io/IdentityAtlas](https://fortigi.github.io/IdentityAtlas)** (available once GitHub Pages is enabled).
Browse locally in the [`docs/`](docs/) folder.

| Section | Link |
|---------|------|
| Quick Start | [docs/quickstart.md](docs/quickstart.md) |
| Data Model | [docs/concepts/data-model.md](docs/concepts/data-model.md) |
| Governance Model | [docs/concepts/governance-model.md](docs/concepts/governance-model.md) |
| CSV Import | [docs/sync/csv-import.md](docs/sync/csv-import.md) |
| Ingest API | [docs/architecture/ingest-api.md](docs/architecture/ingest-api.md) |
| Risk Scoring | [docs/risk-scoring/overview.md](docs/risk-scoring/overview.md) |
| Role Mining UI | [docs/ui/overview.md](docs/ui/overview.md) |
| API Reference | [docs/api/index.md](docs/api/index.md) |
| Docker Setup | [docs/architecture/docker-setup.md](docs/architecture/docker-setup.md) |

---

## Contributing / License

Identity Atlas is open source under the [MIT License](LICENSE).
Contributions are welcome — see the [GitHub repository](https://github.com/Fortigi/IdentityAtlas) to open issues or pull requests.

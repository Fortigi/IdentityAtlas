# Identity Atlas (FortigiGraph)

> Universal authorization intelligence — sync, analyze, and govern permissions from any identity system.

Permissions are scattered across identity systems, directories, and SaaS platforms. Identity Atlas syncs them all into a unified PostgreSQL model with trigger-based audit history, surfaces access gaps and risks through a visual role mining UI, and adds LLM-assisted identity risk scoring — without sending sensitive identity data to any external service. Source systems include Entra ID, Omada, SailPoint, SAP/Pathlock, SharePoint, Azure RBAC, Azure DevOps, or any system that can produce a CSV export.

## Quick Start

**Prerequisites:** Docker and Docker Compose.

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

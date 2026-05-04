# FortigiGraph - AI Assistant Development Guide

> **IMPORTANT: After making ANY code changes, you MUST add a changelog fragment!**
> 1. Create or update `changes/<branch-name>.md` (e.g. `changes/fix-mssql-shim-boolean.md`) with bullet points describing the functional change (user-facing language, not implementation details).
> 2. Do **NOT** edit `CHANGES.md` directly — the `bump-version.yml` Action merges all fragments into it on PR merge.
> 3. Do **NOT** edit `ModuleVersion` in `setup/IdentityAtlas.psd1` — version bumps are also automated by the same Action.
> This eliminates merge conflicts on both files.

## Project Overview

Identity Atlas is a Docker-deployed application that pulls authorization data from Microsoft Graph (and other systems via CSV) into a **PostgreSQL** database, then surfaces it through a React role-mining UI. The worker container ships PowerShell crawler scripts but no longer touches the database directly — all persistence flows through the Node.js API.

**v5 architectural change (April 2026):** The database backend moved from SQL Server to PostgreSQL. SQL Server Developer Edition is free for development but cannot be used in production per Microsoft's EULA, and SQL Server Express has a 10 GB hard cap that's too small for the tenants Identity Atlas targets. Postgres has no licensing surface and no size limits. Temporal tables were dropped — they had no native postgres equivalent and were unused in practice. The v4 schema files lived in `app/db/*.ps1` (deleted in v5); the new schema is a versioned set of `.sql` files in `app/api/src/db/migrations/` applied automatically by the web container at startup. See [docs/architecture/postgres-migration.md](docs/architecture/postgres-migration.md) for the full migration plan.

**Key Information:**
- **Languages:** PowerShell (crawlers), JavaScript (Node API + React UI), SQL (postgres migrations)
- **Primary Purpose:** Microsoft Graph API wrapper with PostgreSQL data persistence (Docker-hosted)
- **Author:** Wim van den Heijkant
- **Company:** Fortigi
- **GitHub:** https://github.com/Fortigi/IdentityAtlas
- **Distribution:** PowerShell Gallery
- **Current Version:** 5.x.yyyyMMdd.HHmm (auto-bumped by `bump-version.yml` on every PR merge to `main`)

---

## Branching & Versioning Strategy

> **These are hard rules. Always follow them exactly.**

### Branch Model

| Branch | Purpose | PR required? | Approval required? |
|--------|---------|-------------|-------------------|
| `main` | Integration trunk. Never commit directly. Merges push `:edge` Docker tag. | Yes | Yes (at least 1) |
| `feature/<name>` | All feature work. Created from `main`. Merged back to `main` via PR. | Yes (to `main`) | No |
| `bugfixes/<name>` | Bug fixes. Branch from `main` for pre-release fixes; branch from a **release tag** for hotfixes. | Yes (to `main`) | No |

**Rules:**
- `feature/` branches must be branched off `main`.
- `bugfixes/` branches branch from `main` for pre-release fixes. For hotfixes to an already-released version, branch from the release tag: `git checkout -b bugfixes/fix-foo v5.2.0`.
- Hotfix commits must be cherry-picked back to `main` via a separate PR so the fix is included in future releases.
- All merges go through a Pull Request — no direct pushes to `main` ever.
- Branch names: `feature/<short-descriptive-name>` or `bugfixes/<short-descriptive-name>` (lowercase, hyphens). Example: `feature/risk-score-export`, `bugfixes/fix-login-redirect`.
- When starting work, always create a new branch. Never work directly on `main`.
- **One issue per branch.** Each branch must fix exactly one issue or implement exactly one feature. Never combine fixes for separate, unrelated issues into a single branch or PR. Exception: if a single code change genuinely resolves more than one issue (e.g. the same root cause), both issue numbers may be referenced in the commit and PR — but this should be rare and the connection must be explicit.

### Version Number Scheme

Two formats, both 4-part (PowerShell-compatible):

| Context | Version format | Example | Docker tag pushed |
|---------|---------------|---------|-------------------|
| `main` dev builds | `Major.Minor.yyyyMMdd.HHmm` | `5.3.20260419.1430` | `:edge` |
| Release tags (`v*`) | `Major.Minor.Patch.0` | `5.2.1.0` | `:latest` |
| `feature/*` / `bugfixes/*` | — | — | Nobody |

The timestamp format on `main` makes dev builds instantly recognisable. Release versions use `Major.Minor.Patch.0` (patch increments for each hotfix).

**Who updates versions:**

| Context | Who updates it | When |
|---------|---------------|------|
| `main` dev builds | `bump-version.yml` (automated) | Every PR merge — increments `Minor`, updates timestamp |
| Release tags | `cut-release.yml` / `cut-hotfix.yml` (automated) | When you run Actions → Cut Release or Cut Hotfix |
| `feature/*` / `bugfixes/*` | **Nobody** | Never touch `setup/IdentityAtlas.psd1` on a branch |

**How to apply:**

1. **Starting a feature or pre-release bugfix branch**: Branch from `main`. Leave `setup/IdentityAtlas.psd1` untouched.
2. **Starting a hotfix branch**: Branch from the release tag (`git checkout -b bugfixes/fix-foo v5.2.0`). Leave `setup/IdentityAtlas.psd1` untouched.
3. **After any code change on a branch**: Add bullets to `changes/<branch-name>.md`. Do not edit `CHANGES.md` or `ModuleVersion`.
4. **When merging → main via PR**: `bump-version.yml` increments Minor + timestamp. `docker-publish.yml` builds and pushes `:edge` + versioned tag.
5. **Cutting a release**: Run Actions → Cut Release, enter `Major.Minor.Patch` (e.g. `5.2.0`). Tags `v5.2.0` on current `main` HEAD; `docker-publish.yml` pushes `:latest` + `:5.2.0.0`.
6. **Shipping a hotfix**: Run Actions → Cut Hotfix, enter the branch name and new version (e.g. `5.2.1`). Tags `v5.2.1` on the hotfix branch HEAD; `docker-publish.yml` pushes `:latest` + `:5.2.1.0`.
7. **Major version bump**: Edit `setup/IdentityAtlas.psd1` manually on `main` (via a PR) for a breaking change. Increment `Major`, reset `Minor` to `0`.

### Changelog fragments (replaces direct CHANGES.md edits)

Every feature/bugfixes branch must add a fragment file under `changes/`. **Never edit `CHANGES.md` directly** — the `bump-version.yml` Action merges all fragments into it on PR merge, eliminating merge conflicts.

- **Filename:** `changes/<descriptive-name>.md` — use the branch name or a short slug (e.g. `changes/fix-mssql-shim-boolean.md`). One file per branch is typical; the name just needs to be unique across open PRs.
- **Content:** Bullet points only. User-facing language. No implementation details.
- `CHANGES.md` itself is append-only and owned by CI — never edit it on a branch.

**Fragment format:**
```markdown
- <Functional description of change 1>
- <Functional description of change 2>
```

**Rules for writing entries:**
- Write in user-facing language ("Added X", "Fixed Y", "Improved Z").
- Do not describe internal refactors unless they affect observable behavior.
- Add a bullet immediately after each meaningful change — don't batch them up at the end.

---

## Major Features

> **v6 note (Context Redesign, April 2026):** Contexts became a first-class
> unified data surface. There is now a single `Contexts` table with three
> variants (synced / generated / manual) and four target types (Identity /
> Resource / Principal / System). Membership lives in `ContextMembers`.
> Legacy feature tables — `OrgUnits`, `GraphResourceClusters`,
> `GraphResourceClusterMembers`, the `Identities.contextId` column, and the
> old `GraphTags` / `GraphTagAssignments` tables — are gone. Tags are now
> `contextType='Tag'` Contexts (with backward-compat views so existing JOIN
> queries keep working). Clustering, org-chart derivation, tags, business
> processes are all context-algorithm plugins that register at startup and
> emit generated Contexts. See `docs/architecture/context-redesign.md` and
> `docs/architecture/context-redesign-plan.md` for the design.

### 1. In-Browser Crawler Wizard
- The Crawlers page in Admin walks the user through Microsoft Graph credentials → permission validation → object type selection → identity filter → custom attributes → schedules
- Works against any Entra ID tenant without leaving the browser

### 2. Microsoft Graph API Integration
- Easy authentication (service principal & interactive)
- Automatic token refresh and pagination handling
- CRUD operations for Azure AD/Entra ID resources
- Required permissions: `User.Read.All`, `Group.Read.All`, `GroupMember.Read.All`, `Directory.Read.All`, `EntitlementManagement.Read.All`, `AccessReview.Read.All`, `AuditLog.Read.All`

### 3. PostgreSQL Database (v5)
- **Audit History**: Trigger-based change tracking via shared `_history` table with JSONB snapshots
- **Automatic Migrations**: Versioned `.sql` files in `app/api/src/db/migrations/` applied on startup
- **High-Performance Sync**: Bulk upsert operations via the Ingest API
- **Legacy PowerShell SQL functions**: Still available for backward compatibility but no longer used in Docker deployment

### 4. Identity Governance & Compliance Sync
- **Complete Access Package Sync**: Catalogs → GovernanceCatalogs, packages → Resources (`resourceType='BusinessRole'`), assignments → ResourceAssignments (`assignmentType='Governed'`), resource scopes → ResourceRelationships (`relationshipType='Contains'`), policies → AssignmentPolicies, requests → AssignmentRequests, reviews → CertificationDecisions
- **Group Membership Sync**: Direct, transitive, eligible (PIM), and owner relationships
- **Orchestrated Sync**: `Start-FGSync` orchestrates all Entra ID operations; `Start-FGCSVSync` orchestrates CSV-based imports for external systems
- **Parallel Execution**: Up to 6 entity types concurrently via runspace pool
- **CSV Import**: Canonical schema with 9 file types (Systems, Resources, Users, Assignments, ResourceRelationships, Contexts, Identities, IdentityMembers, Certifications). Source-specific transforms happen outside the crawler — see `tools/csv-templates/transforms/`. Schema templates downloadable from Admin → Crawlers. Auto-classifies Direct assignments to BusinessRole resources as Governed. See [docs/architecture/csv-import-schema.md](docs/architecture/csv-import-schema.md)
- **Analytical Views**: 12+ SQL views for IST vs SOLL analysis, approval metrics, access reviews

### 5. Docker Deployment
- All services run in Docker containers: PostgreSQL 16, web (Node.js API + React frontend), worker (PowerShell crawlers + scheduler)
- Crawler scheduling lives in the `CrawlerConfigs` SQL table; the worker polls every minute and queues jobs
- See [docker-setup.md](docs/architecture/docker-setup.md) for full architecture and operations

### 6. Role Mining UI
- **Web Application**: React + Vite + Tailwind + TanStack Table v8 served by the `web` Docker container on port 3001
- **Authentication**: Optional Entra ID (MSAL) with support for both v1 and v2 token formats; defaults to no-auth for local Docker
- **Tab Navigation**: Matrix, Users, Resources, Systems, Access Packages, Sync Log, Risk Scoring, Identities, **Contexts**, Performance — plus dynamic detail tabs. Optional tabs (Risk Scores, Identities, Performance) are hidden by default and can be enabled per-user via the settings dropdown. Contexts replaces the former Org Chart tab; manager-hierarchy trees now come from the `manager-hierarchy` context-algorithm plugin.
- **User Preferences**: Clicking the user avatar in the top-right opens a settings dropdown with toggle switches for optional tabs. Preferences are stored per-user in the `GraphUserPreferences` SQL table (auto-created). User identified by Entra ID `oid` claim; `anonymous` fallback for no-auth mode.
- **Matrix View**: User-group permission heatmap with drag-and-drop row reordering
- **Staircase Sort**: Default row order groups rows by their leftmost AP bucket, creating a visual staircase pattern; unmanaged groups at the bottom. Custom drag order persists via versioned localStorage (bump `ROW_ORDER_VERSION` in `useMatrixRowOrder.js` when changing default sort logic)
- **Multi-Type Badges**: Cells show individually colored badges per membership type (D, I, E); multi-type cells show all badges side by side
- **Owner Row Separation**: Owner (O) memberships are shown in separate rows suffixed with "(Owner)". D, I, E stay together; ownership is a fundamentally different relationship. Synthetic rows use `id: groupId__owner` with `realGroupId` pointing to the original group
- **Access Package Coloring**: Each AP gets a distinct color from a 15-color palette; managed cells are colored by their governing AP
- **Multi-AP Indicator**: Cells managed by multiple access packages show a count badge
- **Access Package Categories**: Categories are single-assignment labels for access packages (unlike tags, an AP can only have one category). Categories are managed on the Access Packages page. Stored in `GraphCategories` and `GraphCategoryAssignments` SQL tables (auto-created). Categories drive the AP column ordering in the Matrix view.
- **Access Package Columns**: SOLL columns sorted first by category name, then by total assignment count within each category; uncategorized APs appear at the end. Category boundaries are marked with thicker borders and a colored indicator stripe.
- **IST/SOLL Toggle**: Filter matrix to show managed (SOLL), unmanaged (IST), or all assignments
- **Column Header Filters**: Type and Tags columns have filter dropdowns; Tags includes a "(Blank)" option (sentinel `BLANK_TAG`) to show groups without tags
- **Server-Side User Limit**: Slider (default 25) limits data at the SQL level for large environments
- **Excel Export**: Full matrix export with AP columns next to users (matching on-screen layout), AP-colored cells, rich-text multi-type badges, and multi-AP notes
- **Entity Detail Pages (April 2026)**: User, Identity, Resource, and Business Role detail tabs share a three-region layout: an "Attributes" table on the left that merges real columns with `extendedAttributes` JSONB, and a radial relationship graph on the right with the entity in the middle. Clicking a graph node fans out its list items as satellite nodes; clicking a satellite (user/resource/AP/identity/context) drills further into that entity's own relationship ring. "Recently Added" / "Recently Removed" root-ring nodes appear when the entity has changes in the last 30 days, coloured amber/rose respectively; individual items added in that window also render in amber when they appear inside regular fanouts. Hash-based routing (`#user:id` / `#group:id` / `#access-package:id` / `#identity:id`) supports bookmarking; multiple tabs can be open at once. See [docs/architecture/entity-detail-pages.md](docs/architecture/entity-detail-pages.md).
- **Recent Changes Timeline**: Collapsible panel on every entity detail page backed by the `_history` audit table. Shows only relationship-level events (assignments in/out, manager changes, resource containment shifts, identity-member links) — the things that typically cause permission-related support calls. Each event links to the counterparty's detail tab. Endpoint: `GET /api/<kind>/:id/recent-changes?sinceDays=30`. Migration 018 was required because the three composite-PK tables (`ResourceAssignments`, `ResourceRelationships`, `IdentityMembers`) were previously silent in `_history` — the trigger only keyed off `id`, which those tables don't have.
- **Access Package Detail Page**: Same graph + recent-changes treatment as users/resources. Root ring: Assignments · Resources · Policies · Reviews · Pending Requests · Catalog. Each node drills into its items; Assignments fans out to users, Resources fans out to the groups contained in the role, etc.
- **Performance Monitoring**: ON by default (Performance page in Admin); `PERF_METRICS_ENABLED=false` opts out at startup. Server-side middleware captures per-request timing with per-SQL-query breakdowns. `Server-Timing` HTTP headers appear in browser DevTools. Performance sub-tab shows endpoint summaries (P50/P95/P99), recent requests, and slowest requests. Export JSON for offline analysis. Ring buffer (1000 entries) — zero overhead when disabled.
- **Deployment**: `docker compose up -d` — all services run in containers, configured via the in-browser wizard (Admin → Crawlers)

### 7. Identity Risk Scoring (v5 — in-app)
**v5 architecture (April 2026):** Risk scoring is now driven entirely from the
UI. The PowerShell helpers were retired during the postgres rewrite. The new
flow lives behind Admin → Risk Scoring → "New profile" and runs through a
multi-step wizard. See [docs/architecture/llm-and-risk-scoring.md](docs/architecture/llm-and-risk-scoring.md) for the full design.

- **In-browser wizard**: Sources → Generate & Refine → Save Profile → Classifiers → Run Scoring. Conversational refinement lets the user iterate ("drop NIS2", "add the medical-device division", "we don't actually use SAP") before saving.
- **Multi-provider LLM**: Anthropic Claude, OpenAI, **and Azure OpenAI** are supported via a single provider abstraction (`app/api/src/llm/providers.js`). Configure per-tenant on Admin → LLM Settings.
- **Secrets vault**: All credentials (LLM API keys, per-URL scraper credentials) live in an envelope-encrypted `Secrets` table. AES-256-GCM with per-row data keys wrapped by a master key from `IDENTITY_ATLAS_MASTER_KEY`. The vault module ([app/api/src/secrets/vault.js](app/api/src/secrets/vault.js)) is general-purpose — other parts of the app can adopt the same pattern.
- **URL scraping**: Risk profile generation accepts internal URLs (wiki, ISMS, intranet) as additional context. Optional per-URL Basic or Bearer credentials live in the same vault. Scraping is fetch-on-create — no long-term indexing in v1.
- **Postgres-native scoring engine**: [app/api/src/riskscoring/engine.js](app/api/src/riskscoring/engine.js). Layer 1 (direct classifier match, weight 0.60) and a lightweight Layer 2 (small-group bonus, weight 0.25) are implemented. Layers 3 and 4 (structural hygiene, cross-entity propagation) are placeholders kept in the formula for future extension.
- **Background scoring runs**: `POST /api/risk-scoring/runs` queues a run, the engine executes in the same Node process, the wizard polls `GET /api/risk-scoring/runs/:id` for progress.
- **Risk Tiers**: Critical (90-100), High (70-89), Medium (40-69), Low (20-39), Minimal (1-19), None (0).
- **Worker dependency**: zero. The worker container has no LLM SDK and no API key — risk scoring runs in the web container.

### 8. Universal Data Model (v3.1)

The data model supports importing authorization data from any system, not just Entra ID. In v3.1, the Resources/ResourceAssignments/ResourceRelationships tables are also used for governance data (business roles, governed assignments, resource grants), creating a unified model.

```
                                    ┌──────────┐
                                    │ Systems  │
                                    └────┬─────┘
                         ┌───────────────┼───────────────┐
                         │               │               │
                    ┌────▼────┐    ┌─────▼─────┐   ┌─────▼─────┐
                    │Resources│    │Principals │   │ OrgUnits  │
                    └────┬────┘    └─────┬─────┘   └───────────┘
                         │               │               ▲
                    ┌────▼────────┐      │          orgUnitId
                    │Resource     │◄─────┘         ┌─────┴─────┐
                    │Assignments  │  principalId   │Identities │
                    └─────────────┘                └─────┬─────┘
                         │                         ┌─────▼──────┐
                    ┌────▼────────┐                │Identity    │
                    │Resource     │                │Members     │
                    │Relationships│                └────────────┘
                    └─────────────┘
```

**Tables:**
- **Systems** — Connected authorization sources (EntraID, SharePoint, AzureRM, DevOps, etc.)
- **Resources** — Any permission-granting resource (groups, directory roles, app roles, sites) **and** business roles (`resourceType='BusinessRole'`) with `extendedAttributes` JSON. Governance columns: `catalogId`, `isHidden`
- **ResourceAssignments** — Who has access to what (`resourceId` + `principalId` + `assignmentType`). Includes governed assignments (`assignmentType='Governed'`) with governance columns: `policyId`, `state`, `assignmentStatus`, `expirationDateTime`
- **ResourceRelationships** — Resource-to-resource links (Contains, GrantsAccessTo). Includes business role resource grants (`relationshipType='Contains'`) with governance columns: `roleName`, `roleOriginSystem`
- **Principals** — User accounts from any system with `principalType` and `extendedAttributes` JSON
- **OrgUnits** — Organizational units (departments, teams) calculated from data or synced from HR
- **Identities** — Real persons aggregated from multiple accounts (from account correlation)
- **IdentityMembers** — Links identities to their principals across systems

**Core + JSON pattern:** Both Resources and Principals use frequently-queried attributes as real SQL columns (displayName, department, resourceType) and system-specific attributes in `extendedAttributes` JSON column. This enables SQL indexing on hot columns while keeping the schema extensible.

**Unified resource model (v3.1):** Business roles are stored in the same Resources table as groups and other resources, distinguished by `resourceType='BusinessRole'`. This means business roles participate in the same views, risk scoring, and clustering as any other resource. Similarly, governed assignments and resource grants reuse ResourceAssignments and ResourceRelationships with specific `assignmentType` and `relationshipType` values.

**Backward compatibility:** All queries prefer new tables (Resources, Principals) with automatic fallback to legacy tables (GraphGroups, GraphUsers).

### 9. Universal Governance Model (v3.1 — Unified)

The governance model supports business roles, certifications, and access policies from any IGA platform — not just Entra ID Access Packages. In v3.1, the model was unified with the resource model: business roles, their assignments, and their resource grants are stored in the shared Resources, ResourceAssignments, and ResourceRelationships tables. Only governance-specific tables remain separate.

```
                    ┌──────────────────┐
                    │GovernanceCatalogs │
                    └────────┬─────────┘
                             │ catalogId
                    ┌────────▼─────────┐
                    │    Resources     │  (resourceType='BusinessRole')
                    └────────┬─────────┘
         ┌───────────┬───────┼───────┬───────────┐
         │           │       │       │           │
    ┌────▼──────┐ ┌──▼───┐ ┌▼─────┐ ▼────────┐  │
    │Resource   │ │Resour│ │Assign│ │Assignme│  │
    │Relation-  │ │ceAssi│ │ment  │ │nt      │  │
    │ships      │ │gnment│ │Polici│ │Requests│  │
    │(Contains) │ │s     │ │es    │ └────────┘  │
    └───────────┘ │(Gove-│ └──────┘             │
                  │rned) │           ┌──────────▼──┐
                  └──────┘           │Certification│
                                     │Decisions    │
                                     └─────────────┘
```

**Shared tables** (created by `Initialize-FGSystemTables`, extended by `Initialize-FGGovernanceTables`):
- **Resources** (`resourceType='BusinessRole'`) — Business roles stored alongside groups, directory roles, app roles, etc. Extra governance columns: `catalogId`, `isHidden`
- **ResourceAssignments** (`assignmentType='Governed'`) — Business role assignments stored alongside direct/eligible assignments. Extra governance columns: `policyId`, `state`, `assignmentStatus`, `expirationDateTime`
- **ResourceRelationships** (`relationshipType='Contains'`) — Business role resource grants stored alongside other resource links. Extra governance columns: `roleName`, `roleOriginSystem`

**Governance-specific tables** (created by `Initialize-FGGovernanceTables`):
- **GovernanceCatalogs** — Containers for business roles (Entra: Catalogs, Omada: Policy groups)
- **AssignmentPolicies** — Assignment rules with `policyConditions` JSON for ABAC (Entra: Assignment Policies, Omada: Context rules). References `resourceId` (the business role)
- **AssignmentRequests** — Request/approval workflow history. References `resourceId` (the business role)
- **CertificationDecisions** — Review/certification results with `certificationScopeType` (BusinessRole or ResourceAssignment). References `resourceId`

**IGA platform mapping:**

| Table | Column Filter | Entra ID | Omada | SailPoint |
|-------|---------------|----------|-------|-----------|
| GovernanceCatalogs | — | Catalog | — | Source |
| Resources | `resourceType='BusinessRole'` | Access Package | Business Role | Access Profile |
| ResourceRelationships | `relationshipType='Contains'` | Resource Role Scopes | Role Entitlements | Entitlements |
| ResourceAssignments | `assignmentType='Governed'` | AP Assignment | Role Assignment | Access Request Result |
| AssignmentPolicies | — | AP Assignment Policy | Assignment Policy | Access Request Config |
| AssignmentRequests | — | AP Assignment Request | — | Access Request |
| CertificationDecisions | — | AP Access Review | CRA | Certification |

**Breaking change (v3.0 → v3.1):** The old governance model had 7 separate tables (GovernanceCatalogs, BusinessRoles, BusinessRoleResources, BusinessRoleAssignments, BusinessRolePolicies, BusinessRoleRequests, CertificationDecisions). In v3.1, three tables were absorbed into the shared resource model: BusinessRoles → Resources, BusinessRoleAssignments → ResourceAssignments, BusinessRoleResources → ResourceRelationships. Two tables were renamed: BusinessRolePolicies → AssignmentPolicies, BusinessRoleRequests → AssignmentRequests (with `businessRoleId` → `resourceId`). Existing v3.0 deployments must re-sync to populate the unified tables. Tags/categories can be exported from the old setup and imported into the new one.

## Repository Structure

```
FortigiGraph/
├── Functions/                  # All PowerShell functions
│   ├── Base/                   # Core authentication and HTTP request functions (19)
│   │   ├── Get-FGAccessToken*.ps1        # Token acquisition (3 variants)
│   │   ├── Invoke-FGGetRequest.ps1       # HTTP GET with auto-pagination
│   │   ├── Invoke-FGPostRequest.ps1      # HTTP POST wrapper
│   │   ├── Invoke-FGPatchRequest.ps1     # HTTP PATCH wrapper
│   │   ├── Invoke-FGPutRequest.ps1       # HTTP PUT wrapper
│   │   ├── Invoke-FGDeleteRequest.ps1    # HTTP DELETE wrapper
│   │   ├── Update-FGAccessTokenIfExpired.ps1 # Shared token refresh helper
│   │   └── ...                           # Token management, secure config helpers
│   │
│   ├── Generic/                # Microsoft Graph API operations (49)
│   │   ├── Get-FG*.ps1         # Retrieve operations
│   │   ├── New-FG*.ps1         # Create operations
│   │   ├── Set-FG*.ps1         # Update operations
│   │   ├── Add-FG*.ps1         # Add operations (members, resources)
│   │   └── Remove-FG*.ps1      # Delete/remove operations
│   │
│   ├── Sync/                   # High-performance data sync operations (32)
│   │   ├── Start-FGSync.ps1              # Orchestrates all Entra ID sync operations
│   │   ├── Start-FGCSVSync.ps1           # Orchestrates CSV-based sync for external systems
│   │   ├── Sync-FGUser.ps1               # Sync users to GraphUsers (legacy)
│   │   ├── Sync-FGPrincipal.ps1          # Sync users to Principals
│   │   ├── Sync-FGGroup.ps1              # Sync groups to GraphGroups (legacy)
│   │   ├── Sync-FGGroupMember.ps1        # Sync direct group memberships
│   │   ├── Sync-FGGroupEligibleMember.ps1
│   │   ├── Sync-FGGroupOwner.ps1
│   │   ├── Sync-FGEntraDirectoryRole.ps1 # Sync directory roles → Resources
│   │   ├── Sync-FGEntraAppRoleAssignment.ps1 # Sync app role assignments → Resources + ResourceAssignments
│   │   ├── Sync-FGResourceRelationship.ps1   # Sync resource-to-resource links
│   │   ├── Sync-FGSystem.ps1             # Ensure system record exists
│   │   ├── Sync-FGOrgUnit.ps1            # Calculate OrgUnits from Principals
│   │   ├── Sync-FGAccessPackage.ps1      # Sync access packages → Resources (resourceType='BusinessRole')
│   │   ├── Sync-FGAccessPackageAssignment.ps1  # Sync AP assignments → ResourceAssignments (assignmentType='Governed')
│   │   ├── Sync-FGAccessPackageResourceRoleScope.ps1  # Sync AP resource scopes → ResourceRelationships (relationshipType='Contains')
│   │   ├── Sync-FGAccessPackageAssignmentPolicy.ps1   # Sync AP policies → AssignmentPolicies
│   │   ├── Sync-FGAccessPackageAssignmentRequest.ps1  # Sync AP requests → AssignmentRequests
│   │   ├── Sync-FGAccessPackageAccessReview.ps1       # Sync AP reviews → CertificationDecisions
│   │   ├── Sync-FGCatalog.ps1            # Sync catalogs → GovernanceCatalogs
│   │   ├── Sync-FGMaterializedViews.ps1  # Refresh materialized SQL views
│   │   ├── Sync-FGCSVSystem.ps1          # Sync systems from CSV
│   │   ├── Sync-FGCSVPrincipal.ps1       # Sync principals from CSV
│   │   ├── Sync-FGCSVResource.ps1        # Sync resources from CSV
│   │   ├── Sync-FGCSVResourceAssignment.ps1  # Sync resource assignments from CSV
│   │   ├── Sync-FGCSVIdentity.ps1        # Sync identities from CSV
│   │   ├── Sync-FGCSVBusinessRole.ps1    # Sync business roles from CSV → Resources
│   │   ├── Sync-FGCSVCertification.ps1   # Sync certifications from CSV
│   │   ├── Invoke-FGPrincipalMigration.ps1    # Migrate GraphUsers → Principals
│   │   ├── Invoke-FGResourceModelMigration.ps1 # Migrate GraphGroups → Resources
│   │   ├── Initialize-FGSyncTable.ps1           # Shared table lifecycle helper
│   │   └── New-FGDataTableFromGraphObjects.ps1  # Shared DataTable builder
│   │
│   ├── SQL/                    # SQL operations (31) — legacy, used outside Docker
│   │   ├── Invoke-FGSQLCommand.ps1       # Helper for connection lifecycle
│   │   ├── Connect-FGSQLServer.ps1       # Connect with firewall & ConfigFile
│   │   ├── Initialize-FGSQLTable.ps1     # Create SQL tables (legacy)
│   │   ├── Initialize-FGSystemTables.ps1 # Create Systems, Resources, Principals, OrgUnits, Identities tables
│   │   ├── Initialize-FGResourceViews.ps1     # Resource-based permission views (v3.1)
│   │   ├── Initialize-FGResourceIndexes.ps1   # Resource-based indexes (v3.1)
│   │   ├── Initialize-FGGovernanceTables.ps1  # Create 4 governance tables + ensure governance columns on 3 shared tables
│   │   ├── Initialize-FGRiskScoreTables.ps1   # Create risk score tables
│   │   ├── Initialize-FGAccessPackageViews.ps1
│   │   ├── Initialize-FGGroupMembershipViews.ps1  # Legacy group views (backward compat)
│   │   ├── Initialize-FGGroupMembershipIndexes.ps1 # Legacy group indexes
│   │   └── ...                           # Query, bulk ops, server management, export/import
│   │
│   ├── Specific/               # Higher-level helper functions (9)
│   │   └── Confirm-FG*.ps1     # Idempotent confirmation/creation
│   │
│   │ # (Azure deployment functions removed in April 2026 — Docker-only now)
│   │
│   └── RiskScoring/            # Identity risk scoring engine (17)
│       ├── New-FGRiskProfile.ps1         # LLM-assisted org context discovery
│       ├── New-FGRiskClassifiers.ps1     # Generate risk detection classifiers
│       ├── Invoke-FGRiskScoring.ps1      # 4-layer batch scoring engine
│       ├── Save-FGResourceClusters.ps1   # Group related resources into clusters
│       ├── Invoke-FGLLMRequest.ps1       # Shared LLM API helper (Anthropic/OpenAI)
│       ├── Save-FGRiskProfile.ps1        # Persist profile to SQL
│       ├── Save-FGRiskClassifiers.ps1    # Persist classifiers to SQL
│       ├── Get-FGRiskProfile.ps1         # Read profile from SQL
│       ├── Get-FGRiskClassifiers.ps1     # Read classifiers from SQL
│       ├── Export-FGRiskProfile.ps1      # Export profile to JSON file
│       ├── Export-FGRiskClassifiers.ps1  # Export classifiers to JSON file
│       ├── Import-FGRiskProfile.ps1      # Import profile from JSON file
│       ├── Import-FGRiskClassifiers.ps1  # Import classifiers from JSON file
│       ├── Invoke-FGAccountCorrelation.ps1  # Cross-system account correlation
│       ├── New-FGCorrelationRuleset.ps1     # Generate correlation rules via LLM
│       ├── Save-FGCorrelationRuleset.ps1    # Persist correlation rules to SQL
│       └── Get-FGCorrelationRuleset.ps1     # Read correlation rules from SQL
│
├── Config/                 # Configuration templates
│   └── tenantname.json.template
│
├── UI/                     # Role Mining Web Application
│   ├── backend/            # Node.js + Express API server
│   │   └── src/
│   │       ├── routes/permissions.js  # API endpoints (permissions, AP groups, sync log)
│   │       ├── routes/categories.js  # Category CRUD, AP list, category assignments
│   │       ├── routes/details.js     # User/group/resource detail endpoints with version history
│   │       ├── routes/resources.js   # Resource CRUD, filtering, column discovery
│   │       ├── routes/systems.js     # Systems CRUD, owners, statistics
│   │       ├── routes/orgUnits.js    # OrgUnit tree, detail, members
│   │       ├── routes/identities.js  # Identity correlation results
│   │       ├── routes/riskScores.js  # Risk score reading + analyst override endpoints
│   │       ├── routes/clusters.js   # Resource cluster management endpoints
│   │       ├── routes/orgChart.js   # Manager hierarchy tree endpoints (cached 5 min)
│   │       ├── routes/governance.js # Access review compliance monitoring
│   │       ├── routes/preferences.js # User preferences (tab visibility) with auto-created table
│   │       ├── routes/perf.js       # Performance metrics API (/api/perf, export, clear)
│   │       ├── middleware/auth.js     # Entra ID JWT validation (v1+v2 tokens)
│   │       ├── middleware/perfMetrics.js  # Request timing + Server-Timing headers
│   │       ├── perf/collector.js      # Ring buffer metrics collector with aggregation
│   │       ├── perf/sqlTimer.js       # SQL query timer wrapper (per-query instrumentation)
│   │       ├── db/connection.js       # PostgreSQL (pg) connection pool + graceful shutdown
│   │       ├── db/columnCache.js      # Shared column discovery cache (5-min TTL)
│   │       └── mock/data.js           # Mock data for local dev
│   └── frontend/           # React + Vite + Tailwind
│       └── src/
│           ├── App.jsx                # Root component, tab navigation, userLimit state
│           ├── auth/AuthGate.jsx      # MSAL authentication gate
│           ├── hooks/
│           │   ├── usePermissions.js  # API hook with debounced refetch
│           │   ├── useMatrixRowOrder.js # Row order persistence (versioned localStorage)
│           │   └── useEntityPage.js   # Shared hook for Users/Groups pages (search, filter, tags, pagination)
│           ├── utils/exportToExcel.js # Excel export with AP colors & rich text
│           └── components/
│               ├── MatrixView.jsx     # Main matrix orchestrator (staircase sort, managedApMap, apIdToIndex)
│               ├── PermissionGrid.jsx # TanStack Table grid view
│               ├── SyncLogPage.jsx    # Sync log viewer
│               ├── UserDetailPage.jsx # User/principal detail with attributes, memberships, history
│               ├── ResourceDetailPage.jsx # Resource detail with extendedAttributes, members, history
│               ├── OrgUnitDetailPage.jsx  # OrgUnit detail with members and sub-units
│               ├── SystemsPage.jsx   # Connected systems overview with stats and owners
│               ├── GroupsPage.jsx    # Legacy groups page (redirects to Resources)
│               ├── RiskScoringPage.jsx # Risk score visualization with override controls
│               ├── OrgChartPage.jsx  # Manager hierarchy tree with risk propagation
│               ├── DepartmentDetailPage.jsx # Department risk profile deep dive
│               ├── AccessPackageDetailPage.jsx # AP detail with assignments, resources, policies, reviews, history
│               ├── GovernancePage.jsx # AP review compliance dashboard (disabled)
│               ├── RiskScoreSection.jsx # Shared risk score display component
│               ├── PerfPage.jsx      # Performance metrics viewer (summary, recent, slowest, export)
│               └── matrix/            # Matrix sub-components
│                   ├── MatrixToolbar.jsx    # Filters, IST/SOLL, slider
│                   ├── MatrixCell.jsx       # Individual cell (AP-colored bg, multi-type badges)
│                   ├── MatrixGroupRow.jsx   # DnD-agnostic row (sortable props injected by SortableRow)
│                   ├── SortableMatrixBody.jsx  # Lazy-loaded: DnD + virtual scrolling wrapper
│                   └── MatrixColumnHeaders.jsx  # AP color palette (15 colors), column filters
│
├── _Build/                 # Build and publishing scripts
│   └── CreatePSD.ps1       # Module manifest generation
│
├── _Test/                  # Testing scripts and documentation
│
├── tools/
│   ├── crawlers/
│   │   ├── entra-id/Start-EntraIDCrawler.ps1  # Entra ID crawler (runs in worker container)
│   │   └── csv/Start-CSVCrawler.ps1           # CSV crawler (canonical schema, runs in worker)
│   └── csv-templates/
│       ├── schema/              # Header-only CSV files defining the Identity Atlas schema
│       │   ├── Systems.csv, Resources.csv, Users.csv, Assignments.csv,
│       │   ├── ResourceRelationships.csv, Contexts.csv, Identities.csv,
│       │   ├── IdentityMembers.csv, Certifications.csv
│       └── transforms/          # Source-specific transform scripts
│           └── omada-to-identityatlas.ps1  # Omada Identity → Identity Atlas schema
│
├── test/
│   └── nightly/
│       ├── Run-NightlyLocal.ps1           # Full nightly test suite
│       ├── Run-NightlyAndReview.ps1       # Wrapper with Claude auto-review on failure
│       ├── Test-EntraIdCrawler.ps1        # Entra crawler scenarios + deep assertions
│       ├── Test-LLMSubstrate.ps1          # LLM/secrets/risk-profile smoke test
│       ├── Register-ReviewSchedule.ps1    # Windows Task Scheduler registration
│       └── claude-review-prompt.md        # Prompt template for the Claude review agent
│
├── docs/
│   └── architecture/
│       ├── csv-import-schema.md           # CSV import canonical schema specification
│       ├── llm-and-risk-scoring.md        # LLM, secrets vault, risk scoring design
│       ├── postgres-migration.md          # PostgreSQL migration plan
│       └── docker-setup.md               # Docker deployment architecture
│
├── FortigiGraph.psm1       # Module entry point (auto-loads all functions)
├── setup/IdentityAtlas.psd1 # Module manifest (version auto-bumped by CI)
├── README.md               # User documentation
└── CLAUDE.md               # This file - AI assistant development guide
```

### Function Count by Category

| Category | Count | Purpose |
|----------|-------|---------|
| **Base** | 22 | Authentication, HTTP operations, setup wizard, token management |
| **Generic** | 49 | Graph API CRUD operations |
| **Sync** | 32 | High-performance data sync (Start-FGSync + CSV sync + entity syncs + migration + helpers) |
| **SQL** | 31 | SQL database operations (tables, views, indexes, bulk ops, system tables, governance tables) |
| **Specific** | 9 | High-level idempotent helpers |
| **RiskScoring** | 17 | LLM-assisted risk profiling, batch scoring, cluster analysis, account correlation |
| **Total** | **~160 functions** | (Azure deployment functions removed April 2026) |

## Architecture & Design Patterns

### 1. Module Loading Strategy

The module loads functions from the `Functions/` directory via dot-sourcing in `FortigiGraph.psm1`:

```powershell
$base       = @( Get-ChildItem -Path (Join-Path $PSScriptRoot 'functions\base') -Include *.ps1 -Recurse )
$generic    = @( Get-ChildItem -Path (Join-Path $PSScriptRoot 'functions\generic') -Include *.ps1 -Recurse )
$specific   = @( Get-ChildItem -Path (Join-Path $PSScriptRoot 'functions\specific') -Include *.ps1 -Recurse )
$SQL        = @( Get-ChildItem -Path (Join-Path $PSScriptRoot 'functions\SQL') -Include *.ps1 -Recurse )
$sync       = @( Get-ChildItem -Path (Join-Path $PSScriptRoot 'functions\Sync') -Include *.ps1 -Recurse )
$automation = @( Get-ChildItem -Path (Join-Path $PSScriptRoot 'functions\Automation') -Include *.ps1 -Recurse )

foreach ($import in @($base + $generic + $specific + $SQL + $sync + $automation)) {
    . $import.fullname
}
```

### 2. Global State Management

#### Graph API State
- `$Global:AccessToken` - Current OAuth access token
- `$Global:ClientId` - Azure AD application client ID
- `$Global:ClientSecret` - Application secret (for service principal auth)
- `$Global:TenantId` - Azure AD tenant ID
- `$Global:RefreshToken` - Refresh token (for interactive auth)
- `$Global:DebugMode` - Debug flag ('T', 'G', 'P', 'D' or combinations)

#### SQL State
- `$Global:FGSQLConnectionString` - SQL connection string (legacy — Docker uses `DATABASE_URL` env var for PostgreSQL)
- `$Global:FGSQLServerName` - Connected server name (legacy)
- `$Global:FGSQLDatabaseName` - Connected database name (legacy)

### 3. `principalType` Conventions

The `Principals.principalType` column is NVARCHAR(50). Use these values consistently across all sync and scoring functions:

| Value | Description | Source |
|---|---|---|
| `User` | Interactive human user account | `Sync-FGPrincipal`, `Sync-FGCSVPrincipal` |
| `ServicePrincipal` | App registration service principal | `Sync-FGServicePrincipal` |
| `ManagedIdentity` | Azure resource-attached managed identity (system or user-assigned) | `Sync-FGServicePrincipal` |
| `WorkloadIdentity` | Federated credential identity (GitHub Actions, AKS workloads) | `Sync-FGServicePrincipal` / CSV import |
| `AIAgent` | Explicitly identified AI agent (Copilot Studio, Azure OpenAI, custom) | `Sync-FGServicePrincipal` auto-detection, CSV import |
| `ExternalUser` | Guest / B2B account from another tenant | CSV import |
| `SharedMailbox` | Shared mailbox or room/equipment account | CSV import |

**Detection rules in `Sync-FGServicePrincipal`:**
1. `servicePrincipalType = 'ManagedIdentity'` → `ManagedIdentity`
2. Tags contain `CopilotStudio`, `PowerVirtualAgents`, `AzureOpenAI`, or `CognitiveServices` → `AIAgent`
3. `displayName` matches AI patterns (copilot, openai, bot, azure-ai, gpt, etc.) → `AIAgent`
4. Custom `-AINamePatterns` provided → `AIAgent`
5. Default → `ServicePrincipal`

**Risk scoring behavior by principalType:**
- `User` → full stale sign-in, never-signed-in, guest checks; user classifiers apply
- `ServicePrincipal` / `ManagedIdentity` / `WorkloadIdentity` / `AIAgent` → non-human structural signals (no stale sign-in); agent classifiers apply
- All types → direct classifier matching, membership analysis, propagation

### 4. Function Naming Convention

- **Prefix:** `FG` (FortigiGraph) for all exported functions
- **Aliases:** Each function has an alias without the `FG` prefix (e.g., `Get-FGGroup` -> `Get-Group`)
- **Verbs:** Standard PowerShell verbs (Get, New, Set, Add, Remove, Confirm, Invoke, Connect, Test, Initialize, Sync, Clear, Start)
- **Pattern:** `Verb-FGNoun`

### 4. Config File Pattern

The config file (`Config/tenantname.json.template`) drives all operations:

```powershell
# All major functions support -ConfigFile (only relevant when running crawler scripts outside Docker)
Get-FGAccessToken -ConfigFile .\Config\mycompany.json
.\tools\crawlers\entra-id\Start-EntraIDCrawler.ps1 `
    -ApiBaseUrl http://localhost:3001/api `
    -ApiKey $apiKey `
    -ConfigFile .\Config\mycompany.json
```

### 5. The SQL Helper Pattern: `Invoke-FGSQLCommand`

**Critical design pattern.** All SQL functions delegate connection lifecycle to this helper:

```powershell
Invoke-FGSQLCommand -ScriptBlock {
    param($connection)
    $cmd = $connection.CreateCommand()
    $cmd.CommandText = "SELECT COUNT(*) FROM Users"
    return $cmd.ExecuteScalar()
}
```

### 6. Authentication in Start-FGSync

`Start-FGSync` always gets a fresh token at the start of every sync run. This prevents stale token issues when switching between app registrations or when permissions have been updated.

### 7. Pagination Handling (Graph API)

All GET requests automatically handle Microsoft Graph pagination via `Invoke-FGGetRequest`.

### 8. Debug Mode

Debug output controlled via `$Global:DebugMode`:
- `'T'` - Token operations
- `'G'` - GET requests
- `'P'` - POST/PATCH requests
- `'D'` - DELETE requests
- Combine: `'GP'`, `'TPD'`, etc.

## Key Conventions for AI Assistants

### 1. File Organization

**All function files live under `Functions/`:**

| Folder | Purpose | Example |
|--------|---------|---------|
| **Functions/Base/** | Core HTTP operations, authentication | `Invoke-FGGetRequest.ps1`, `Get-FGAccessToken.ps1` |
| **Functions/Generic/** | Direct Microsoft Graph API wrappers (1:1 mapping) | `Get-FGUser.ps1`, `Get-FGGroup.ps1` |
| **Functions/Sync/** | Data sync operations | `Sync-FGUser.ps1`, `Start-FGSync.ps1` |
| **Functions/Specific/** | Business logic combining multiple functions | `Confirm-FGGroup.ps1` |

**File naming:** `Verb-FGNoun.ps1` (e.g., `Get-FGGroupMember.ps1`)

### 2. Function Structure Templates

#### Graph API Function Template

```powershell
function Get-FGResource {
    [alias("Get-Resource")]
    [cmdletbinding()]
    Param(
        [Parameter(Mandatory = $false)]
        [string]$Id,
        [Parameter(Mandatory = $false)]
        [string]$Filter
    )

    If ($Id) {
        $URI = "https://graph.microsoft.com/beta/resources/$Id"
    } ElseIf ($Filter) {
        $URI = "https://graph.microsoft.com/beta/resources?`$filter=$Filter"
    } Else {
        $URI = "https://graph.microsoft.com/beta/resources"
    }

    $ReturnValue = Invoke-FGGetRequest -URI $URI
    return $ReturnValue
}
```

#### SQL Function Template

```powershell
function Get-FGSQLResource {
    [CmdletBinding()]
    Param(
        [Parameter(Mandatory = $false)]
        [string]$Filter
    )

    Invoke-FGSQLCommand -ScriptBlock {
        param($connection)
        $cmd = $connection.CreateCommand()
        $cmd.CommandText = "SELECT * FROM dbo.Resources WHERE Name = @Name"
        $cmd.Parameters.AddWithValue("@Name", $ResourceName)
        $reader = $cmd.ExecuteReader()
        # Process results...
        return $results
    }
}
```

### 3. Important Rules

**DO:**
- Follow existing naming conventions (`Verb-FGNoun`)
- Add aliases without `FG` prefix
- Use `Invoke-FG*Request` functions (never call `Invoke-RestMethod` directly for Graph)
- Use `Invoke-FGSQLCommand` helper for all SQL operations
- Use `/beta` endpoint unless told otherwise
- Place one function per file under `Functions/`
- Use `[cmdletbinding()]` for all functions
- Use color-coded Write-Host for user feedback (Green=success, Yellow=warning, Cyan=progress, Red=error)
- Use `-ErrorAction Stop` with try/catch for Azure operations that must succeed before continuing
- Return raw Graph objects (don't transform)

**DON'T:**
- Don't call `Invoke-RestMethod` directly for Graph (use wrappers)
- Don't manage SQL connections manually (use `Invoke-FGSQLCommand`)
- Don't hardcode credentials or tokens
- Don't create multi-function files
- Don't use `Write-Output` (use `return` directly)
- Don't add comments in Dutch (use English only)
- Don't commit test configuration files (protected by .gitignore)
- Don't modify database schema manually — use migration files in `app/api/src/db/migrations/`
- Don't commit or push a fix without first testing it locally against the running Docker stack (see below)

### 3a. Always Test Locally Before Committing

After any change to the API, rebuild the container and verify the fix before touching git:

```bash
docker compose build web && docker compose up -d web
# then hit a representative endpoint, e.g.:
curl -s -X POST http://localhost:3001/api/ingest/contexts \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"records":[{"id":"...","contextType":"Department","displayName":"Test","systemId":1}],"syncMode":"full","systemId":1}'
```

Only proceed to branch/commit/push once the endpoint returns a 2xx response. The prod compose file (`docker-compose.prod.yml`) uses a pre-built image from ghcr.io — changes to source files have no effect until the image is rebuilt with `docker compose build`.

### 4. Dark Mode

The UI supports a **light/dark theme toggle** implemented with Tailwind v4's class-based dark mode strategy.

**How it works:**
- `index.css` declares `@custom-variant dark (&:is(.dark, .dark *))` — the `dark` class on `<html>` activates all `dark:` variants.
- `app/ui/src/hooks/useTheme.js` — three-state machine (`'light' | 'auto' | 'dark'`); `'auto'` follows the OS via `matchMedia('(prefers-color-scheme: dark)')`; persists to `localStorage.themeMode`.
- `app/ui/src/contexts/ThemeContext.jsx` — `ThemeContext` / `useIsDark()` / `useThemeMode()` hooks for components that need the theme value at runtime (e.g. for inline hex styles that can't be expressed as Tailwind classes).
- The three-button segmented control (Light / Auto / Dark) lives in `App.jsx`'s top-right settings dropdown.

**Rule: every new UI component must include dark mode from the start.** Do not add a component without `dark:` variants on every hardcoded color. There is no cleanup pass — new code ships complete.

**Rule: all light-theme colors must meet WCAG 2.0 AA contrast.** Any hardcoded color used as text, icon, or border on a light background must achieve ≥4.5:1 contrast ratio against that background (≥3:1 for large text ≥18pt / bold ≥14pt). Use Tailwind 700–800 tier values for colored text on white — mid-tone 400–500 values consistently fail. Check new color constants with a contrast tool before committing. The `TAG_COLORS` array in `app/ui/src/utils/colors.js` is the reference example of compliant values.

**Common patterns:**
```jsx
// Container cards
className="bg-white border border-gray-200 dark:bg-gray-800 dark:border-gray-700"

// Body text
className="text-gray-900 dark:text-white"          // headings
className="text-gray-500 dark:text-gray-400"       // secondary text

// Form inputs
className="border border-gray-200 bg-white dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500"

// Table headers
className="bg-gray-50 dark:bg-gray-700/50"
// Table dividers
className="divide-y dark:divide-gray-700"

// Status/semantic badges (green, red, amber, blue)
className="bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300"
className="bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300"
className="bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
className="bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300"

// Back/secondary buttons
className="bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300"

// Inline hex colors (AP colors, tier colors) — use useIsDark() from ThemeContext
const isDark = useIsDark();
style={{ color: isDark ? AP_COLORS_DARK[i] : AP_COLORS[i] }}
```

### 4. No Duplicate Code

Before writing any utility function, helper, constant, or component — **search first**.

**PowerShell:** Check `Functions/` for an existing function that does the same thing. If it exists, call it. If it almost fits, extend it rather than copy it.

**React/JS:** Check `app/ui/src/utils/` and `app/ui/src/hooks/` before writing any helper inline in a component. Known shared utilities:
- `utils/formatters.js` — `formatDate`, `formatValue`, `computeHistoryDiffs`, `friendlyLabel`
- `utils/tierStyles.js` — `TIER_STYLES` (risk tier colors) and `tierClass(tier)` helper
- `utils/colors.js` — `TAG_COLORS` and AP color palette
- `utils/exportToExcel.js` / `utils/exportAccessPackagesToExcel.js` — Excel export logic
- `hooks/useEntityPage.js` — search, filter, tags, and pagination for list pages
- `hooks/useDebouncedValue.js` — `useDebouncedValue(value, delay)` hook
- `components/ConfidenceBar.jsx` — correlation confidence bar
- `components/DetailSection.jsx` — `Section` and `CollapsibleSection` used by detail pages

If the same logic already exists in one file and you are about to write it in a second file, stop and extract it to a shared location instead. Three or more files with the same code is a mandatory extraction — don't leave it for later.

### 5. When Extending the Module

1. **Check if function already exists:** Search `Functions/` folders first
2. **Determine correct location:**
   - Direct Graph API call -> `Functions/Generic/`
   - SQL operation -> `Functions/SQL/`
   - Data sync operation -> `Functions/Sync/`
   - Risk scoring / LLM / clustering -> `Functions/RiskScoring/`
   - Combines multiple operations -> `Functions/Specific/`
   - Core HTTP/auth -> `Functions/Base/` (rarely needed)
3. **Follow the pattern:** Look at similar existing functions
4. **Update module version** after making changes

## Graph API Permissions

The Crawlers wizard validates these permissions on the App Registration during setup:

| Permission | ID | Purpose |
|---|---|---|
| `User.Read.All` | `df021288-bdef-4463-88db-98f22de89214` | Read all users |
| `Group.Read.All` | `5b567255-7703-4780-807c-7be8301ae99b` | Read all groups |
| `GroupMember.Read.All` | `98830695-27a2-44f7-8c18-0c3ebc9698f6` | Read group memberships |
| `Directory.Read.All` | `7ab1d382-f21e-4acd-a863-ba3e13f7da61` | Read directory data |
| `Application.Read.All` | `9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30` | Read service principals + app role assignments (Sync-FGEntraAppRoleAssignment) |
| `PrivilegedEligibilitySchedule.Read.AzureADGroup` | `b3a539c9-59be-4c8d-b62c-11ae8c4f2a37` | Read PIM group eligibility schedules (Sync-FGGroupEligibleMember) |
| `EntitlementManagement.Read.All` | `c74fd47d-ed3c-45c3-9a9e-b8676de685d2` | Read access packages |
| `AccessReview.Read.All` | `d07a8cc0-3d51-4b77-b3b0-32704d1f69fa` | Read access reviews |
| `AuditLog.Read.All` | `b0afded3-3588-46d8-8b3d-9842eff778da` | Read audit/sign-in data |

## Analytical Views

### Group Membership Views (via `Initialize-FGGroupMembershipViews`)

- `vw_GraphGroupMembersRecursive` - Calculates ALL memberships (direct + indirect) with paths using recursive CTE
- `vw_UserPermissionAssignments` - All membership types as separate rows: Owner, Direct, Indirect, Eligible + `managedByAccessPackage` (BIT). A user can have multiple rows per group (e.g. Direct + Owner) — no deduplication, so the UI can show all types.

### Access Package Views (via `Initialize-FGAccessPackageViews`)

- `vw_UserPermissionAssignmentViaAccessPackage` - User permissions via access packages
- `vw_DirectGroupMemberships` - Direct group memberships
- `vw_DirectGroupOwnerships` - Direct group ownerships
- `vw_UnmanagedPermissions` - IST vs SOLL gaps
- `vw_AccessPackageAssignmentDetails` - Assignment details
- `vw_AccessPackageLastReview` - Last review per package
- `vw_ApprovedRequestTimeline` - Approval times with response buckets
- `vw_DeniedRequestTimeline` - Denied request analysis
- `vw_PendingRequestTimeline` - Aging pending requests
- `vw_RequestResponseMetrics` - Aggregate approval statistics

## Repository Setup (One-Time)

These steps are required once when creating or transferring the repository. They are not automated by CI.

### GitHub Actions secrets

| Secret | Required scopes | Purpose |
|--------|----------------|---------|
| `VERSION_BUMP_PAT` | `repo` (includes `contents:write`) | Lets `bump-version.yml`, `cut-release.yml`, and `cut-hotfix.yml` push tags and commits to `main`. |

### Branch protection

Run once after repo creation (requires `gh` CLI authenticated as admin):

```bash
bash tools/setup-branch-protection.sh Fortigi/IdentityAtlas
```

This sets:
- `main` — PR required (1 approval), `PR Summary` check required, admins bypass
- Tags are immutable by default in GitHub — no extra protection needed

---

## Development Workflow

### Starting New Work

**Feature (not yet released):**
```bash
git checkout main && git pull
git checkout -b feature/<name>      # e.g. feature/risk-score-export
```

**Pre-release bugfix (bug is in main, not yet released):**
```bash
git checkout main && git pull
git checkout -b bugfixes/<name>     # e.g. bugfixes/fix-login-redirect
```

**Hotfix (bug is in a released version — ship the fix without including unreleased features):**
```bash
# Branch from the release tag, not from main
git checkout -b bugfixes/<name> v5.2.0
# ... make the fix, add changes/<name>.md fragment, commit, push ...
git push origin bugfixes/<name>
# Then run Actions → Cut Hotfix with the branch name and new version (e.g. 5.2.1)
# After the hotfix ships, cherry-pick the fix to main via a separate PR
```

### Making Changes

1. **Create/Edit** the relevant files
2. **Test locally** against the running Docker stack (`docker compose build web && docker compose up -d web`)
3. **Add bullets to `changes/<branch-name>.md`** describing the functional change (create the file if it doesn't exist — do NOT edit `CHANGES.md` directly)
4. **Commit** with descriptive messages

### Stacked PRs (preferred workflow)

Break features and auto-fixes into a **stack of small, focused PRs** rather than one large PR. Each step gets its own branch targeting the previous branch in the stack.

> **GitHub native stacking (private preview, April 2026):** GitHub is rolling out a native `gh stack` extension that improves on the manual pattern below in four ways: (1) `gh stack submit` creates all PRs in the stack at once; (2) `gh stack sync` auto-rebases the entire stack after a bottom PR merges — eliminating the manual `gh pr edit --base` step; (3) a visual stack map appears in every PR so reviewers can navigate the chain; (4) "Direct merge" merges a PR and all its unmerged dependencies in one click. Sign up at `gh.io/stacksbeta`. Once available, prefer `gh stack` commands over the manual pattern below.

**Manual pattern (use until `gh stack` is available):**

```bash
# First slice — targets main
git checkout main && git pull
git checkout -b feature/foo-step-1
# ... make changes, commit ...
gh pr create --base main --title "step 1: ..."

# Second slice — stacked on top of step 1
git checkout -b feature/foo-step-2
# ... make changes, commit ...
gh pr create --base feature/foo-step-1 --title "step 2: ..."
```

When a bottom PR merges, retarget the next one: `gh pr edit <number> --base main`.

### Merging to Main (feature / pre-release bugfix)

1. Open PR from `feature/<name>` or `bugfixes/<name>` into `main`
2. Use the fragment content from `changes/<branch-name>.md` as the PR description
3. Requires 1 approval — merge when CI passes
4. After merge: `bump-version.yml` increments Minor + timestamp; `docker-publish.yml` pushes `:edge`

### Cutting a Release

When `main` is stable and ready to ship to customers:

1. Go to **Actions → Cut Release → Run workflow**
2. Enter the version: `Major.Minor.Patch` (e.g. `5.2.0`)
3. The workflow creates tag `v5.2.0` on the current `main` HEAD
4. `docker-publish.yml` triggers automatically and pushes `:latest` + `:5.2.0.0`

### Hotfix Releases (shipping a fix without unreleased features)

```bash
# 1. Branch from the release tag — NOT from main
git checkout -b bugfixes/fix-foo v5.2.0

# 2. Fix, commit, push
git push origin bugfixes/fix-foo
```

3. Go to **Actions → Cut Hotfix → Run workflow**
4. Enter the branch name and new version (e.g. `5.2.1`)
5. `docker-publish.yml` triggers on the new tag and pushes `:latest` + `:5.2.1.0`
6. Cherry-pick the fix to `main`: open a PR from a cherry-pick branch into `main`

### Version Updates

See the **Branching & Versioning Strategy** section above for the full scheme.
- `main` merges → `Major.Minor.yyyyMMdd.HHmm` → `:edge` Docker tag
- Release tags (`v*`) → `Major.Minor.Patch.0` → `:latest` Docker tag

## User Workflow (Getting Started)

The recommended flow for new users:

```bash
# 1. Download the production compose file
curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml

# 2. Start the stack
docker compose -f docker-compose.prod.yml up -d

# 3. Open http://localhost:3001 → go to Admin → Crawlers, then click "Load Demo Data" or "Add Crawler" to connect Entra ID
# 4. Configure crawlers via the in-browser wizard (Admin → Crawlers → Add Crawler)
```

## Codebase Maintenance Analysis (Feb 2026)

> **This section documents known technical debt, bugs, and improvement opportunities discovered during a comprehensive code review. Use this as a backlog for maintenance sprints.**

### ~~Critical Bugs (Must Fix)~~ RESOLVED (March 2026)

All critical bugs fixed in maintenance sprint:

| # | File | Issue | Status |
|---|------|-------|--------|
| ~~1~~ | ~~`Confirm-FGUser.ps1`~~ | ~~`$Group.count` → `$User.count`~~ | **RESOLVED** |
| ~~2~~ | ~~`Confirm-FGAccessPackagePolicy.ps1`~~ | ~~Copy-paste: checked `accessPackageId` instead of `displayName`~~ | **RESOLVED** |
| ~~3~~ | ~~`Confirm-FGAccessPackage.ps1`~~ | ~~Undefined `$AccessPackageName` → `$DisplayName`~~ | **RESOLVED** |
| ~~4~~ | ~~`Get-FGAccessPackagesAssignments.ps1`~~ | ~~Undefined `$id` → `$AccessPackageID`~~ | **RESOLVED** |
| ~~5~~ | ~~`Remove-FGAccessPackage.ps1`~~ | ~~Plural/singular mismatch in loop~~ | **RESOLVED** |
| ~~6~~ | ~~`Get-FGUserMail.ps1`~~ | ~~Checked `$MailFolder` instead of `$MailFolderId`~~ | **RESOLVED** |
| ~~7~~ | ~~`Get-FGApplicationExtensionProperty.ps1`~~ | ~~Naming convention reversed~~ | **RESOLVED** |
| ~~8~~ | ~~`Sync-FGGroupTransitiveMember.ps1`~~ | ~~Function removed (replaced by SQL view)~~ | **RESOLVED** |
| ~~9~~ | ~~`Use-FGExistingMSALToken.ps1`~~ | ~~Called `Get-AccessTokenDetail` instead of `Get-FGAccessTokenDetail`~~ | **RESOLVED** |

Also fixed in same sprint:
- ~~`Invoke-FGPutRequest.ps1` debug output said "PatchRequest"~~ → **RESOLVED**
- ~~`Invoke-FGPutRequest.ps1` used `$ReturnValue += $Result` on undefined~~ → **RESOLVED** (now uses `= $Result`)
- ~~"cataloge" typo in 3 Confirm-FG* functions~~ → **RESOLVED** (fixed to "catalog")
- ~~"More then one" in 8 Confirm-FG* functions~~ → **RESOLVED** (fixed to "More than one")
- ~~Dutch comment in `Confirm-FGGroup.ps1`~~ → **RESOLVED** (translated to English)
- ~~SQL injection in `riskScores.js` hasRiskColumns()~~ → **RESOLVED** (parameterized + whitelist)

### ~~High-Priority Refactoring: DRY Violations in Base HTTP Functions~~ RESOLVED

**RESOLVED:** `Update-FGAccessTokenIfExpired` extracted to `Functions/Base/Update-FGAccessTokenIfExpired.ps1` and all 6 HTTP functions refactored to use it. Remaining opportunities:
- Debug output blocks (~8 lines each) → Extract to `Write-FGDebugMessage`
- Response value extraction (~6 lines each) → Extract to `Get-FGResponseValue`

### ~~High-Priority Refactoring: Sync Function Duplication~~ RESOLVED

**RESOLVED:** Two helpers extracted to `Functions/Sync/`:
- `Initialize-FGSyncTable.ps1` — handles table existence, schema evolution, recreation
- `New-FGDataTableFromGraphObjects.ps1` — builds DataTables with type conversion and custom value resolvers

All 9 sync functions refactored to use these helpers. Remaining opportunity:
- **Group fetching** duplicated across 4 group-based syncs (~40 lines × 4). Create `Get-FGGroupsForSync` helper.

### High-Priority: Massive Functions to Break Down

### High-Priority: Generic Functions Consolidation

**"All" and "AllToFile" function pairs** have 95%+ duplication:
- `Get-FGGroupMemberAll.ps1` / `Get-FGGroupMemberAllToFile.ps1`
- `Get-FGGroupTransitiveMemberAll.ps1` / `Get-FGGroupTransitiveMemberAllToFile.ps1`

**Action:** Merge each pair into one function with optional `-OutputFile` parameter. The 52-line JSON restructuring routine is identical in both "ToFile" functions — extract to a shared helper.

**URI filter building** is duplicated across 6+ Get functions (Get-FGUser, Get-FGGroup, Get-FGApplication, Get-FGServicePrincipal, Get-FGCatalog, Get-FGDevice). Consider a shared `Build-FGGraphUri` helper.

**Missing `[cmdletbinding()]`** on: `Get-FGGroupMemberAll`, `Get-FGGroupMemberAllToFile`, `Get-FGGroupTransitiveMemberAll`, `Get-FGGroupTransitiveMemberAllToFile`.

### Medium-Priority: SQL Function Improvements

~~**SQL injection risks** (parameterize these):~~ **RESOLVED**
- ~~`Get-FGSQLTable.ps1`: Schema/pattern in WHERE via string interpolation~~ → parameterized via `Invoke-FGSQLCommand`
- ~~`Get-FGSyncLog.ps1`: SyncType/Status in WHERE via string interpolation~~ → parameterized via `Invoke-FGSQLCommand`
- ~~`New-FGSQLReadOnlyUser.ps1`: Password embedded directly in SQL string~~ → username validated with `[a-zA-Z0-9_]` regex, password escaped

**Connection management inconsistency** — 2 functions bypass `Invoke-FGSQLCommand`:
- `Write-FGSyncLog.ps1` (lines 98-172): Manual connection management
- `New-FGSQLReadOnlyUser.ps1` (lines 103-141): Manual connection management

**Extract shared SQL helpers:**
- `Set-FGSQLTableVersioning -Enable/-Disable` (duplicated in `Add-FGSQLTableColumn` and `Clear-FGSQLTable`)
- `ConvertTo-FGSQLType` / `ConvertTo-FGDotNetType` (duplicated in `Invoke-FGSQLBulkDelete` and `Invoke-FGSQLBulkMerge`)
- Table name parsing with schema (duplicated in `Clear-FGSQLTable` and `Get-FGSQLTableSchema`)

### Medium-Priority: Sync Performance & Reliability

**Missing batching options** — these load all data into memory (risk `OutOfMemoryException` for large tenants):
- `Sync-FGGroupOwner` — no batching option
- `Sync-FGUser` / `Sync-FGGroup` — no batching for very large tenants

**Retry logic** only exists in `Sync-FGAccessPackageResourceRoleScope`. Move to `Invoke-FGGetRequest` or create `Invoke-FGGetRequestWithRetry` so all sync functions benefit from transient error handling (429, 503, 504).

**Deduplication** only in some sync functions (`Sync-FGAccessPackageAssignment`, `Sync-FGAccessPackageAssignmentRequest`). Add to `Sync-FGUser`, `Sync-FGGroup`, `Sync-FGGroupMember` to prevent MERGE failures.

**GC calls** only in 2 sync functions. Standardize `[System.GC]::Collect()` every 50 iterations in all batching loops.

**Token refresh during long syncs:** `Start-FGSync` gets a token once at start. For 2+ hour syncs, tokens expire (~1 hour). The token check in `Invoke-FGGetRequest` should handle this, but verify it works correctly within runspaces where global state is copied.

**No dependency enforcement in Start-FGSync:** GroupMembers can start before Groups completes. Consider adding sync phases (Phase 1: Users+Groups, Phase 2: memberships, Phase 3: access packages, Phase 4: materialized views).

### Medium-Priority: Deprecated Patterns

**OAuth2 v1 endpoints** used in 4 files (v1 being deprecated by Microsoft):
- `Get-FGAccessToken.ps1` line 117: `/oauth2/token`
- `Get-FGAccessTokenInteractive.ps1` lines 23, 32
- `Get-FGAccessTokenWithRefreshToken.ps1` line 21

**Action:** Migrate to `/oauth2/v2.0/token` endpoint.

### Medium-Priority: Specific/Helper Cleanup

~~**Typos**~~ → **RESOLVED** (March 2026): "cataloge" → "catalog", "More then one" → "More than one", Dutch comment translated.

~~**Duplicate Azure REST helpers in New-FGUI / Remove-FGUI**~~ → **RESOLVED** (April 2026): all Azure deployment functions removed; project is Docker-only.

**Confirm-FGGroupMember / Confirm-FGNotGroupMember** share 40+ lines of identical member resolution logic. Extract to `Resolve-FGMemberObjectIds`.

### UI Backend Improvements

**Security (Critical):**
- ~~`index.js` line 14: `app.use(cors())` allows ALL origins~~ → **RESOLVED:** CORS now configured with `ALLOWED_ORIGINS` env var; production blocks cross-origin by default
- ~~No rate limiting on any endpoint~~ → **RESOLVED:** Added `express-rate-limit` on pre-auth endpoints (30 req/min per IP); `helmet` for security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy); `express.json({ limit: '100kb' })` body size cap; startup warning when `AUTH_ENABLED` not set in production; `/api/auth-config` no longer confirms auth is disabled
- ~~Error responses leak SQL schema info (table names, column names)~~ → **RESOLVED** (March 2026): All `console.error` calls now use `err.message` instead of full `err` objects; error responses return generic messages
- No audit logging for mutations — log user identity + changes for compliance
- ~~Auth middleware (`auth.js`) doesn't validate token scopes/roles~~ → **RESOLVED:** Added tenant ID validation and optional role-based access control via `AUTH_REQUIRED_ROLES` env var
- ~~Bulk operations (`/tags/:id/assign-by-filter`) have no row limit~~ → **RESOLVED:** Added `TOP 50000` safety cap; hex color validation (`/^#[0-9a-fA-F]{6}$/`) on tag and category create/update endpoints
- ~~SQL injection via string interpolation of offset/limit in `riskScores.js` and `identities.js`~~ → **RESOLVED** (March 2026): Parameterized with `@offset`/`@limit` inputs
- ~~Missing `parseInt` validation across tag/category routes~~ → **RESOLVED** (March 2026): Added `isNaN()` checks with 400 responses; radix 10 on all `parseInt` calls
- ~~Unbounded `entityIds` array in tag assign/unassign~~ → **RESOLVED** (March 2026): Capped at 500 IDs per request
- ~~`assignedBy` in cluster owner derived from request body~~ → **RESOLVED** (March 2026): Now derived from `req.user` (authenticated identity)
- ~~Missing input length limits on identity notes/reason fields~~ → **RESOLVED** (March 2026): Notes capped at 2000 chars, reason at 500 chars
- ~~Column names in `columnCache.js` not validated against injection~~ → **RESOLVED** (March 2026): Added `SAFE_IDENT_RE` regex validation for column and table names

**~~Performance (Critical):~~** **RESOLVED**
- ~~`tags.js` lines 194-206: N+1 query in tag assignment loop — batch into single INSERT~~ → batched into single parameterized INSERT with NOT EXISTS
- ~~`tags.js` lines 226-231: Same N+1 pattern in unassign loop~~ → batched into single DELETE with IN clause
- ~~`tags.js` line 98: Subquery COUNT per row — use LEFT JOIN + GROUP BY instead~~ → replaced with LEFT JOIN + GROUP BY (also fixed same pattern in `categories.js` line 50)
- ~~Column discovery runs on every request — add TTL-based cache (5 min)~~ → extracted to `db/columnCache.js` with 5-minute TTL

**Code Quality:**
- ~~Column discovery logic duplicated between `permissions.js` and `tags.js`~~ → **RESOLVED:** extracted to shared `db/columnCache.js` with TTL cache
- `ensureTagTables` / `ensureCategoryTables` — extract to shared `ensureTable` utility
- Pagination parameter parsing duplicated across routes
- ~~`db/connection.js`: No pool error handling, no graceful shutdown, no reconnect logic~~ → **RESOLVED:** Added pool error listener with auto-reconnect, `closePool()` export, and graceful SIGTERM/SIGINT shutdown in `index.js`
- Inconsistent response formats across endpoints — standardize to `{ data, total, ... }`

### UI Frontend Improvements

**Performance:**
- ~~No code splitting — all 5 pages bundled eagerly~~ → **RESOLVED:** All 5 pages use `React.lazy()` + `<Suspense>` for route-based code splitting
- ~~ExcelJS (~200KB) loaded on every page~~ → **RESOLVED:** Dynamic `import()` in `handleExportExcel` — ExcelJS only loads when user clicks Export
- ~~@dnd-kit (~110KB) loaded even when drag not active — lazy-load~~ → **RESOLVED:** Extracted to `SortableMatrixBody.jsx` (separate chunk, ~60KB), dynamically imported. MatrixView renders static rows immediately, upgrades to sortable when chunk loads
- ~~No virtual scrolling in matrix — becomes slow with 100+ groups~~ → **RESOLVED:** `@tanstack/react-virtual` virtualizes table rows (overscan=20). During drag, virtualization is disabled so all rows are in the DOM for accurate drop positioning
- ~~`MatrixCell.jsx` memo comparison (line 80) missing `apNames` prop — stale renders possible~~ → **RESOLVED:** Added `apNames` to memo comparison

**Code Duplication:**
- ~~`UsersPage.jsx` / `GroupsPage.jsx`: 95% identical (565 lines each)~~ → **RESOLVED:** Extracted `useEntityPage` hook to `hooks/useEntityPage.js`; both pages reduced from ~565 to ~270 lines
- Tag operation handlers duplicated in AccessPackagesPage — could use `useEntityPage` hook too
- `TAG_COLORS` array defined 3 times — move to shared constants
- Search debounce pattern repeated in 4 places — extract `useDebouncedValue` hook
- Pagination UI duplicated in 3 pages — extract `PaginationControls` component
- `AP_COLORS` array duplicated in `MatrixColumnHeaders.jsx` and `exportToExcel.js`

**Architecture:**
- `MatrixView.jsx` (584 lines) handles data transformation + row reordering + Excel export + rendering — split into data hook + presentation
- App.jsx passes 16 props to MatrixView — consider Context or custom hook
- Prop drilling: MatrixView (36 props) → MatrixToolbar (21 props) → FilterBar (7 props)

**Accessibility:**
- Filter dropdowns use `<div onClick>` instead of `<button>` — not keyboard accessible
- Missing `<label>` elements on search inputs (placeholder is not a label)
- No visible focus indicators on custom inputs
- Color-only indicators (AP colors, type badges) need non-color alternatives for color-blind users

### Error Handling Consistency (Cross-Cutting)

**PowerShell functions:** ~40+ Generic functions have zero error handling. At minimum, Graph API calls should have try/catch with meaningful error messages. Consider a standard error pattern for all Generic functions.

**Frontend API calls:** Several places silently swallow errors (`catch { /* ignore */ }` in UsersPage line 81, GroupsPage line 79). Should at minimum log to console.

~~**`$ReturnValue += $Result`** in Base HTTP functions~~ → **RESOLVED** (March 2026): Changed to `$ReturnValue = $Result` in `Invoke-FGPutRequest`, `Invoke-FGPatchRequest`, `Invoke-FGPostRequest`, `Invoke-FGDeleteRequest`, and `Invoke-FGGetRequest` (first-assignment only; pagination `+=` in GetRequest is intentional).

### Minor Improvements

- **JSON depth:** Multiple files hardcode `-Depth 10` for `ConvertTo-Json`. Use `-Depth 100` to avoid silent truncation
- **Base64 padding:** Duplicated in `Get-FGAccessTokenDetail.ps1` for header and payload — extract helper
- **Config property navigation:** Duplicated across `Get-FGSecureConfigValue`, `Clear-FGSecureConfigValue`, `Test-FGSecureConfigValue` — extract helper
- **SecureString conversion:** 4 duplicates in `Get-FGSecureConfigValue.ps1` — extract `ConvertFrom-SecureStringToPlainText`
- **Parameter naming inconsistency** in Generic functions: `$id` vs `$Id`, `$DisplayName` vs `$displayName`, `$ObjectId` vs `$objectId`. Standardize to PascalCase
- ~~**Invoke-FGPutRequest.ps1** debug output says "PatchRequest" instead of "PutRequest"~~ → **RESOLVED**
- **Device code timeout** hardcoded to 300s in `Get-FGAccessTokenInteractive.ps1` — make parameter with default

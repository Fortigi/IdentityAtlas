# FortigiGraph - AI Assistant Development Guide

> **IMPORTANT: After making ANY code changes, you MUST add a changelog fragment!**
> 1. Create or update `changes/<branch-name>.md` (e.g. `changes/fix-mssql-shim-boolean.md`) with bullet points describing the functional change (user-facing language, not implementation details).
> 2. Do **NOT** edit `CHANGES.md` directly — the `bump-version.yml` Action merges all fragments into it on PR merge.
> 3. Do **NOT** edit `ModuleVersion` in `setup/IdentityAtlas.psd1` — version bumps are also automated by the same Action.

## Coding Principles

> **Reuse before creating.** Search before writing any function, constant, helper, hook, or component. Only create something new when nothing suitable exists. Applies across all languages (PowerShell, JavaScript, SQL). See each subdirectory CLAUDE.md for known utilities specific to that layer.

## Project Overview

Identity Atlas is a Docker-deployed application that pulls authorization data from Microsoft Graph (and other systems via CSV) into a **PostgreSQL** database, then surfaces it through a React role-mining UI. The worker container ships PowerShell crawler scripts; all persistence flows through the Node.js API.

**Key Information:**
- **Languages:** PowerShell (crawlers), JavaScript (Node API + React UI), SQL (postgres migrations)
- **Stack:** PostgreSQL 16 + Node.js API (port 3001) + PowerShell worker — all in Docker
- **Author:** Wim van den Heijkant / Fortigi — https://github.com/Fortigi/IdentityAtlas
- **Current Version:** 5.x.yyyyMMdd.HHmm (auto-bumped by `bump-version.yml` on every PR merge to `main`)

**Subdirectory coding guides (loaded contextually):**
- `Functions/CLAUDE.md` — PowerShell function conventions, patterns, Graph API permissions
- `app/api/CLAUDE.md` — Node.js API conventions, testing, migrations
- `app/ui/CLAUDE.md` — React/UI conventions, dark mode, shared utilities

**Architecture docs:** `docs/architecture/` contains postgres-migration, context-redesign, entity-detail-pages, llm-and-risk-scoring, docker-setup, csv-import-schema.

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
- Branch names: `feature/<short-descriptive-name>` or `bugfixes/<short-descriptive-name>` (lowercase, hyphens).
- When starting work, always create a new branch. Never work directly on `main`.
- **One issue per branch.** Each branch must fix exactly one issue or implement exactly one feature.

### Version Number Scheme

| Context | Version format | Example | Docker tag pushed |
|---------|---------------|---------|-------------------|
| `main` dev builds | `Major.Minor.yyyyMMdd.HHmm` | `5.3.20260419.1430` | `:edge` |
| Pre-release tags (`v*-beta.*` etc.) | `Major.Minor.Patch-beta.N` | `5.3.0-beta.1` | `:beta` |
| Release tags (`v*`) | `Major.Minor.Patch.0` | `5.2.1.0` | `:latest` |
| `feature/*` / `bugfixes/*` | — | — | Nobody |

**Who updates versions:**

| Context | Who updates it | When |
|---------|---------------|------|
| `main` dev builds | `bump-version.yml` (automated) | Every PR merge — increments `Minor`, updates timestamp |
| Pre-release tags | `cut-beta.yml` (automated) | When you run Actions → Cut Beta |
| Release tags | `cut-release.yml` / `cut-hotfix.yml` (automated) | When you run Actions → Cut Release or Cut Hotfix |
| `feature/*` / `bugfixes/*` | **Nobody** | Never touch `setup/IdentityAtlas.psd1` on a branch |

### Changelog Fragments

Every feature/bugfixes branch must add a fragment file under `changes/`. **Never edit `CHANGES.md` directly.**

- **Filename:** `changes/<descriptive-name>.md` — use the branch name or a short slug. One file per branch is typical.
- **Content:** Bullet points only. User-facing language. No implementation details.

**Fragment format:**
```markdown
- <Functional description of change 1>
- <Functional description of change 2>
```

**Rules:**
- Write in user-facing language ("Added X", "Fixed Y", "Improved Z").
- Do not describe internal refactors unless they affect observable behavior.
- Add a bullet immediately after each meaningful change — don't batch them up at the end.

---

## Data Model

### Universal Data Model (v3.1)

The data model supports importing authorization data from any system. Resources, ResourceAssignments, and ResourceRelationships are also used for governance data (business roles, governed assignments, resource grants).

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
- **Resources** — Any permission-granting resource (groups, roles, app roles, sites) **and** business roles (`resourceType='BusinessRole'`) with `extendedAttributes` JSON
- **ResourceAssignments** — Who has access to what (`resourceId` + `principalId` + `assignmentType`). Governed assignments use `assignmentType='Governed'`
- **ResourceRelationships** — Resource-to-resource links (`Contains`, `GrantsAccessTo`). Business role resource grants use `relationshipType='Contains'`
- **Principals** — User accounts from any system with `principalType` and `extendedAttributes` JSON
- **Identities** — Real persons aggregated from multiple accounts (account correlation)
- **IdentityMembers** — Links identities to their principals across systems

**Resource types in use:**

| `resourceType` | Source | What it represents |
|---|---|---|
| `EntraGroup` | Entra crawler | Security / Microsoft 365 group |
| `BusinessRole` | Governance sync (Entra access packages, Omada business roles) | Wraps groups via `relationshipType='Contains'`; assigned to users via `assignmentType='Governed'` |
| `Application` | OAuth2 / AppRoles phases | Enterprise application (service principal). Doesn't grant access by itself — it's the parent of AppRole / DelegatedPermission children |
| `AppRole` | `SyncAppRoles` phase | One synthetic resource per (Application, appRoleId). Parent app linked via `relationshipType='HasAppRole'`. Assigned to users via `assignmentType='AppRole'` (direct) or `assignmentType='AppRoleViaGroup'` (expanded from a group's role) |
| `DelegatedPermission` | `SyncOAuth2Grants` phase | One synthetic resource per (clientSP, targetApiSP, scope). Parent app linked via `relationshipType='DelegatesScope'`. Assigned to users via `assignmentType='OAuth2Grant'` |

**Assignment types in use:**

`Direct`, `Indirect`, `Owner`, `Eligible` (the four "how does this user have it" types) plus the *source-attribute* types `Governed`, `OAuth2Grant`, `AppRole`, `AppRoleViaGroup`. The matrix view (`vw_ResourceUserPermissionAssignments`) collapses the source-attribute types in its `membershipType` output — see [`docs/architecture/matrix.md`](docs/architecture/matrix.md) for the badge-display rules.

**Relationship types in use:** `Contains` (BusinessRole → group), `HasAppRole` (Application → AppRole), `DelegatesScope` (Application → DelegatedPermission), `GrantsAccessTo` (reserved).

**Core + JSON pattern:** Frequently-queried attributes are real SQL columns; system-specific attributes live in `extendedAttributes` JSON.

**Backward compatibility:** All queries prefer new tables (Resources, Principals) with automatic fallback to legacy tables (GraphGroups, GraphUsers).

### Contexts (v6, April 2026)

Contexts are a unified data surface. Single `Contexts` table with three variants (synced / generated / manual) and four target types (Identity / Resource / Principal / System). Membership lives in `ContextMembers`.

Legacy tables — `OrgUnits`, `GraphResourceClusters`, `GraphResourceClusterMembers`, `Identities.contextId`, `GraphTags`, `GraphTagAssignments` — are gone. Tags are now `contextType='Tag'` Contexts (with backward-compat views). Clustering, org-chart derivation, tags, and business processes are all context-algorithm plugins that register at startup and emit generated Contexts.

See `docs/architecture/context-redesign.md` for the design.

### Governance Model (v3.1 — Unified)

Business roles, certifications, and access policies from any IGA platform. Business roles and their assignments/resource grants are stored in the shared Resources, ResourceAssignments, and ResourceRelationships tables.

**Governance-specific tables:** GovernanceCatalogs, AssignmentPolicies, AssignmentRequests, CertificationDecisions.

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

---


## Repository Setup (One-Time)

### GitHub Actions Secrets

| Secret | Required scopes | Purpose |
|--------|----------------|---------|
| `VERSION_BUMP_PAT` | `repo` (includes `contents:write`) | Lets `bump-version.yml`, `cut-release.yml`, and `cut-hotfix.yml` push tags and commits to `main`. |

### Branch Protection

Run once after repo creation (requires `gh` CLI authenticated as admin):

```bash
bash tools/setup-branch-protection.sh Fortigi/IdentityAtlas
```

This sets: `main` — PR required (1 approval), `PR Summary` check required, admins bypass.

---

## Development Workflow

### Starting New Work

**Feature (not yet released):**
```bash
git checkout main && git pull
git checkout -b feature/<name>
```

**Pre-release bugfix:**
```bash
git checkout main && git pull
git checkout -b bugfixes/<name>
```

**Hotfix (bug in a released version):**
```bash
git checkout -b bugfixes/<name> v5.2.0   # branch from the release tag, NOT main
git push origin bugfixes/<name>
# Then run Actions → Cut Hotfix with the branch name and new version
# After the hotfix ships, cherry-pick the fix to main via a separate PR
```

### Making Changes

1. **Create/Edit** the relevant files
2. **Test locally** against the running Docker stack
3. **Add bullets to `changes/<branch-name>.md`** (create if it doesn't exist — do NOT edit `CHANGES.md`)
4. **Commit** with descriptive messages

### Stacked PRs (preferred workflow)

Break features into a stack of small, focused PRs. Each step gets its own branch targeting the previous branch in the stack.

```bash
# First slice — targets main
git checkout main && git pull
git checkout -b feature/foo-step-1
gh pr create --base main --title "step 1: ..."

# Second slice — stacked on top of step 1
git checkout -b feature/foo-step-2
gh pr create --base feature/foo-step-1 --title "step 2: ..."
```

When a bottom PR merges, retarget the next one: `gh pr edit <number> --base main`.

### Merging to Main

1. Open PR from `feature/<name>` or `bugfixes/<name>` into `main`
2. Use the fragment content from `changes/<branch-name>.md` as the PR description
3. Requires 1 approval — merge when CI passes
4. After merge: `bump-version.yml` increments Minor + timestamp; `docker-publish.yml` pushes `:edge`

### Cutting a Release

1. Go to **Actions → Cut Release → Run workflow**
2. Enter the version: `Major.Minor.Patch` (e.g. `5.2.0`)
3. The workflow creates tag `v5.2.0` on the current `main` HEAD
4. `docker-publish.yml` pushes `:latest` + `:5.2.0.0`

### Hotfix Releases

```bash
git checkout -b bugfixes/fix-foo v5.2.0
git push origin bugfixes/fix-foo
```

Then: **Actions → Cut Hotfix** with branch name and new version (e.g. `5.2.1`). Cherry-pick to `main` afterward.

---

## User Workflow (Getting Started)

```bash
curl -O https://raw.githubusercontent.com/Fortigi/IdentityAtlas/main/docker-compose.prod.yml
docker compose -f docker-compose.prod.yml up -d --pull always
# Open http://localhost:3001 → Admin → Crawlers → Add Crawler
```

---

## Branch: `claude/omada-crawler-sync-a1W3A` — Omada Crawler Sync

**Status (2026-06-03):** Fully tested end-to-end against `http://enterpriseserver.corporate.com` (BasicAuth, `corporate\demoadm`). All 9 phases complete: 322+ contexts, 321 identities, 332+ principals, 378 context-members, 13 220 resources across 58 systems, 72 entitlements, 30 000+ assignments, 37 961 CRAs. Ready for PR.

Server: `172.16.0.28` — AD DNS resolves `enterpriseserver.corporate.com → masterdemo.corporate.com → 172.16.0.28` (persisted via `extra_hosts` in `docker-compose.yml`).

### What this branch adds

Native Omada IGA crawler that pulls data directly from the Omada OData 4.0 REST API.

| Component | Location | What it does |
|-----------|----------|-------------|
| Omada SDK — auth | `tools/powershell-sdk/omada/Invoke-OmadaAuth.ps1` | `Connect-OmadaAPI` — 6 auth methods: FormCookie, BasicAuth, OAuth2CC, OAuth2ROPC, ApiToken, CookieString |
| Omada SDK — GET | `tools/powershell-sdk/omada/Invoke-OmadaGetRequest.ps1` | Authenticated GET with retry; stops pagination on empty page (not short page — Builtin returns variable-size pages) |
| Omada SDK — paged | `tools/powershell-sdk/omada/Invoke-OmadaPagedRequest.ps1` | Offset paging (`$top=N&$skip=M`); advances skip by actual received count |
| Crawler | `tools/crawlers/omada/Start-OmadaCrawler.ps1` | 9 phases — see below; posts per-phase results to `/api/crawlers/jobs/:id/phases` |
| Job dispatch | `setup/docker/Invoke-CrawlerJob.ps1` | `'omada'` case — validates config, runs crawler; no post-sync Build-FGContexts (Omada syncs its own contexts) |
| API validation | `app/api/src/routes/jobs.js` | `validateOmadaConfig`, `maskConfig`, `POST /admin/omada/validate-metadata` (live $metadata validation for wizard) |
| Metadata migration | `app/api/src/db/migrations/029_identities_extended_attributes.sql` | Adds `extendedAttributes jsonb` to `Identities` for Omada-specific fields |
| ingest/refresh-views | `app/api/src/routes/ingest.js` | Now also recalculates `directMemberCount` / `totalMemberCount` on all Contexts after full sync |
| Scheduler | `app/api/src/scheduler.js` | `'omada'` in crawlerType allowlist |
| Admin UI — wizard | `app/ui/src/components/CrawlersPage.jsx` | `OmadaWizard` 4-step, Step 3 includes `contextObjectTypes` editor with live $metadata validation (entity set + Identity property names, case-sensitive hint + auto-suggest) |
| Context detail page | `app/ui/src/components/ContextDetailPage.jsx` | Member click uses `targetType` to open correct detail kind (`identity`/`user`/`resource`) |
| Identities API | `app/api/src/routes/identities.js` | `contextCount` + `/contexts` endpoint now query ContextMembers directly by Identity UUID |
| User detail API | `app/api/src/routes/details.js` | Context count and `/user/:id/contexts` join through IdentityMembers → ContextMembers |
| Module | `setup/IdentityAtlas.psm1` | Omada SDK glob dot-sourced |
| Tests — JS | `app/api/src/routes/jobs.omada.test.js` | 22 Vitest tests for `maskConfig` and `validateOmadaConfig` |
| Tests — PS | `test/unit/Omada.Tests.ps1` | Pester 5 tests for SDK helpers |
| CI | `.github/workflows/pr.yml` | PSScriptAnalyzer + Pester coverage extended to omada SDK |
| Changelog | `changes/omada-crawler-sync-a1W3A.md` | Fragment ready for PR merge |

### Crawler phases (9)

| Phase | Entity set | What it syncs |
|-------|-----------|---------------|
| Systems | `/System` | All 58 Omada-connected systems registered as separate Identity Atlas Systems |
| Contexts | configurable `contextObjectTypes` | OrgUnits (and other configured types) as Contexts; Orgunit uses topological sort |
| Identities | `/Identity` | Person records with 30+ attributes mapped to columns + `extendedAttributes` JSON |
| Accounts | `/User` | Omada user accounts → Principals; builds `$userNameToUid` and `$identityUidToUserUids` lookups |
| IdentityMembers | join | Links Identities to their User accounts |
| ContextMembers | `/Contextassignment`, Identity OUREF/COUNTRY/etc., `/Employment` | Three sources; stored with `memberType='Identity'` so context detail page shows members |
| Resources | `/Resource` | 13 220+ resources grouped by connected system (SAP, AD, Salesforce, etc.) |
| Entitlements | `Resource.CHILDROLES` | Role nesting extracted inline from resources |
| Assignments | `/Resourceassignment` + `/CalculatedAssignments` (Builtin) | Role assignments (Governed) + CRA account assignments (Governed/Direct) with status/reasons/validFrom/To |

### OData API (confirmed from `$metadata`)

- **DataObjects** (`/odata/dataobjects`): `Orgunit`, `Identity`, `User`, `Resource`, `Resourceassignment`, `Contextassignment`, `Employment`, `Country`, `Job_titles`, 25 total
- **Builtin** (`/odata/builtin`): `CalculatedAssignments` — effective account provisioning; use `$top=1000` bulk pagination (server returns variable-size pages — do not stop on short page, stop on empty)
- All property names ALL CAPS; reference fields are `OIS.SetValue` (`.Value`) or `OIS.ReferenceValue` (`.DisplayName`, `.UId`)
- Always filter `$filter=Deleted eq false` on DataObjects; `$filter=Status eq true` on CalculatedAssignments

### Key design decisions

- **Systems**: Each connected system (`/System`) registered as a separate Identity Atlas System. Resources and assignments linked to their correct system via `SYSTEMREF`.
- **ContextMembers**: Stored with `memberType='Identity'`, `memberId=Identity.UId` (one record per identity per context). This matches the context detail page's query (`WHERE memberType = context.targetType`). The identity detail page queries ContextMembers directly by Identity UUID.
- **Assignments — two sources**:
  - `Resourceassignment` (DataObjects): IGA-governed role assignments (business roles, AD groups, etc.) → `assignmentType='Governed'`, fanned out to all Identity accounts
  - `CalculatedAssignments` (Builtin): effective account provisioning → Principals derived from `AccountKey`, `Attributes` (FIRSTNAME/LASTNAME/EMAIL) — for connected-system accounts (Salesforce, AD, etc.)
- **CRA pagination**: Use `$top=1000` with `$skip` offset; stop when page is empty (`Count == 0`), not when short — Builtin returns variable-size pages even when more records remain.
- **configObjectTypes**: Configurable via the wizard or JSON. Each entry: `{ entitySet, contextType, identityField }`. The `identityField` (e.g. `OUREF`) creates direct ContextMember links from each Identity's reference fields. Validated live against `$metadata` in the wizard.
- **Builtin URL**: `$builtinBaseUrl = $baseUrl -replace '/dataobjects/?$', '/builtin'`
- **directMemberCount**: Populated by `ingest/refresh-views` (called at end of each sync) via bulk SQL UPDATE — the per-context recalc helper is only for manual writes.

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
- `Functions/CLAUDE.md` — PowerShell SDK conventions (style, naming, Graph API patterns) — note: folder paths inside are v4-era; conventions still apply
- `tools/crawlers/CLAUDE.md` — Crawler dev quick-reference (rules, key files, tests); authoring guide in `docs/sync/custom-crawlers.md`, architecture in `docs/architecture/crawler-architecture.md`
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

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

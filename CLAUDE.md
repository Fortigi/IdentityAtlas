# FortigiGraph - AI Assistant Development Guide

> **IMPORTANT: After making ANY code changes, you MUST add a changelog fragment!**
> 1. Create or update `changes/<branch-name>.md` (e.g. `changes/fix-mssql-shim-boolean.md`) with bullet points describing the functional change (user-facing language, not implementation details).
> 2. Do **NOT** edit `CHANGES.md` directly — the `bump-version.yml` Action merges all fragments into it on PR merge.
> 3. Do **NOT** edit `ModuleVersion` in `setup/IdentityAtlas.psd1` — version bumps are also automated by the same Action.

## Coding Principles

> **Reuse before creating.** Search before writing any function, constant, helper, hook, or component. Only create something new when nothing suitable exists. Applies across all languages (PowerShell, JavaScript, SQL). See each subdirectory CLAUDE.md for known utilities specific to that layer.

> **Fix at the source, not the surface.** When a value is missing, wrongly shaped, or derived, fix it where the data is produced — the crawler, the ingest layer, the schema, or the matview — so every consumer benefits. **Before writing any client-side workaround** (computing, deriving, reshaping, or faking in the UI what the data should already provide), stop and ask: *should this live in the data model instead?* Client-side patches that paper over a data-model gap silently accrue as duplication and drift — e.g. the matrix once simulated "owner as its own row" in React while the data still stamped `assignmentType='Owner'` on the group; two mechanisms for one concept, kept in sync by hand. Prefer the deeper fix. If a surface-level fix is genuinely the right call, say why in the PR.

> **Grow coverage toward 100% — every code change must ratchet it up, never down.** This applies to **functional code changes only** (PowerShell, JavaScript, SQL) — *not* to documentation, CI/workflow/pipeline files, config, or generated artifacts. We are not at 100% line + branch coverage yet and you do **not** have to reach it in one commit — the rule is directional: a commit that adds or changes code must (a) ship tests that cover the lines and branches it introduces or touches, and (b) **not lower** the suite's line or branch coverage. New functions/modules ship with tests; when you edit existing code, extend its tests to cover the new paths. Over time this walks every layer (API, UI, PowerShell SDK, crawlers) up to full coverage. If a change genuinely can't be unit-tested, say why in the PR.

> **Keep source files small enough to reason about — split before they sprawl.** A source file past ~600 lines is a smell; past ~1000 lines it must be broken into focused files/functions *before* more is added to it. Split by responsibility — extract helpers, sub-routines, and distinct phases into their own files. The monolithic `Start-*Crawler.ps1` crawlers (up to ~2,700 lines, with functions trapped inside a top-level `Main` body) are the cautionary example: their size is exactly what makes them untestable without a refactor. Don't add to that pattern; new code lands in small, single-responsibility units.

### Enforcement

The four principles above are framed identically ("MUST"), but they are **not** enforced identically. Some are hard CI gates that fail your PR; others rely on reviewer judgement. Know which is which:

| Principle | How it's actually enforced |
|-----------|----------------------------|
| **Reuse before creating** | Reviewer judgement, backed by the `jscpd` duplication gate — `Lint: Code duplication (jscpd)` in `.github/workflows/pr.yml`, threshold in `.jscpd.json`. It catches copy-paste, not all missed-reuse. |
| **Fix at the source, not the surface** | Reviewer only — no automated gate. Call out in the PR when you took a surface fix and why. |
| **Coverage never down** | Hard gate — two committed ratchets, both enforced by the `Unit Tests: Vitest (API)` / `Unit Tests: Vitest (UI)` PR Checks jobs (`npm run test:coverage`): the **aggregate** floor (Vitest thresholds in `app/api/vitest.config.js` + `app/ui/vite.config.js`) and a **per-file** floor (`tools/coverage/ratchet.py` + `.ci/coverage-baseline.json`, only ratchets up) so one file can't quietly shed coverage while another rises. Changed-line coverage is separately gated by the diff-coverage check. A drop below any floor fails the PR. |
| **Keep files small (>1000 must split)** | Hard gate — the file-length ratchet: `.github/workflows/filesize.yml` + `tools/filesize/ratchet.py` + `.ci/filesize-baseline.json`. Grandfathered files may only shrink; a new/crossing-the-ceiling oversized file fails. |

**Related gate — per-function complexity ratchet:** `.github/workflows/complexity.yml` + `tools/complexity/ratchet.py`, with baselines in `.ci/complexity-baseline.json` (cyclomatic) and `.ci/cognitive-baseline.json` (cognitive). No unit may exceed its grandfathered baseline, and new/touched units must stay under the per-language threshold. Both baselines only ratchet down.

## Project Overview

Identity Atlas is a Docker-deployed application that pulls authorization data from Microsoft Graph (and other systems via CSV) into a **PostgreSQL** database, then surfaces it through a React role-mining UI. The worker container ships PowerShell crawler scripts; all persistence flows through the Node.js API.

**Key Information:**
- **Languages:** PowerShell (crawlers), JavaScript (Node API + React UI), SQL (postgres migrations)
- **Stack:** PostgreSQL 16 + Node.js API (port 3001) + PowerShell worker — all in Docker
- **Author:** Wim van den Heijkant / Fortigi — https://github.com/Fortigi/IdentityAtlas
- **Current Version:** 5.x.yyyyMMdd.HHmm (auto-bumped by `bump-version.yml` on every PR merge to `main`)

**Subdirectory coding guides (loaded contextually):**
- `Functions/CLAUDE.md` — PowerShell SDK conventions (style, naming, Graph API patterns) — note: folder paths inside are v4-era; conventions still apply
- `tools/crawlers/CLAUDE.md` — Crawler dev quick-reference (rules, key files, tests); authoring guide in `docs/sync/building-a-crawler.md`, architecture in `docs/architecture/crawler-architecture.md`
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
- **ResourceAssignments** — Who has access to what (`resourceId` + `principalId` + `assignmentType` ∈ {`Direct`, `Indirect`, `Eligible`}). Governance-driven assignments carry `governed=true`
- **ResourceRelationships** — Resource-to-resource links (`Contains`, `GrantsAccessTo`). Business role resource grants use `relationshipType='Contains'`
- **Principals** — User accounts from any system with `principalType` and `extendedAttributes` JSON
- **Identities** — Real persons aggregated from multiple accounts (account correlation)
- **IdentityMembers** — Links identities to their principals across systems

**Resource types in use:**

| `resourceType` | Source | What it represents |
|---|---|---|
| `Group` | Entra crawler | Security / Microsoft 365 group |
| `EntraDirectoryRole` | `SyncDirectoryRoles` phase | One resource per Entra directory role (`id` = roleDefinitionId). `extendedAttributes` holds the role's granular `allowedResourceActions`, `isBuiltIn`, and `templateId`. Assigned to principals via `Direct` (active) or `Eligible` (PIM-eligible) |
| `BusinessRole` | Governance sync (Entra access packages, Omada business roles) | Wraps groups via `relationshipType='Contains'`; flagged `governanceResource=true`; assigned to users via a `Direct` membership flagged `governed=true` |
| `Application` | OAuth2 / AppRoles phases | Enterprise application (service principal). Doesn't grant access by itself — it's the parent of AppRole / DelegatedPermission children |
| `AppRole` | `SyncAppRoles` phase | One synthetic resource per (Application, appRoleId). Parent app linked via `relationshipType='HasAppRole'`. Assigned to users via `Direct` (direct) or `Indirect` (expanded from a group's role) |
| `DelegatedPermission` | `SyncOAuth2Grants` phase | One synthetic resource per (clientSP, targetApiSP, scope). Parent app linked via `relationshipType='DelegatesScope'`. Assigned to users via `Direct` |
| `ApplicationPermission` | `SyncAppPermissions` phase | One synthetic resource per (clientSP, targetApiSP, appRole) — the app-only (admin-consented) permission an SP holds on another API (e.g. `Mail.Read` on Microsoft Graph). The app-only sibling of `DelegatedPermission`. Parent client app linked via `relationshipType='HasApplicationPermission'`. Held by the SP itself via a `Direct` assignment whose `principalType` is the holder's class (`ServicePrincipal` / `ManagedIdentity` / `AIAgent`) — this is how a managed identity's or AI agent's tenant-wide API access shows up |
| `ServicePrincipalOwnership` | `SyncAppOwners` phase | Owners of an enterprise-app service principal. One resource per owned app, named after the app, linked to its `Application` via `relationshipType='HasAppOwnership'`. Each owner is a `Direct` assignment |
| `ApplicationOwnership` | `SyncAppOwners` phase | Owners of an app registration — they can add a credential and authenticate *as* the app. Matched to the app's SP by `appId` and linked via `HasAppOwnership`. Each owner is a `Direct` assignment |

**Assignment types in use:**

`Direct`, `Indirect`, `Eligible` — the three universal "how does this user have it" values, and the **only** accepted ones (ingest rejects anything else; `app/api/src/ingest/assignmentTypes.guard.test.js` statically scans the crawlers so a retired type can't be reintroduced). Everything that used to be its own assignmentType is now modelled differently:
- **Ownership** → a `Direct` membership on a `GroupOwnership` resource (named after the owned group), not an `Owner` type.
- **Governance** → the `governed` boolean flag on the assignment (the business role / access package itself is flagged `governanceResource`), not a `Governed` type.
- **Source-attribute detail** (former `OAuth2Grant`, `AppRole`, `AppRoleViaGroup`, `DirectoryRole`, `DirectoryRoleEligible`) → collapse to `Direct`/`Indirect`/`Eligible`, with `resourceType` carrying the source detail.

See [`docs/architecture/matrix.md`](docs/architecture/matrix.md) for the badge-display rules.

**Relationship types in use:** `Contains` (BusinessRole → group), `HasAppRole` (Application → AppRole), `DelegatesScope` (Application → DelegatedPermission), `HasApplicationPermission` (Application → ApplicationPermission), `HasOwnership` (group → GroupOwnership), `HasAppOwnership` (Application → Application/ServicePrincipal ownership), `GrantsAccessTo` (reserved).

**Core + JSON pattern:** Frequently-queried attributes are real SQL columns; system-specific attributes live in `extendedAttributes` JSON.

**Backward compatibility:** Account and resource data lives in the universal `Principals` and `Resources` tables. The pre-v3.1 `GraphUsers` / `GraphGroups` tables are **gone from the schema** (never created by the v5 migrations) — there is no runtime fallback to them.

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
| ResourceAssignments | `governed=true` | AP Assignment | Role Assignment | Access Request Result |
| AssignmentPolicies | — | AP Assignment Policy | Assignment Policy | Access Request Config |
| AssignmentRequests | — | AP Assignment Request | — | Access Request |
| CertificationDecisions | — | AP Access Review | CRA | Certification |

---


## Repository Setup (One-Time)

### GitHub Actions Secrets

The version/release workflows (`bump-version.yml`, `cut-release.yml`, `cut-hotfix.yml`)
authenticate as a **GitHub App** — `actions/create-github-app-token` mints a
short-lived installation token that pushes tags and commits to `main` (a PAT is
no longer used).

| Secret | Purpose |
|--------|---------|
| `BOT_APP_ID` | Client ID of the GitHub App used to mint the installation token. |
| `BOT_PRIVATE_KEY` | Private key (PEM) for that GitHub App. |

### Branch Protection

Branch protection for `main` is configured via a GitHub **repository ruleset**
(Settings → Rules → Rulesets) — there is no setup script. The ruleset requires a
pull request with at least 1 approval before merging to `main`. Manage it in the
GitHub UI.

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

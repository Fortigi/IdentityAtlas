# Identity Atlas — Complete Testing Guide

> **For human testers** — this guide walks you through testing Identity Atlas end-to-end, from a fresh setup to validating every major feature. Automated test scripts are provided where possible.

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Environment Setup](#2-environment-setup)
3. [Phase 0: PR Checks (No Docker)](#3-phase-0-pr-checks)
4. [Phase 1: Offline Tests (Docker Only)](#4-phase-1-offline-tests-docker-only)
5. [Phase 3: Sync Integration Tests](#6-phase-3-sql--sync-integration-tests)
6. [Phase 4: Risk Scoring Tests](#7-phase-4-risk-scoring-tests)
7. [Phase 6: UI Feature Walkthrough (Manual)](#9-phase-6-ui-feature-walkthrough-manual)
8. [Phase 8: Cleanup](#11-phase-8-cleanup)
9. [Test File Reference](#12-test-file-reference)
10. [CI/CD Pipelines](#13-cicd-pipelines)

> **Note (April 2026)**: Azure App Service / Azure Automation deployment phases have been removed.
> Identity Atlas is now Docker-only. Phase 2 (Azure setup), Phase 5 (UI deployment), and Phase 7
> (Azure Automation tests) are no longer applicable. The remaining phases test the Docker stack.

---

## 1. Prerequisites

### Software Requirements

| Software | Version | Install Command |
|---|---|---|
| **Docker Desktop** | Latest | `winget install Docker.DockerDesktop` |
| **PowerShell** | 7.2+ | `winget install Microsoft.PowerShell` (only for running unit tests) |
| **Node.js** | 20+ | `winget install OpenJS.NodeJS.LTS` (only for UI testing) |
| **Git** | Any | `winget install Git.Git` (only for cloning the repo) |

### Optional: Entra ID test tenant

A separate Entra ID tenant with a few users, groups, and (ideally) access packages is needed for end-to-end testing of the Microsoft Graph crawler. Use the in-browser wizard (Admin → Crawlers → Add Crawler → Microsoft Graph) to wire it up.

### Optional (for Risk Scoring)

| Requirement | Details |
|---|---|
| **Anthropic API Key** | For LLM-assisted risk profile generation |
| **OR OpenAI API Key** | Alternative LLM provider |

### Entra ID Test Data Checklist

For thorough testing, your tenant should have:

- [ ] **Users** (5+ minimum): Regular users with varying departments, job titles, cities
- [ ] **Groups** (5+ minimum): Mix of security groups and Microsoft 365 groups
- [ ] **Group Members**: At least some groups with 3+ members
- [ ] **Group Owners**: At least 2 groups with assigned owners
- [ ] **Nested Groups** (optional): Group A member of Group B for transitive testing
- [ ] **PIM Eligible Members** (optional): Privileged Identity Management assignments
- [ ] **Access Packages** (optional but recommended): At least 1 catalog with 1 access package, 1 assignment
- [ ] **Access Reviews** (optional): At least 1 completed access review

---

## 2. Environment Setup

### Step 1: Clone the repo (developers only)

```bash
git clone https://github.com/Fortigi/IdentityAtlas.git
cd IdentityAtlas
```

End users can skip cloning entirely — see [docker-compose.prod.yml](../docker-compose.prod.yml).

### Step 2: Start the Docker stack

```bash
docker compose up -d --build
```

Wait ~30 seconds for PostgreSQL to be ready, then open [http://localhost:3001](http://localhost:3001).

### Step 3: Add a Microsoft Graph crawler (for tenant-backed tests)

In the UI, go to **Admin → Crawlers → Add Crawler → Microsoft Graph** and enter:

| Field | Value |
|---|---|
| Tenant ID | Your test tenant ID |
| Client ID | App Registration client ID |
| Client Secret | App Registration secret |

The wizard validates the credentials, shows which Graph permissions are granted, lets you pick object types, and saves the config in the `CrawlerConfigs` SQL table. Required Application permissions:

| Permission | Purpose |
|---|---|
| `User.Read.All` | Read all users |
| `Group.Read.All` | Read all groups |
| `GroupMember.Read.All` | Read group memberships |
| `Directory.Read.All` | Read directory data |
| `EntitlementManagement.Read.All` | Read access packages |
| `AccessReview.Read.All` | Read access reviews |
| `AuditLog.Read.All` | Read audit/sign-in data (optional) |

---

## 3. Phase 0: PR Checks (No Docker)

These checks run on every pull request and take under 5 minutes. They require nothing beyond a local checkout.

### PSScriptAnalyzer — PowerShell Linting

```powershell
Install-Module PSScriptAnalyzer -Force -Scope CurrentUser
Invoke-ScriptAnalyzer -Path ./Functions -Recurse -Severity Warning,Error
```

### ESLint — JavaScript Linting

```bash
cd app/ui
npm ci
npm run lint
```

### Pester — PowerShell Unit Tests

```powershell
Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser
Invoke-Pester -Path test/unit/IdentityAtlas.Tests.ps1 -Output Detailed
```

**What it tests:**
- Module imports without errors; manifest is valid; version format is `Major.Minor.yyyyMMdd.HHmm`
- All ~130 expected functions are exported (Base, Generic, SQL, Sync, Automation, RiskScoring)
- Removed functions are gone (e.g. `Sync-FGGroupTransitiveMember`)
- All function aliases point to the correct functions
- All `.ps1` files follow `Verb-FGNoun` naming convention
- `[CmdletBinding()]` present on all functions; no Dutch comments; no hardcoded secrets; no `Write-Output`
- Config template exists and is valid JSON with required sections
- Function counts per folder within expected ranges

**Expected result:** All tests pass with 0 failures.

### Vitest — API Unit Tests

```bash
cd app/api
npm ci
npm test
```

**What it tests** (`src/ingest/validation.test.js`, 53 test cases):
- `validateEnvelope`: required fields, array bounds (0–50 000), `syncMode`/`idGeneration` enums, `idPrefix` requirement, `systems` endpoint skips `systemId`
- `validateRecords` for `principals`: required `displayName`, UUID enforcement on `id`/`managerId`, all `principalType` enum values, `maxLength` on string fields, non-string rejection
- `validateRecords` for `resource-assignments`: required triad, all `assignmentType` values
- `validateRecords` for `resource-relationships`: required triad, all `relationshipType` values
- Unknown entity type → error; 10-error cap with "stopped after" message

### npm audit — Dependency Scan

```bash
cd app/ui  && npm audit --audit-level=high
cd app/api && npm audit --audit-level=high
```

### OpenAPI Lint — Spectral

```bash
npm install -g @stoplight/spectral-cli
spectral lint app/api/src/openapi.yaml --ruleset @stoplight/spectral-oas
```

---

## 4. Phase 1: Offline Tests (Docker Only)

These tests validate the full stack locally using Docker. No external services needed.

### Start the Docker stack

```bash
docker compose up -d --build
# Wait ~30 seconds for SQL to initialize
```

### Run the Docker integration test suite

```powershell
pwsh -File test/run-docker-tests.ps1
```

Results are written to `test/test-results.md` (gitignored — local artifact only).

**What it tests (87 checks across 9 categories):**

| Category | Coverage |
|---|---|
| Infrastructure | SQL, backend, worker containers running; table-init exited 0 |
| API | Health, version, features, auth-config, Swagger UI, OpenAPI spec, frontend HTML |
| CrawlerAuth | Register, whoami, invalid key rejection, key rotation, admin list |
| DemoDataset | Generate + ingest via API |
| Schema | 14 expected tables exist |
| DataCounts | Row count minimums for all entity tables after ingest |
| Integrity | No orphan assignments (resourceId / principalId FK checks) |
| BusinessLogic | Principal types, resource types, assignment types, context hierarchy, governance |
| MatrixAPI | Matrix returns user rows; tag create → assign → filter → delete lifecycle |

**Expected result:** 87 passed, 0 failed.

**Teardown:**

```bash
docker compose down -v
```

---

## 5. Phase 3: SQL + Sync Integration Tests

### Full Integration Test

Run the Microsoft Graph crawler against a real test tenant via the UI:

1. In the browser, go to **Admin → Crawlers**
2. Click your saved Microsoft Graph crawler → **Run Now**
3. Watch the job progress bar
4. After completion, open the **Matrix** page and verify users, groups, and assignments appear

**What this exercises:**
- Backend bootstrap (creates Built-in Worker crawler + queues)
- Worker job pickup from `CrawlerJobs` SQL queue
- Microsoft Graph API auth + paging
- Ingest API for principals, resources, assignments, identities, governance
- Post-sync context build + account correlation
- Matrix view rendering with AP coloring

### Manual Sync Verification

```bash
# Open a psql shell into the postgres container
docker compose exec postgres psql -U identity_atlas -d identity_atlas

# Row counts
SELECT (SELECT count(*) FROM "Principals") AS users,
       (SELECT count(*) FROM "Resources")  AS resources,
       (SELECT count(*) FROM "ResourceAssignments") AS assignments,
       (SELECT count(*) FROM "Identities") AS identities;
```

---

## 6. Phase 4: Risk Scoring Tests

### Automated Risk Scoring Test

```powershell
pwsh -File _Test\Test-RiskScoring.ps1 -ConfigFile _Test\config.test.json -LLMProvider Anthropic -LLMApiKey "sk-ant-..."
```

Or with OpenAI:

```powershell
pwsh -File _Test\Test-RiskScoring.ps1 -ConfigFile _Test\config.test.json -LLMProvider OpenAI -LLMApiKey "sk-..."
```

**What it tests:**
- Risk profile generation (LLM-assisted, public domain only)
- Risk profile persistence to SQL
- Risk classifier generation from profile
- Risk classifier persistence to SQL
- Export/import of profiles and classifiers (JSON files)
- Batch scoring of all users and groups
- Score distribution validation (0-100 range, tier assignment)
- Analyst override: set, verify, remove
- Resource clustering

**Duration:** 5-10 minutes (LLM calls take a few seconds each)

### Manual Risk Scoring Verification

```powershell
# Check risk scores exist on users
Invoke-FGSQLQuery -Query "SELECT TOP 10 displayName, riskScore, riskTier FROM GraphUsers WHERE riskScore IS NOT NULL ORDER BY riskScore DESC"

# Check risk scores exist on groups
Invoke-FGSQLQuery -Query "SELECT TOP 10 displayName, riskScore, riskTier FROM GraphGroups WHERE riskScore IS NOT NULL ORDER BY riskScore DESC"

# Check tier distribution
Invoke-FGSQLQuery -Query "SELECT riskTier, COUNT(*) AS Count FROM GraphUsers WHERE riskScore IS NOT NULL GROUP BY riskTier ORDER BY MIN(riskScore) DESC"

# Check an analyst override
Invoke-FGSQLQuery -Query "SELECT displayName, riskScore, riskOverride, riskOverrideReason FROM GraphUsers WHERE riskOverride IS NOT NULL"
```

---

## 7. Phase 5: Frontend Tests

### Run UI E2E Tests (Browser Tests)

Playwright E2E tests validate that UI pages render correctly, navigation works, and interactive features function. These run against the **mock backend** — no Docker or SQL required.

**First-time setup:**

```bash
cd app/ui
npm install
npx playwright install chromium
```

**Run tests:**

```bash
cd app/ui

# Headless (CI-friendly)
npm run test:e2e

# See the browser while tests run
npm run test:e2e:headed

# Interactive test runner with time-travel debugging
npm run test:e2e:ui
```

Playwright automatically starts the mock backend (`USE_SQL=false`) and Vite dev server. No manual startup needed.

**What it tests (12 spec files):**

| Spec file | What it validates |
|-----------|-------------------|
| `navigation.spec.js` | Title is "Identity Atlas"; always-visible tabs present (Matrix, Users, Resources, Systems, Business Roles, Sync Log); tab switching; hash routing; no auth gate in no-auth mode |
| `matrix.spec.js` | Matrix table renders with rows; user limit slider; IST/SOLL/All toggle; D/I/E membership badges; share/export buttons; filter dropdowns |
| `tags.spec.js` | Full tag lifecycle via API: create → appears in list → assign to resource → filter resources by tag → matrix `__groupTag` filter → delete |
| `users-page.spec.js` | User table, search debounce, tag flow, pagination, click-to-detail |
| `groups-page.spec.js` | Resource table (formerly Groups), search, tag management, click-to-detail |
| `access-packages.spec.js` | Business Roles table, category creation, assignment type badges, pagination |
| `sync-log.spec.js` | Table or empty state, column headers, status badge colors |
| `risk-scoring.spec.js` | Page renders, tier badges, score bars, no unhandled errors |
| `org-chart.spec.js` | Page renders, search input, no crashes |
| `performance.spec.js` | Summary/Recent/Slow tabs, export button |
| `detail-pages.spec.js` | Hash-based detail routing, multiple tabs open, close button |
| `identities.spec.js` | Identities page renders without errors |

**Test reports** are saved to `app/ui/playwright-report/` (open `index.html` in a browser).

**Screenshots on failure** are saved to `app/ui/test-results/`.

### Run E2E Tests Against the Local Docker Stack

To test against the running Docker stack instead of mock data:

```bash
cd app/ui
BASE_URL=http://localhost:3001 npx playwright test
```

Note: Tag/category creation tests will create real data in SQL when running against the Docker stack.

---

## 8. Phase 6: UI Feature Walkthrough (Manual)

Open the UI URL in a browser and test each page. Use this checklist:

### Matrix Page

- [ ] Matrix loads with users as columns and groups as rows
- [ ] Cells show colored badges: **D** (blue), **I** (green), **E** (amber)
- [ ] Owner rows appear separately suffixed with "(Owner)"
- [ ] **IST/SOLL toggle**: "All" shows everything, "IST" shows only unmanaged, "SOLL" shows only AP-managed
- [ ] **User limit slider**: Changing the slider reloads with fewer/more users
- [ ] **Staircase sort**: Rows with AP assignments cluster at the top with a diagonal pattern
- [ ] **Drag-and-drop**: Drag a row to reorder. Reload page — order persists
- [ ] **AP coloring**: Managed cells have colored backgrounds matching their access package
- [ ] **Multi-AP indicator**: If a cell is in multiple APs, a count badge appears
- [ ] **Category boundaries**: Thick borders and colored stripes between AP category groups
- [ ] **Excel export**: Click Export → opens an .xlsx file with AP-colored cells and badges
- [ ] **Share link**: Click Share → paste URL in new tab → same filters/limit/toggle are applied
- [ ] **Filter pills**: Click "+ Add filter" → select "Department" → select a value → matrix filters
- [ ] **Column header filter**: Click Type column header → filter by "Direct" only
- [ ] **Tags column filter**: Click Tags header → select "(Blank)" → shows only untagged groups
- [ ] **Provisioning gap indicator**: If an AP assigns a group but a user has no Direct membership, a "!" badge appears

### Users Page

- [ ] Users load with pagination (page size selector works)
- [ ] **Search**: Type a name → results filter in real-time (debounced)
- [ ] **Filter pills**: Add filter by department/city/etc → table filters
- [ ] **Tag management**: Click "Manage Tags" → create a tag with a color → close
- [ ] **Tag assignment**: Select users with checkboxes → assign the new tag
- [ ] **Bulk tag**: Click "Tag All Matching" → all users matching current filter get the tag
- [ ] **Click user name**: Opens a detail tab with all attributes, group memberships, history

### Groups Page

- [ ] Groups load with pagination
- [ ] **Search**: Type a group name → results filter
- [ ] **Tag management**: Same as Users page — create, assign, bulk-tag
- [ ] **Click group name**: Opens a detail tab with members, AP assignments, history

### Access Packages Page

- [ ] Access packages load with catalog name and assignment count
- [ ] **Assignment type**: Column shows "Admin", "Request", or "Auto" badges
- [ ] **Category management**: Click "Manage Categories" → create a category with color
- [ ] **Category assignment**: Select APs → assign category (or use inline dropdown)
- [ ] **Filter by category**: Click a category pill → table filters to that category
- [ ] **Uncategorized filter**: Click "Uncategorized" → shows only APs without a category
- [ ] **Click AP name**: Opens detail tab with assignments, policies, last review

### Sync Log Page

- [ ] Shows recent sync operations with timestamps
- [ ] Each row shows: entity type, row count, duration, status
- [ ] Most recent sync is at the top

### Risk Scoring Page (requires `Invoke-FGRiskScoring` to have been run)

- [ ] **Summary cards**: Shows total scored entities, average score, tier distribution
- [ ] **User scores table**: Paginated list with score bars and tier badges
- [ ] **Group scores table**: Same format for groups
- [ ] **Tier filter**: Click a tier badge → filters to that tier only
- [ ] **Score bar colors**: Critical=red, High=orange, Medium=yellow, Low=blue, Minimal=gray
- [ ] **Click a user/group**: Expands to show:
  - Per-layer score breakdown (Direct, Membership, Structural, Propagation)
  - Classifier matches with regex patterns
  - Explanation text
- [ ] **Analyst override**: Click "Override" on a user → enter adjustment (-50 to +50) and reason → Submit
- [ ] Override badge appears next to score
- [ ] Effective score = computed + override (clamped 0-100)
- [ ] **Remove override**: Click remove → override disappears

### Org Chart Page (requires user sync with manager data)

- [ ] Manager hierarchy loads as a tree
- [ ] Department boxes are color-coded by risk tier
- [ ] Report counts show direct and indirect reports
- [ ] **Search**: Filter by department name
- [ ] **Click department**: Opens department detail page with member list

### Performance Page (requires `-PerformanceMetrics` flag on deployment)

- [ ] **Endpoint summaries**: Table with P50/P95/P99 times per route
- [ ] **Recent requests**: Last 20 requests with timing breakdown
- [ ] **Slowest requests**: Top 10 slowest with SQL query details
- [ ] **Export**: Download JSON file with all metrics

### Entity Detail Pages

- [ ] **User detail**: Shows all attributes from SQL, risk score section, group memberships with type badges, AP assignments, version history diffs
- [ ] **Group detail**: Shows all attributes, member list with type badges, AP assignments, version history
- [ ] **Multiple tabs**: Open 2+ detail tabs → each has a close (×) button
- [ ] **Hash routing**: Copy URL with `#user:id` → paste in new tab → opens same detail
- [ ] **Drill-through**: In user detail, click a group name → opens group detail tab

---

## 10. Phase 8: Cleanup

### Stop the Docker stack (keeps data)

```bash
docker compose down
```

### Stop and remove all data

```bash
docker compose down -v
```

### Clean Up Local Files

```bash
rm -rf _Test/logs _Test/exports 2>/dev/null
```

---

## 12. Test File Reference

### Test structure

```
test/
├── test.config.json              # Central config: API URLs, SQL credentials
├── run-docker-tests.ps1          # Docker integration suite (87 checks)
├── test-results.md               # Latest Docker test run results (gitignored)
├── TESTING-GUIDE.md              # This file
├── unit/
│   ├── IdentityAtlas.Tests.ps1   # Pester v5 unit tests (module structure, quality)
│   ├── Test-Simple.ps1           # Module + config sanity check
│   └── Test-GraphAPI.ps1         # Graph API connectivity tests
├── demo-dataset/
│   ├── Generate-DemoDataset.ps1  # Generates demo-company.json
│   ├── Ingest-DemoDataset.ps1    # Posts dataset to Ingest API
│   └── demo-company.json         # Generated fixture (gitignored)
├── nightly/
│   ├── Register-NightlySchedule.ps1
│   └── Run-NightlyLocal.ps1

app/
├── api/
│   ├── package.json              # includes "test": "vitest run"
│   └── src/ingest/
│       ├── validation.js         # Validation logic
│       └── validation.test.js    # Vitest unit tests (53 test cases)
└── ui/
    ├── playwright.config.js      # Starts mock backend + Vite dev server
    ├── eslint.config.js          # ESLint 9 flat config
    └── e2e/                      # Playwright spec files (12 files)
        ├── navigation.spec.js
        ├── matrix.spec.js
        ├── tags.spec.js          # Tag lifecycle: create → assign → filter → delete
        ├── users-page.spec.js
        ├── groups-page.spec.js
        ├── access-packages.spec.js
        ├── sync-log.spec.js
        ├── risk-scoring.spec.js
        ├── org-chart.spec.js
        ├── performance.spec.js
        ├── detail-pages.spec.js
        └── identities.spec.js

.github/workflows/
├── pr.yml                        # PR checks (fast, no Docker required)
└── docs.yml                      # MkDocs deploy on push to main
```

### Quick-reference command table

| What | Command | Docker? | Duration |
|------|---------|---------|----------|
| Pester unit tests | `Invoke-Pester -Path test/unit/IdentityAtlas.Tests.ps1` | No | ~15 s |
| Vitest API tests | `cd app/api && npm test` | No | ~5 s |
| ESLint | `cd app/ui && npm run lint` | No | ~5 s |
| PSScriptAnalyzer | `Invoke-ScriptAnalyzer -Path ./tools -Recurse` | No | ~10 s |
| Docker suite | `pwsh -File test/run-docker-tests.ps1` | Yes | ~30 s |
| Playwright E2E | `cd app/ui && npm run test:e2e` | No | ~45 s |

### Logs

Docker test output goes to `test/test-results.md`. Playwright reports go to `app/ui/playwright-report/`. Pester JUnit XML goes to `pester-results.xml` (CI) or console output (local).

### Troubleshooting

| Problem | Solution |
|---------|----------|
| Pester "module not found" | Run `Install-Module Pester -MinimumVersion 5.0.0 -Force -Scope CurrentUser` |
| ESLint "No files matched" | Check `eslint.config.js` exists in `app/ui/` |
| Docker tests fail on SQL connection | Wait longer after `docker compose up` — SQL takes ~20 s to init |
| "No Access Token found" | Run `Get-FGAccessToken -ConfigFile config.test.json` first |
| 403 on Graph API | Check the App Registration has the right permissions + admin consent |
| Web container returns 500 | `docker logs fortigigraph-web-1 --tail 50` |
| Worker not picking up jobs | `docker logs fortigigraph-worker-1 --tail 50` — check that it discovered the API key |

---

## 13. CI/CD Pipelines

### PR Pipeline (`.github/workflows/pr.yml`)

Runs on every pull request to `main` or `dev`. No Docker, no external credentials needed. All 6 jobs run in parallel:

| Job | Tool | What it checks |
|-----|------|----------------|
| `lint-ps` | PSScriptAnalyzer | PowerShell code quality (Warnings + Errors fail the build) |
| `lint-js` | ESLint | JavaScript/JSX code quality in `app/ui/` |
| `unit-tests` | Pester v5 | Module structure, function availability, code quality; JaCoCo coverage artifact |
| `unit-js` | Vitest | API validation logic (53 test cases in `validation.test.js`) |
| `openapi` | Spectral | `app/api/src/openapi.yaml` conforms to OAS3 ruleset |
| `audit` | npm audit | No high-severity vulnerabilities in `app/ui` or `app/api` |

**Typical duration:** 3–5 minutes.

### Nightly Pipeline

The nightly suite runs locally on a dedicated test VM via Windows Task Scheduler. See `test/nightly/Register-ReviewSchedule.ps1` and `docs/operations/nightly-review.md` for setup. The legacy GitHub Actions nightly workflow has been removed in v5 — running Docker-in-Docker with PostgreSQL inside a runner was unreliable, and the local-VM approach gives the Claude review hook full access to fix-and-rerun.

### Cost Considerations

- **GitHub Actions (private repo):** 2 000 min/month free, then ~$0.008/min
- **LLM API (risk scoring):** ~$0.05–0.20 per run (2–3 calls)

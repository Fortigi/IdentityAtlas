# Documentation Gap Audit — IdentityAtlas

> **Status:** Findings report — no fixes applied. Basis for a follow-up remediation plan.
> **Date:** 2026-07-14
> **Method:** Feature surface derived from the **codebase/UI as ground truth** (not CHANGES.md or marketing), then cross-checked against every doc under `docs/`. Four parallel audits covered: crawlers/sync, the Node API layer, the React UI, and domain/engine logic. Only gaps where both the code and the doc state were verified are listed.
> **Baseline commit:** `main` @ `d4afdb9f` (v5.441).

## Verdict

The codebase is well covered by **architecture specs** under `docs/architecture/*`, but there are three kinds of gaps:

1. **Docs that are factually wrong** (actively misleading — fix first).
2. **Whole shipped features with no documentation** — concentrated around **Contexts** and the **new Matrix** model.
3. **A process gap**: design docs still say "not yet implemented / proposal / no code yet" while the feature has shipped.

There is essentially **no maintained end-user "how to use the app" documentation** — the single UI guide (`docs/ui/overview.md`) is a version or two behind the shipped UI.

---

## 🔴 Tier A — Docs that are actively WRONG (fix first)

| # | Gap | Where | Impact |
|---|-----|-------|--------|
| A1 | **Risk-tier cutoffs are wrong.** Docs say Critical ≥80 / High ≥60; code (`app/api/src/riskscoring/tiers.js`) uses **≥90 / ≥70**. `tiers.js` header even notes the code was fixed but the docs never were. | `docs/risk-scoring/overview.md`, `docs/risk-scoring/design.md` | Every risk badge is mis-described |
| A2 | **Status headers say "not yet implemented" but the feature shipped.** `context-redesign.md` + `context-redesign-ui.md` ("Design proposal — not yet implemented") and `assignment-model-redesign.md` ("Proposed — no code yet") are all live (Contexts table, plugin registry, runner, `seedAlgorithms`; migrations 044/045). | `docs/architecture/context-redesign.md`, `context-redesign-ui.md`, `assignment-model-redesign.md` | Reader believes core features don't exist |
| A3 | **Documented endpoint does not exist.** `entities.md` documents `GET /api/perf/slowest`; the real route (`routes/perf.js`) is `GET /api/perf/slow` (a 404 for the documented one). `POST /api/perf/toggle` is also omitted. Not caught by the openapi drift guard. | `docs/api/entities.md` | Documented endpoint returns 404 |
| A4 | **Plugin catalogue is inaccurate.** `context-redesign.md §4.2` lists only 5 plugins, names one wrong (`department-tree` → actual is `department-from-principal`), and lists a ghost plugin (`app-grouping-by-pattern`, never shipped). The registry has **10**. | `docs/architecture/context-redesign.md` | Wrong picture of what runs |
| A5 | **References to removed tables/tabs.** `overview.md` still describes Tagging via `GraphTags`/`GraphTagAssignments`, references the removed "Org Chart" tab and `OrgUnits`; `data-model.md` still lists the now-collapsed source assignment types as "in use". | `docs/ui/overview.md`, `docs/concepts/data-model.md` | Stale v5 / pre-v6 model |

---

## 🟠 Tier B — Whole shipped features with NO documentation (High severity)

### B1 — Contexts: the largest gap, across every layer
A primary, always-visible tab with almost no user-facing or API documentation.

- **UI**: no end-user guide for the Contexts screen (two-pane tree/list, synced/generated/manual variants, four target types, drag-to-reparent, New-Context wizard, per-tree Sync/Run, "Filter matrix"). `docs/ui/overview.md` doesn't mention Contexts at all and still lists the removed Org Chart tab.
  - Code: `app/ui/src/components/ContextsPage.jsx`, `components/contexts/*`, `hooks/useContextTrees.js`
- **API**: all **write/management** endpoints undocumented — `entities.md` shows only the 4 read endpoints.
  - `POST /contexts`, `PATCH /contexts/:id`, `POST /contexts/:id/sync`, `DELETE /contexts/:id`, `POST /contexts/:id/members`, `DELETE /contexts/:id/members/:memberId`, `PATCH …/move`
  - Code: `app/api/src/routes/contexts/crud.js`, `routes/contexts/members.js`
- **Plugins engine**: the entire `/context-plugins/*` surface (dry-run, run, trees, runs) is only in a *plan* doc, never as API reference.
  - Code: `app/api/src/routes/contextPlugins.js`

### B2 — Five shipped context plugins undocumented / mis-catalogued
`scope-hierarchy`, `resource-type-tree`, `principal-type-tree`, `entra-group-category-tree` appear in **no** doc; `risky-consent` only in passing inside an unbuilt proposal.
- Code: `app/api/src/contexts/plugins/registry.js` (10 plugins registered)

### B3 — `risky-consent` fetches an external threat feed at runtime — undocumented
Live outbound HTTP to a third-party host (`oauthsentry.github.io` OAuthSentry CSV) during plugin runs. No privacy/ops note anywhere user-facing.
- Code: `app/api/src/contexts/plugins/risky-consent/*` (`riskyAppFeed.js`, `riskyConsentRiskMap.js`)

### B4 — New Matrix model has no user guide
The 3-step Filter Wizard, saved matrices, roll-up-by-attribute (count/percent + content modes), and the orientation/rotated view are all architecture-only or undocumented. `overview.md` still describes the *old* matrix (user-limit slider, department filter pills) that no longer exists.
- Code: `app/ui/src/components/matrix/MatrixFilterWizard.jsx`, `RollupMatrixView.jsx`, `RotatedMatrixView.jsx`, `matrix/SavedMatrixFilters`

### B5 — Dashboard (the landing page) has no user doc
`docs/architecture/dashboard-trends.md` covers only the Trends architecture, not the actual landing page (cards, brain force-graph, entity counts, risk status, CTAs).
- Code: `app/ui/src/components/DashboardPage.jsx`

### B6 — Entra ID crawler: six shipped phase toggles undocumented
`docs/sync/entra-id.md`'s flags table and "What Gets Synced" diagram are stale. Missing toggles: `SyncOAuth2Grants`, `SyncAppRoles`, `SyncAppPermissions`, `SyncAppOwners`, `SyncPrincipalRelationships`, `SyncDirectoryRoles`, plus AI-agent classification.
- Code: `tools/crawlers/entra-id/Start-EntraIDCrawler.ps1`, `EntraIDCrawler.Phases.ps1`, `.AppPermissions.ps1`, `.AppOwners.ps1`, `.PrincipalRelationships.ps1`, `.Transform.ps1`

### B7 — Admin → Plugins sub-tab fully undocumented
And `overview.md` documents only 3 of the 10 actual Admin sub-tabs.
- Code: `app/ui/src/components/admin/PluginsPage.jsx`, `adminTabs.js`

---

## 🟡 Tier C — Medium gaps

- **Risk-profile / classifier-management API** (~20 endpoints) documented only narratively in `architecture/llm-and-risk-scoring.md`, absent from `docs/api/risk-scores.md`. Code: `routes/riskProfiles.js`, `routes/riskScoringRuns.js`.
- **Matrix interaction endpoints** (`POST /matrix/preview`, `/matrix/hierarchy-paths`, `/matrix/inheritance-path`, saved-filters CRUD, `/matrix/default-filter`) not in `docs/api/matrix.md`. Code: `routes/matrix/data.js`, `routes/matrix/savedFilters.js`.
- **Entity-detail secondary endpoints** absent from `entities.md`: `resources/:id/{contexts,assignments,business-roles,parent-resources}`, `user/:id/{principal-relationships,contexts,oauth2-grants}`, `identities/{:id/contexts, by-user/:userId, identity-columns}`.
- **Custom Connector (push-mode) crawler** has no user guide under `docs/sync/`; only the architecture-level `ingest-api.md`. Code: `tools/crawlers/custom-connector/`.
- **CSV supported-entity table lags shipped templates**: `Contexts.csv`, `ContextMembers.csv`, `Certifications.csv`, `ResourceRelationships.csv` not listed in `docs/sync/csv-import.md`.
- **Admin config screens** (Risk Scoring profile wizard, LLM Settings, Auth / Roles & Permissions editor, Data tab: curated import/export, history retention, danger zone) are architecture-only or undocumented.
- **Risk classifier-generation docs describe the stubbed PowerShell path** (`New-FGRiskProfile`/`New-FGRiskClassifiers`) instead of the shipped Node LLM service + bundled `universal.json`.
- **Admin crawler audit/reset** (`GET /admin/crawlers/:id/audit`, `POST /admin/crawlers/:id/reset`) + **LLM test/models/status** endpoints have no reference.
- **Azure RM `onlyEntraPrincipals` config option** missing from `docs/sync/azure-rm.md`'s config table.

---

## 🟢 Confirmed well-covered (no material gap)

Governance model, effective-access engine (P1+P2), account-linking, soft-delete, audit-history, demo-dataset, resource-assignments-identity-support, resource-cluster algorithm, midPoint crawler, Omada crawler, Azure RM (bar one config option), manifest discovery/dispatcher, ingest API, crawler wizard/plugin architecture.

**Confirmed non-issue:** there is **no Azure DevOps crawler** in code — the absent `docs/sync/azure-devops.md` is correct. (Marketing prose that names "DevOps" as a source overstates current capability.)

---

## Through-lines (for the remediation plan)

1. **Contexts + new Matrix** are the newest, most complex, and worst-documented surfaces — together the bulk of the High gaps.
2. **Design docs aren't flipped to "implemented" after shipping** (A2) — a process gap, not just content.
3. **End-user documentation is structurally missing**; everything leans on architecture specs. `docs/ui/overview.md` is the only real UI guide and is outdated.
4. **`openapi.drift.test.js` guards only** the ingest/crawler/effective-access surface — every read-API gap above falls outside that guard and must be maintained by hand in `docs/api/`.

## Suggested remediation order (to be turned into a plan)

1. **Tier A** — small, targeted edits; kills the actively-misleading docs (risk tiers, status headers, perf endpoint, plugin catalogue, stale table refs).
2. **B1/B2/B3** — Contexts: one end-user guide + API reference for writes + `/context-plugins/*`, full plugin catalogue, and a privacy/ops note on `risky-consent` egress.
3. **B4/B5/B7 + overview refresh** — rewrite `docs/ui/overview.md` to the shipped v6 UI (Dashboard, Contexts, Matrix wizard/roll-up, all 10 Admin sub-tabs).
4. **B6** — refresh the Entra crawler sync doc (phase toggles + diagram).
5. **Tier C** — API reference fill-ins and the remaining crawler/admin doc gaps.

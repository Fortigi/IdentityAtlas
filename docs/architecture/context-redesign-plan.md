# Context Redesign — Build Plan

> **Status:** Phased plan for realising the design in [context-redesign.md](context-redesign.md) and [context-redesign-ui.md](context-redesign-ui.md).
> **Scope:** Greenfield v6. No migration from v5. No feature flag.

Each phase is a separate PR. Phases are listed in recommended order; parallelisable work is called out. Every phase must end in a buildable, tested, end-to-end-working Docker stack — partial features ship disabled rather than broken.

---

## Phase 1 — Schema & core API foundations

Goal: the new data model exists and is reachable over HTTP. No UI yet.

- [ ] Write migration `app/api/src/db/migrations/0XX_context_redesign.sql`
    - [ ] Drop legacy tables: `Contexts` (old shape), `OrgUnits`, `GraphResourceClusters`, `GraphResourceClusterMembers`, `GraphTags`, `GraphTagAssignments`
    - [ ] Drop column `Identities.contextId`
    - [ ] Create `Contexts`, `ContextMembers`, `ContextAlgorithms`, `ContextAlgorithmRuns` per [data model](context-redesign.md#33-schema)
    - [ ] Indexes on `parentContextId`, `targetType`, `variant`, `scopeSystemId`, and the `(scopeSystemId, externalId)` unique index
    - [ ] History trigger on `Contexts` (match the existing `_history` pattern)
- [ ] `app/api/src/routes/contexts.js` — replace existing routes
    - [ ] `GET /api/contexts` — list roots with `targetType`, `variant`, `scopeSystemId`, counts
    - [ ] `GET /api/contexts/tree?root=<id>` — subtree for one root
    - [ ] `GET /api/contexts/:id` — detail + direct members + sub-contexts
    - [ ] `GET /api/contexts/:id/members?limit&offset&search` — paginated members
    - [ ] `POST /api/contexts` — create manual context (variant=manual enforced)
    - [ ] `PATCH /api/contexts/:id` — update display name, description, parent, owner (manual only)
    - [ ] `DELETE /api/contexts/:id` — delete manual context + cascade members
    - [ ] `POST /api/contexts/:id/members` — add member (manual only; type-checked against `targetType`)
    - [ ] `DELETE /api/contexts/:id/members/:memberId` — remove member (manual only)
- [ ] `app/api/src/routes/ingest.js` — rewrite `/api/ingest/contexts`
    - [ ] Accepts `records` with `externalId`, `displayName`, `parentExternalId`, `variant`, `targetType`, `contextType`, `scopeSystemId`
    - [ ] Accepts separate `members` array: `{ contextExternalId, memberExternalId, memberType }`
    - [ ] syncMode: full (delete-then-insert by `scopeSystemId`) or delta
- [ ] Remove dead routes: `/api/org-chart/*` (kept temporarily as a thin wrapper — see Phase 6) and `/api/risk-scores/clusters/*` (kept temporarily as a thin wrapper — see Phase 7)
- [ ] Integration tests covering CRUD + membership + hierarchy queries (recursive CTE for `include children`)

**Blocks:** everything else.

---

## Phase 2 — Crawler integration

Goal: crawlers ingest into the new shape. No more derivations in crawler code.

- [ ] CSV crawler (`tools/crawlers/csv/Start-CSVCrawler.ps1`)
    - [ ] Extend `Contexts.csv` schema: columns `ExternalId`, `DisplayName`, `ContextType`, `TargetType`, `ParentExternalId`, `SystemName`, `ExtendedAttributes`
    - [ ] Add optional `ContextMembers.csv`: `ContextExternalId`, `MemberExternalId`, `MemberType`
    - [ ] POST both to `/api/ingest/contexts` in one call
    - [ ] Drop the `refresh-contexts` derive-from-`Principals.department` call — obsolete
- [ ] Entra crawler (`tools/crawlers/entra-id/Start-EntraIDCrawler.ps1`)
    - [ ] **Remove** any code that builds an org-chart tree or writes to `Contexts` / `OrgUnits`. The crawler only syncs raw Principals incl. `managerId` and `department`.
- [ ] Update CSV template `tools/csv-templates/schema/Contexts.csv` + add `ContextMembers.csv`

**Dependencies:** Phase 1.
**Parallelisable with:** Phase 3, Phase 4.

---

## Phase 3 — Plugin framework

Goal: the server can run registered algorithms that produce context trees.

- [ ] Framework scaffolding (`app/api/src/contexts/plugins/`)
    - [ ] `registry.js` — static registry mapping plugin name → module
    - [ ] `runner.js` — executes a plugin run, reconciles output with existing `Contexts` / `ContextMembers` (insert/update/delete by `sourceAlgorithmId` + `scopeSystemId`), preserves manual children
    - [ ] `types.js` — plugin contract (see backend §4.1)
- [ ] API routes `app/api/src/routes/contextPlugins.js`
    - [ ] `GET /api/context-plugins` — list registered plugins (from `ContextAlgorithms` table synced from registry at startup)
    - [ ] `POST /api/context-plugins/:name/dry-run` — returns counts and a preview sample (does not write)
    - [ ] `POST /api/context-plugins/:name/run` — queues a run, returns run id
    - [ ] `GET /api/context-plugins/runs` — recent runs (optionally filtered by plugin or system)
    - [ ] `GET /api/context-plugins/runs/:id` — status + counts
- [ ] Background runner: reuse the existing risk-scoring job pattern (in-process, not a separate worker)
- [ ] First plugin: `manager-hierarchy` (target=Identity)
    - [ ] Parameters: `scopeSystemId` (required)
    - [ ] Reads `Principals.managerId`, builds tree rooted at managers-with-no-manager, links identities as members
- [ ] Second plugin: `department-tree` (target=Identity)
    - [ ] Parameters: `scopeSystemId` (required), `separator` (default `/`), `rootName`
    - [ ] Parses `Principals.department` into nested contexts
- [ ] Seed `ContextAlgorithms` rows at container startup for the two plugins

**Dependencies:** Phase 1.
**Parallelisable with:** Phase 2, Phase 4.

---

## Phase 4 — UI foundations

Goal: Contexts tab exists; analysts can see what's in the database.

- [ ] `app/ui/src/App.jsx` — register `Contexts` tab + `#context:<id>` deep-link route
- [ ] `app/ui/src/components/ContextsPage.jsx` — two-pane layout
- [ ] `app/ui/src/components/contexts/ContextTreeSelector.jsx` — grouped list of roots with variant/target/system visual signals (see UI doc §1.1–1.2)
- [ ] `app/ui/src/components/contexts/ContextTreeView.jsx` — tree view of selected root
- [ ] `app/ui/src/components/contexts/ContextListView.jsx` — flat list view
- [ ] `app/ui/src/components/ContextDetailPage.jsx` — detail tab (replaces the current minimal one; see UI doc §5)
- [ ] Shared helpers:
    - [ ] `app/ui/src/utils/contextStyles.js` — variant border colors, target badge classes
    - [ ] `app/ui/src/hooks/useContextTree.js` — fetch + caching
- [ ] Virtualised tree rendering for large trees (AD OU with 10k+ nodes) via `@tanstack/react-virtual`
- [ ] Right-click / "⋯" menu on nodes — populated but actions (except "View detail" and "Filter matrix by this") are stubbed until Phase 5

**Dependencies:** Phase 1. Can start against mock data before Phase 2/3 land real content.
**Parallelisable with:** Phase 2, Phase 3.

---

## Phase 5 — Authoring contexts from the UI

Goal: analysts can create manual trees and trigger plugin runs.

- [ ] `app/ui/src/components/contexts/NewContextModal.jsx` — dispatcher
- [ ] `app/ui/src/components/contexts/CreateManualTreeModal.jsx`
    - [ ] Target type picker → context type free-text → name/description → optional `scopeSystemId`
    - [ ] Lands on new root's detail page
- [ ] `app/ui/src/components/contexts/RunPluginModal.jsx`
    - [ ] Plugin picker grouped by target type
    - [ ] Parameter form generated from `parametersSchema` (reuse or introduce a small JSON-Schema-to-form helper)
    - [ ] Dry-run → preview counts → confirm → run → jump to run-detail
- [ ] `app/ui/src/components/contexts/RunDetailPage.jsx` — progress + log for an in-flight or completed run
- [ ] Manual member editing on detail page:
    - [ ] Search-and-add picker (typeahead across the correct entity type)
    - [ ] Remove member button per row
    - [ ] Optional: drag-drop from a side panel
- [ ] Manual context editing:
    - [ ] "Set parent" action — picker restricted to same `targetType` trees
    - [ ] "Set owner" action — typeahead over analyst accounts
    - [ ] Inline name/description edit
- [ ] Delete manual context — confirmation modal covers cascade on members and manual sub-contexts

**Dependencies:** Phase 3 (for plugin run), Phase 4 (for hosting UI).

---

## Phase 6 — Matrix filtering by context

Goal: the Matrix gains a first-class context filter with include/exclude-children.

- [ ] `app/ui/src/components/matrix/ContextFilterControl.jsx` — chip widget (see UI doc §6)
- [ ] Extend `app/ui/src/hooks/usePermissions.js` to accept `contextFilters: [{ id, includeChildren }]` and pass to the API
- [ ] Embed `ContextFilterControl` in `MatrixToolbar.jsx`
- [ ] Backend: extend `/api/permissions` (or equivalent matrix endpoint) to accept `contextFilters`
    - [ ] Identity/Principal targets → join to `ContextMembers` on rows
    - [ ] Resource/System targets → join to `ContextMembers` on columns (System filter resolves members → `systemId` set → resource filter)
    - [ ] `includeChildren=true` → recursive CTE on `parentContextId`
    - [ ] Multiple filters AND together
- [ ] Deprecate `/api/org-chart/*` — replace with a thin wrapper that reads the `manager-hierarchy` generated tree for backward compatibility during the v6 release, then drops in Phase 9

**Dependencies:** Phase 3 (for the tree to filter on), Phase 4 (to pick contexts).

---

## Phase 7 — Replace Risk-Scoring Clusters

Goal: delete the standalone Clusters page and feature; everything it did is now a Resource-targeted generated context.

- [ ] New plugin `llm-resource-cluster` (target=Resource)
    - [ ] Parameters: `scopeSystemId` (optional — if null, runs across all systems), `llmProviderId`, cluster count / threshold params
    - [ ] Port the existing LLM clustering logic from `app/api/src/riskscoring/engine.js`
- [ ] Delete `app/api/src/routes/clusters.js` and the `Cluster` tables are already gone in Phase 1
- [ ] Delete `app/ui/src/components/RiskScoringPage.jsx` cluster sections; add a "View clusters →" link that opens Contexts pre-filtered to `contextType=ResourceCluster`
- [ ] Cluster owner data: `ownerUserId` column on `Contexts` already handles this — ensure the run-plugin flow preserves it (the plugin runner already does)

**Dependencies:** Phase 3 (framework), Phase 4 + 5 (so users can run the plugin from the UI).

---

## Phase 8 — Tags as contexts

Goal: tag UX is unchanged; underlying storage is unified.

- [ ] Creating a tag → create a row in `Contexts` (`variant='manual'`, `contextType='Tag'`, `targetType=<entity type>`, `extendedAttributes.tagColor`)
- [ ] Assign/unassign → `ContextMembers` insert/delete
- [ ] Filter by tag on list pages → joins to `ContextMembers`
- [ ] Legacy tag routes (`/api/tags/*`) updated to operate on the new storage; signatures unchanged so the UI tag chip components need no change
- [ ] Contexts tab "Tags" group shows all tag-contexts flat
- [ ] Manual context detail page handles `contextType='Tag'` gracefully — shows the color, allows setting parent and owner as with any manual context

**Dependencies:** Phase 1 (schema), Phase 4 (detail page). Can run in parallel with Phase 5, 6, 7.

---

## Phase 9 — Additional plugins

Parallelisable. Each is a small PR.

- [ ] `ad-ou-from-dn` (target=Identity) — parses `Principals.distinguishedName` into an OU tree
- [ ] `app-grouping-by-pattern` (target=Resource) — regex/prefix over `Resources.displayName`
- [ ] `business-process-llm` (target=Resource) — LLM seeded with a process description; produces a cluster per process

**Dependencies:** Phase 3.

---

## Phase 10 — Cleanup

- [ ] Remove the thin `/api/org-chart/*` wrapper from Phase 6 once the UI no longer calls it
- [ ] Remove `OrgChartPage.jsx`
- [ ] Remove any remaining references to `GraphResourceClusters`, `OrgUnits`, `Identities.contextId` in code comments, docs, and sample scripts
- [ ] Update `CLAUDE.md` sections §4 (Major Features), §6 (UI features), §8 (Universal Data Model) to reflect the final state

---

## Phase 11 — Follow-up: Export / import of manual data

Not part of v6 cut; first follow-up.

- [ ] Extend existing "export tags" flow to export all `variant='manual'` contexts and their members
- [ ] JSON artifact includes: contexts (incl. tag-contexts), members, parent relationships, owners, external ids
- [ ] Import: additive by default; "replace" mode wipes existing manual data first
- [ ] UI: "Export / Import" button on the Contexts tab header

**Dependencies:** Phase 8.

---

## Dependency graph (short)

```
Phase 1 ─┬─► Phase 2
         ├─► Phase 3 ─┬─► Phase 7
         │            ├─► Phase 9
         │            └─► Phase 5 ─► Phase 6
         └─► Phase 4 ─┘
Phase 4 ───► Phase 8 ─► Phase 11
Phase 6, 7, 8 ─► Phase 10 (cleanup)
```

Critical path to a demoable redesign: **1 → 3 → 4 → 5 → 6**. Everything else can slot in after 6 is green.

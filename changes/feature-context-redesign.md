## Context redesign (v6) — unified Contexts model + plugin framework + UI rewrite

### Data model & schema

- **Breaking (v6):** Replaced the old single-purpose `Contexts` table with a unified model: three variants (`synced` / `generated` / `manual`) and four target types (`Identity` / `Resource` / `Principal` / `System`). Membership lives in a new `ContextMembers` table. The legacy `Identities.contextId`, `Principals.contextId`, and `Resources.contextId` columns are removed; a principal can now belong to many contexts.
- New tables: `Contexts` (rewritten), `ContextMembers`, `ContextAlgorithms`, `ContextAlgorithmRuns`. The `_history` audit trigger is wired onto `Contexts`.
- Migration `019` drops the legacy `GraphResourceClusters` / `GraphResourceClusterMembers` tables (clustering is now a plugin).
- Migration `020` drops `GraphTags` / `GraphTagAssignments` and replaces them with **VIEWS** over `Contexts` + `ContextMembers`. Existing tag-JOIN queries (in `permissions.js`, `resources.js`, `details.js`) keep working unchanged. Tag IDs are now UUIDs; the UI treats them as opaque strings so no frontend change was needed.
- Migration `021` re-keys the `ix_Contexts_externalId` unique index from `(scopeSystemId, externalId)` to `(sourceAlgorithmId, scopeSystemId, externalId)` so different plugins can use the same `externalId='root'` on the same system without colliding.

### Backend — context API surface

- Rewrote `/api/contexts` routes from scratch: list / tree / detail / paginated members, plus full CRUD for non-synced contexts. `DELETE` allows manual + generated; synced is rejected. `POST/DELETE /:id/members` accept analyst writes on both manual and generated contexts (the plugin runner preserves `addedBy='analyst'` rows across re-runs).
- `GET /api/contexts/:id/members?include=descendants` walks `parentContextId` recursively and returns `DISTINCT ON (memberId)` so a subtree's members are visible in one paginated list.
- `GET /api/contexts` and `/api/contexts/tree` sort by `totalMemberCount DESC, displayName ASC` so big subtrees bubble up.
- `recalcMemberCountsForChain(id)` helper in `contexts/memberCounts.js` keeps `directMemberCount` and `totalMemberCount` accurate after every analyst write. Wired into the five paths that mutate `ContextMembers`: contexts member POST/DELETE and three tags routes (assign / unassign / assign-by-filter).
- `/api/contexts/:id` adds `contextCount` to the user/resource/identity detail responses and exposes `/api/<entity>/:id/contexts` lazy-load endpoints — the entity-detail graph uses these to populate the new "Contexts" fanout.

### Plugin framework (generated contexts)

- **Plugin contract** in `app/api/src/contexts/plugins/`: registry, runner, types. Plugins are in-tree Node modules; registered plugins seed into `ContextAlgorithms` at startup.
- **Runner** does a **two-pass FK-safe upsert** (insert with `parentContextId=NULL` first, then `UPDATE` parent links) so plugins can emit nodes in arbitrary order without hitting the parent-FK constraint.
- After every run, the runner rolls up `totalMemberCount` over the produced subtrees via a recursive CTE.
- **HTTP**: `GET /api/context-plugins`, `POST /api/context-plugins/:name/dry-run`, `POST /api/context-plugins/:name/run` (async, returns `runId`), `GET /api/context-plugins/runs`, `GET /api/context-plugins/runs/:id`.
- **Plugins shipped in this PR:**
  - `manager-hierarchy` — builds a tree from `Principals.managerId`. Node displayName is `"<Department> (<Name>)"` when available. Accepts `excludeNamePatterns` (regex array) so external-consultancy admin-managers (e.g. `\(Quanza\)`) can be filtered out persistently — their reports reattach to the synthetic root.
  - `ad-ou-from-dn` — parses an LDAP DN into a nested OU tree. Accepts a `dnField` parameter (default `extendedAttributes.onPremisesDistinguishedName`) resolved through a whitelisted SQL-expression helper.
  - `resource-cluster` — token-based clustering. Splits resource names on any non-alphanumeric, drops short/numeric/stopword tokens, creates one cluster per surviving token that appears in ≥`minMembers` resources. A resource can belong to multiple clusters. Tunable `minMembers` (default 4), `minTokenLength`, `maxTokenCoverage`, `additionalStopwords` for tenant-specific noise. See `docs/architecture/resource-cluster-algorithm.md`.
- **Plugins removed during the build** because they didn't carry their weight or weren't ready: `department-tree` (manager-hierarchy already shows department in displayName), `app-grouping-by-pattern` (`resource-cluster` does this better with no config), `business-process-llm` (stub — comes back when the LLM-call wiring lands).

### Matrix filtering by context

- New chip widget on the Matrix toolbar lets analysts pick one or more contexts to filter by, each with an "+sub" checkbox to include descendants. Filters AND together.
- `/api/permissions` accepts a `contextFilters` JSON query param. The `contexts/contextFilters.js` helper compiles the filter into SQL fragments using a recursive CTE on `parentContextId`. Identity/Principal-targeted filters constrain the row axis; Resource and System targets constrain the column axis.
- Filter selections live in the matrix hash so filtered views can be bookmarked.

### Tags as Contexts

- Tags become a specialisation of manual Contexts (`contextType='Tag'`). The UI contract is unchanged.
- `bootstrap.js#ensureTagRoots()` runs at every container start and creates one synthetic `Tags` root per `targetType` (Principal / Resource / Identity), then reparents any orphan tag rows. New tags from `POST /api/tags` attach under the appropriate root via `getOrCreateTagRoot()`.
- The matrix `__userTag` filter and the resource detail tag chips keep working unchanged through the `GraphTags` / `GraphTagAssignments` views.
- Admin bulk-import of tags still targets the legacy table names — deferred to a follow-up because the admin-import path is scheduled for its own cleanup.

### Crawler integration

- CSV crawler (`tools/crawlers/csv/Start-CSVCrawler.ps1`) sends the new `Contexts.csv` / `ContextMembers.csv` shape and ingests them via the `/api/ingest/contexts` endpoint. The `/ingest/refresh-contexts` derive-from-`Principals.department` call is gone.
- Entra crawler no longer has a `Context` object type — context derivation is plugin work, not crawler work.

### UI — Contexts tab

- New **Contexts** tab with a two-pane layout: left selector grouped by `contextType (targetType)`, right pane with **Tree** or **List** view. Each tree node is a rounded pill with a ringed variant-colored bubble; L-shaped connector lines show the hierarchy.
- Tree + selector show **`<direct> · <total>`** member counts when a subtree carries indirect members.
- "**+ New**" on the selector opens a three-card dispatcher: Import (jumps to Crawlers), Run plugin, Create manual.
- **RunPluginModal** — picker grouped by target type, parameter form auto-generated from each plugin's `parametersSchema` (with `scopeSystemId` rendered as a system picker and array/object params editable as JSON), Dry-run preview with counts + samples, Run that queues async + opens RunDetailPage.
- **RunDetailPage** polls `/api/context-plugins/runs/:id` every 1s until terminal; shows status, reconciliation counts, parameters, and any error.
- **ManualContextEditor** — rename, set parent, set owner, edit description, delete-with-confirm. Parent picker is the new shared **ContextPicker** modal (tree + list views, search with auto-expand on match, exclude self+descendants).
- **ContextMemberPicker** — debounced typeahead hitting `/api/identities`, `/api/resources`, `/api/users`, `/api/systems` based on `targetType`. Members are addable on both manual and generated contexts; per-row Remove on each. Remove buttons on algorithm-added rows say "Remove (will return)" so the analyst knows tuning plugin parameters is needed for a persistent removal.
- **GeneratedContextActions** panel for generated contexts — Delete-with-confirm + caveat that re-running the plugin will recreate the row unless parameters change.
- **Tree-delete** button on the right-pane header lets the analyst nuke an entire tree (root + descendants + members) without drilling in.

### UI — entity detail rework

- Detail pages (User / Resource / Identity / Access Package) use a shared two-column layout: **AttributesTable** on the left (real columns + `extendedAttributes` merged), **EntityGraph** on the right.
- AttributesTable uses `table-fixed` with a 40/60 colgroup so long extension-attribute labels wrap rather than squeezing the value column. No internal scroll — the panel grows to its natural height.
- **EntityGraph** is pannable via pointer drag and zoomable via wheel (clamped 0.4× – 3×). A "Reset view" button overlays the top-right when the user has moved away from default. `touch-action: none` so trackpad/touch swipes pan instead of scrolling the page.
- The graph's "Contexts" fanout uses the new `contextCount` + `/contexts` endpoints — clicking it shows every context the entity belongs to and drilling in opens that context's detail page.

### Risk Scoring page changes

- Cluster sections retired. Default view is "Users". A "View clusters →" link jumps to the Contexts tab. The `/api/risk-scores/clusters*` routes are removed; clustering lives in the `resource-cluster` plugin.

### Bootstrap / quickstart fixes

- `BEHIND_TLS=true` opt-in for HSTS + CSP `upgrade-insecure-requests`. The default `http://host:3001` quickstart no longer traps browsers into HTTPS-only for a year.
- `/api/users` was returning 500 because it still SELECT'd the dropped `u."contextId"` column. Fixed.

### Tests

- 8 new vitest test files, **216 tests total** (was 175 before this branch):
  - `contexts/contextFilters.test.js` — 13 tests for the matrix-filter SQL helper
  - `contexts/memberCounts.test.js` — 5 tests for the count-refresher (walk-up, direct/total updates, cycle safety)
  - `contexts/plugins/manager-hierarchy.test.js` — 10 tests covering the algorithm + `excludeNamePatterns`
  - `contexts/plugins/ad-ou-from-dn.test.js` — 10 tests including injection guards on `dnField`
  - `contexts/plugins/resource-cluster/tokenize.test.js` — 16 tests for the tokenizer + stopwords
  - `contexts/plugins/resource-cluster/index.test.js` — 10 integration tests for the plugin's `run()` against a mocked db
  - `bootstrap.tagRoots.test.js` — 3 tests for `getOrCreateTagRoot`

### Cleanup

- Removed `OrgChartPage.jsx` and the `Org Chart` tab. A minimal `/api/org-chart` adapter remains (3 endpoints: manager / reports / availability) to keep the entity-detail graph and the Department detail page working until those callers are rewritten to read from the manager-hierarchy plugin tree directly.

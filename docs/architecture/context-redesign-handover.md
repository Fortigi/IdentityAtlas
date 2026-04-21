# Context Redesign — Handover

> **Status snapshot at handover:** Phases 1–4 complete and committed. Phase 5 started (one file). Phases 6–9 pending. Nothing has been tested against a running Docker stack yet — the box we built on had no local Docker. Delete this file once you've picked up and are rolling.

## Branch & recent commits

```
feature/context-redesign
  40ee054  Phase 5 (WIP) — CreateManualTreeModal component
  6fe906f  Phase 4 — Contexts UI foundations
  82af2f6  Phase 3 — context-algorithm plugin framework + two initial plugins
  2c049fd  Phase 2 — crawler integration for v6 contexts
  352205c  Phase 1 — context redesign schema + core API
  c4e95a9  context redesign docs
```

Working tree was clean at handover. Push the branch if you haven't already:

```bash
git push -u origin feature/context-redesign
```

## Docs (read first, in this order)

1. [context-redesign.md](context-redesign.md) — data model, variants, target types, plugin framework
2. [context-redesign-ui.md](context-redesign-ui.md) — UI layout, visual language, multi-tree handling
3. [context-redesign-plan.md](context-redesign-plan.md) — **the 11-phase build plan; the source of truth for what's left**

## First thing to do on the new box

Bring the stack up and confirm the migration applies cleanly:

```bash
git fetch && git checkout feature/context-redesign && git pull
docker compose build web && docker compose up -d
docker compose logs -f web      # watch for "Migrations: complete (18 total)" and "Context-algorithm registry: 2 plugin(s) seeded"
```

Then smoke-test Phase 1 + Phase 3 directly (no UI needed yet):

```bash
# The Contexts tab should appear in the top nav and load an empty list.
open http://localhost:3001

# Plugin registry should show manager-hierarchy + department-tree.
curl -s -H "Authorization: Bearer <your-session-cookie-or-apikey>" \
     http://localhost:3001/api/context-plugins | jq

# Create a manual context.
curl -s -X POST http://localhost:3001/api/contexts \
     -H "Authorization: Bearer ..." -H "Content-Type: application/json" \
     -d '{"targetType":"Resource","contextType":"Application","displayName":"Procurement app"}'

# Dry-run the manager-hierarchy plugin. Pick a real scopeSystemId from /api/systems.
curl -s -X POST http://localhost:3001/api/context-plugins/manager-hierarchy/dry-run \
     -H "Authorization: Bearer ..." -H "Content-Type: application/json" \
     -d '{"scopeSystemId": 1}'
```

If any of those fail, fix the bug before moving on — I wrote them without running them.

## What's done (phases 1–4)

**Phase 1** — `app/api/src/db/migrations/018_context_redesign.sql` drops the old `Contexts` table and the `Identities.contextId` / `Principals.contextId` / `Resources.contextId` columns; creates `Contexts` (new shape), `ContextMembers`, `ContextAlgorithms`, `ContextAlgorithmRuns`. Rewrote [contexts.js](../../app/api/src/routes/contexts.js) with full CRUD. Updated [validation.js](../../app/api/src/ingest/validation.js) and [ingest.js](../../app/api/src/routes/ingest.js) for the new shape. Removed the obsolete `/api/admin/refresh-contexts` endpoint.

**Phase 2** — `tools/crawlers/csv/Start-CSVCrawler.ps1` now sends the new shape and optionally ingests `ContextMembers.csv`; the `/ingest/refresh-contexts` call is gone. Entra crawler had a useless `SyncContexts` switch — removed. `Invoke-CrawlerJob.ps1` and `CrawlersPage.jsx` no longer reference the `context` object type.

**Phase 3** — Plugin framework under [app/api/src/contexts/plugins/](../../app/api/src/contexts/plugins/): registry, runner, types, two plugins (`manager-hierarchy`, `department-tree`). [seedAlgorithms.js](../../app/api/src/contexts/seedAlgorithms.js) syncs the registry → `ContextAlgorithms` at boot. [contextPlugins.js](../../app/api/src/routes/contextPlugins.js) exposes list / dry-run / run / run-history endpoints.

**Phase 4** — Contexts tab: [ContextsPage.jsx](../../app/ui/src/components/ContextsPage.jsx) + [contexts/ContextTreeSelector.jsx](../../app/ui/src/components/contexts/ContextTreeSelector.jsx) + [contexts/ContextTreeView.jsx](../../app/ui/src/components/contexts/ContextTreeView.jsx) + [contexts/ContextListView.jsx](../../app/ui/src/components/contexts/ContextListView.jsx). [ContextDetailPage.jsx](../../app/ui/src/components/ContextDetailPage.jsx) rewritten header (variant/target/system/owner chips). Visual language helpers in [utils/contextStyles.js](../../app/ui/src/utils/contextStyles.js). Hooks in [hooks/useContextTrees.js](../../app/ui/src/hooks/useContextTrees.js).

## Phase 5 — where to pick up (in progress)

One file landed but isn't wired: [CreateManualTreeModal.jsx](../../app/ui/src/components/contexts/CreateManualTreeModal.jsx). It's a standalone wizard calling `POST /api/contexts`. Renders fine on its own but nothing opens it yet.

**Next concrete steps:**

1. **Build `RunPluginModal.jsx`** next to the manual-tree modal. Plugin picker (grouped by target type) → parameter form rendered from `parametersSchema` → "Dry run" button showing counts + samples → "Run" button calling `POST /api/context-plugins/:name/run` → navigate the user to a run-detail page showing `GET /api/context-plugins/runs/:id` polled every 1s.
2. **Build `NewContextModal.jsx`** — tiny dispatcher with three cards: "Import tree" (opens the Crawlers page, read-only hint), "Run plugin" (opens RunPluginModal), "Create manual tree" (opens CreateManualTreeModal).
3. **Wire "+ New"** — add `onNewTree` prop from `ContextsPage` → `ContextTreeSelector` → opens NewContextModal.
4. **Inline edit on detail page** — for `variant === 'manual'` contexts, add a small edit panel: rename (PATCH), set parent (picker), set owner (text input), delete (DELETE with confirm). Endpoints all exist; [contexts.js](../../app/api/src/routes/contexts.js) already enforces `variant='manual'` on all mutation routes.
5. **Member add/remove on detail page** — for manual contexts, a typeahead search over the right entity type (based on `attrs.targetType`) + a list of current members with remove buttons. Endpoints: `POST /api/contexts/:id/members` and `DELETE /api/contexts/:id/members/:memberId`. For the typeahead, reuse `/api/identities`, `/api/resources`, `/api/users`, `/api/systems` depending on `targetType`.

The UI design for all of this is spelled out in [context-redesign-ui.md](context-redesign-ui.md) §4–§5.

## Phases 6–9 — still pending

Follow [context-redesign-plan.md](context-redesign-plan.md) step-by-step. Short version:

- **Phase 6** — Matrix context filter (toolbar chip widget + recursive-CTE filter on `/api/permissions`).
- **Phase 7** — Kill the Risk-Scoring Clusters page; ship `llm-resource-cluster` plugin.
- **Phase 8** — Tags become manual flat contexts; existing tag UI unchanged. Rewrite `/api/tags/*` against `Contexts` / `ContextMembers`.
- **Phase 9** — Additional plugins: `ad-ou-from-dn`, `app-grouping-by-pattern`, `business-process-llm`.
- **Phase 10** — Cleanup: remove `OrgChartPage`, the thin org-chart wrapper, stale comments.

## Known risks / things I didn't test

- **The migration drops three columns.** I grepped for references and cleaned `identities.js` + `resources.js`. Something downstream might still read `Identities.contextId` — check `_history`-based detail pages and any view definitions I missed. If a view references a dropped column, Postgres will error at CREATE time, not migration time.
- **`loadMembers` does `m.id::text = cm."memberId"::text`** in [contexts.js:394](../../app/api/src/routes/contexts.js). That's a safety net because `Systems.id` is `INT`; remove the cast (and add a UUID-typed members path) once you confirm the flow.
- **Plugin reconciler cycle protection** — `runner.js` preserves manual children, but I didn't test what happens when a plugin re-run produces a shallower tree than before. Should be fine (deleting a middle layer cascades), but verify.
- **Parent resolution in ingest is not implemented.** If a CSV sends `parentExternalId`, the normalizer doesn't resolve it to `parentContextId`. The CSV crawler handles this by ordering records topologically and resolving client-side — works for Contexts but `ContextMembers` ingest with `contextExternalId`/`memberExternalId` won't auto-resolve today. Either extend normalization or change the crawler to resolve before POSTing. I noted this in the design doc but didn't fix it.
- **LF/CRLF** — everything committed has the CRLF warning. Should be harmless (git is configured for autocrlf) but worth noting if something behaves oddly on Linux.

## When you continue

Update the todo list at the top of whatever chat tool you resume in so the phase tracking picks up cleanly. Then `/loop`-style: pick the next item from the plan, build, commit, repeat. The changelog fragment at [changes/feature-context-redesign.md](../../changes/feature-context-redesign.md) already has bullets for phases 1–4; append as you finish each remaining phase.

When Phase 9 or 10 lands, delete this handover file in the same commit.

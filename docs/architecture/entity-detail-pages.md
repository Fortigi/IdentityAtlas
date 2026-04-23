# Entity Detail Pages

Every user, resource, identity, and business role in Identity Atlas has a
"detail tab" that opens as a closable tab alongside the list pages. This doc
describes how those tabs are built — the layout, the interactive graph, the
recent-changes timeline, and the shape helper that keeps all four entity
kinds consistent.

---

## Layout

All four detail pages use the same three-region layout ([EntityDetailLayout.jsx](../../app/ui/src/components/EntityDetailLayout.jsx)):

```
┌───────────────────────────────────────────────┐
│ Header (avatar, name, badges, tags, close)    │
├─────────────────────┬─────────────────────────┤
│ Attributes table    │ Entity graph            │
│ (left — merged      │ (right — clickable,     │
│  real +             │  fans out on click)     │
│  extendedAttributes)│                         │
│                     │ Expanded items list     │
│                     │ (below graph —          │
│                     │  drill list + links)    │
├─────────────────────┴─────────────────────────┤
│ Risk Score Section                             │
│ Identity Membership banner (user only)         │
│ Recent Changes timeline                        │
│ Version History (collapsible)                  │
└───────────────────────────────────────────────┘
```

The left column's [AttributesTable](../../app/ui/src/components/EntityDetailLayout.jsx) merges the entity's real columns and its `extendedAttributes` JSONB into one `label | value` table. JSON-derived rows carry a faded `ext` tag so readers can still tell them apart.

---

## The entity graph

### Root ring

Each entity kind has a first ring of relationship categories:

| Kind | Nodes |
|------|-------|
| **User** | Manager · Direct Reports · Context · Groups (Direct) · Groups (Indirect) · Groups Owned · Eligible · Access Packages · OAuth2 Grants · Identity |
| **Resource** | Direct Members · Governed · Owners · Eligible · Business Roles · Member Of · Context |
| **Access Package** | Assignments · Resources · Policies · Reviews · Pending Requests · Catalog |
| **Identity** | Linked Accounts · Context · Groups (Direct) · Governed · Owned · Eligible · OAuth2 Grants |

All nodes share the dashboard's lime/green palette. Node radius scales with count on a log curve so a 3-member group and a 30,000-member group both stay readable.

### Recent-change nodes

If the entity's `/recent-changes` endpoint returns non-zero counts, two pseudo-categories are prepended to the root ring:

- **Recently Added** — rendered with an amber gradient (`#fef9c3 → #ca8a04`)
- **Recently Removed** — rendered with a rose gradient (`#ffe4e6 → #e11d48`)

Clicking either expands to the counterparties involved, drawn in the same tint. Within regular category fanouts (e.g. Groups (Direct)), individual items whose `counterpartyId` is in the recently-added set also render with the amber tint so they stand out inside their current-state context.

### Fanout (drill-in)

Clicking any category node **fans its list items out as satellite nodes** around it. Clicking an item (a user / resource / access package / identity / context) fetches *that* entity's core payload and fans out **its** relationship categories as a further ring. This repeats; depth is unlimited in code, but the arc geometry and node-radius step shrink each level so 3–4 hops stay legible.

- **Click the same node again** → collapses back to before that node.
- **Click "collapse"** under the graph → drops the whole chain.
- **Click a different root-ring node** → replaces the whole expansion chain with a new branch.

The list below the graph mirrors the deepest category step on the expansion chain — so after `Access Packages → BR-Employee-Base → Resources`, the list shows the AP's resources with clickable links.

Large fanouts cap at 10 satellites; overflow becomes a `+N more` bubble.

### Architecture

Three files own the model:

- [entityGraphShape.js](../../app/ui/src/components/entityGraphShape.js) — the single source of truth. Exports `getRootNodes(kind, core, extras)` and `fetchCategoryItems(kind, id, categoryKey, authFetch, extras)`. Adding a new entity kind is a single switch-case addition plus its fetch helpers.
- [useExpandableGraph.js](../../app/ui/src/hooks/useExpandableGraph.js) — React hook. Owns the expansion path (a stack of alternating category/item steps), fetches on click, handles collapse/replace.
- [EntityGraph.jsx](../../app/ui/src/components/EntityGraph.jsx) — dumb SVG renderer. Takes a node tree and the expansion path, recursively lays out each fanout on an arc pointing outward from its parent. The viewBox grows with drill depth to stop deep chains running off canvas.

### Styling signals

| Node state | Visual |
|------------|--------|
| Dimmed (count = 0) | Light green fill, dashed edge to center, no animation |
| Active category | Bright lime gradient, pulsing halo |
| Selected (active click) | Lime outer ring |
| On expansion path | Bold lime edge, slightly brighter halo |
| Recently-added | Amber gradient, amber halo |
| Recently-removed | Rose gradient, rose halo |
| Item node (satellite) | Initial-letter badge inside the circle |

---

## Recent Changes timeline

### What it captures

The Recent Changes section on each detail page is backed by the `_history` audit table ([audit-history.md](audit-history.md)). It surfaces **relationship-level** changes only — the things most likely to explain a "why do I have this permission / why did I lose it" support call:

| Entity | Events shown |
|--------|--------------|
| **User** | Assignment added / removed, manager changed, linked-identity change |
| **Resource** | Member granted / revoked, added to / removed from a parent resource |
| **Access Package** | Governed assignment granted / revoked, resource added to / removed from the role |
| **Identity** | Linked account added / removed |

Attribute-level churn (displayName spelling, jobTitle updates) stays in the Version History section — Recent Changes is specifically the "did this user's permissions change" surface.

### Endpoint shape

```
GET /api/<kind>/:id/recent-changes?sinceDays=30&limit=50

{
  "sinceDays": 30,
  "addedCount":   3,
  "removedCount": 1,
  "events": [
    {
      "at": "2026-04-23T09:12:04Z",
      "operation": "added",             // 'added' | 'removed' | 'changed'
      "eventKind": "assignment",        // 'assignment' | 'relationship' | 'manager' | 'identity-member'
      "summary":   "Added to SG-AllEmployees (Direct)",
      "counterpartyKind":  "resource",  // which detail tab to open on click
      "counterpartyId":    "…",
      "counterpartyLabel": "SG-AllEmployees"
    }
  ]
}
```

Each event's `counterpartyLabel` is resolved at query time against current state (Principals / Resources / Identities). If the counterparty has since been deleted, the label falls back to the history snapshot.

### Graph integration

The `useRecentChanges` hook surfaces `addedCount`, `removedCount`, and an `addedIds` Set. Those become part of `rootExtras` for the graph, which is why the "Recently Added" and "Recently Removed" nodes appear conditionally and items inside other fanouts can be tagged fresh.

### Important caveats

- **Composite-key tables only log changes after migration 018** (April 2026). For rows ingested before 018, the history is silent. A fresh crawler run or manual change generates events from that point forward.
- **Recent Changes is a read-only surface.** Every event is derived from `_history`; nothing writes extra rows.
- **Deleted counterparties are still shown** — by label from the snapshot — so a "Removed from BR-Employee-Base" event still reads correctly even if the business role was later deleted.

---

## Adding a new entity kind

To give a new entity kind its own detail page with the graph + recent-changes treatment:

1. **Backend**
   - Expose a core detail endpoint that returns attributes, tags, and the counts you want shown as graph nodes.
   - Expose a list endpoint for each relationship category (or extend an existing one).
   - Add a `/:id/recent-changes` handler — follow the pattern in [recentChanges.js](../../app/api/src/routes/recentChanges.js). Decide which `_history` tables are relevant and how to summarise each operation type into human-readable text.

2. **Frontend**
   - In [entityGraphShape.js](../../app/ui/src/components/entityGraphShape.js):
     - Add `<kind>RootNodes(core)` returning the first-ring node spec.
     - Add `fetch<Kind>Items(id, categoryKey, authFetch, extras)` returning item arrays for each category.
     - Wire both into the top-level `getRootNodes` / `fetchCategoryItems` switch statements.
     - Add an entry to `fetchEntityCore` so drill-in from another page can pick up the kind.
   - In [useRecentChanges.js](../../app/ui/src/hooks/useRecentChanges.js): add the endpoint URL for the new kind.
   - Create a `<Kind>DetailPage.jsx` following the pattern of the existing four. It mostly just fetches the core payload, calls `useExpandableGraph` + `useRecentChanges`, and renders `EntityDetailLayout`.

3. **Routing** — add the hash-route handler in [App.jsx](../../app/ui/src/App.jsx) so `onOpenDetail('<kind>', id, label)` opens your new page.

The shared `EntityGraph`, `ExpandedItemsList`, `RecentChangesSection`, `EntityDetailLayout`, and `AttributesTable` components require no changes.

---

## Related docs

- [audit-history.md](audit-history.md) — how `_history` is populated and queried.
- [postgres-migration.md](postgres-migration.md) — context on the v4→v5 switch that replaced temporal tables with `_history`.

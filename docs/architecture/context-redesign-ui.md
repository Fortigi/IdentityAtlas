# Context Redesign — UI

> **Status:** Design proposal — not yet implemented.
> **Companion doc:** [context-redesign.md](context-redesign.md) for the data model and backend.

## 1. New Top-Level Tab: "Contexts"

A new primary tab sits alongside Users, Resources, Systems, etc. It replaces the role the OrgChart tab plays today and subsumes the Risk-Scoring → Clusters page.

The tab has two panes:

- **Left: tree selector.** Lists every root context. Grouped by contextType. Each entry shows the tree's display name plus three visual signals: variant (border color), target type (badge), and system (subtle chip). Selector is collapsible per group.
- **Right: the selected tree** — switchable between tree view and list view, with a header card summarising provenance.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Contexts                                                         [+ New] │
├───────────────────────────────┬──────────────────────────────────────────┤
│ Trees                         │ Header: name • variant • target type    │
│                               │        • system • members • owner       │
│ ▾ OrgUnit (Identity)    5     │        [Run now] [Edit] [Filter matrix] │
│   🔵 Workday      [Workday]   ├──────────────────────────────────────────┤
│   🔵 SuccessFact. [SAP HR]    │ [Tree] [List]          Filters ▾        │
│   🟢 Manager hrc. [Entra P.]  │                                          │
│   🟢 Manager hrc. [Entra D.]  │   Finance                                │
│   🟫 Finance sub-teams        │   ├─ Treasury                            │
│                               │   │   └─ 🟫 Treasury automation          │
│ ▾ AD-OU (Identity)      2     │   └─ Accounts payable                    │
│   🟢 Prod Forest  [AD-Prod]   │                                          │
│   🟢 DevTest      [AD-Dev]    │                                          │
│                               │                                          │
│ ▾ Application (Resource) 3    │                                          │
│   🟫 Procurement app          │                                          │
│   🟫 CRM platform             │                                          │
│   🟢 App grouping [Entra P.]  │                                          │
│                               │                                          │
│ ▾ ResourceCluster (Resource)1 │                                          │
│   🟢 LLM clusters             │                                          │
│                               │                                          │
│ ▾ Tags                   18   │                                          │
│   🟫 priority      (Identity) │                                          │
│   🟫 legacy        (Resource) │                                          │
│   … 16 more                   │                                          │
└───────────────────────────────┴──────────────────────────────────────────┘
```

### 1.1 Visual language

Three dimensions need to be distinguishable at a glance:

**Variant** (what produced this node) — shown as a **left border color**:
- 🔵 Blue — `synced`
- 🟢 Green — `generated`
- 🟫 Brown — `manual`

**Target type** (what the context contains) — shown as a **pill/badge** on the tree header and on each root entry:
- 🟪 Identity (purple)
- 🟧 Resource (orange)
- ⚪ Principal (grey)
- 🟨 System (yellow)

**Scope system** — shown as a **muted chip** `[System name]` next to the root display name, **only when `scopeSystemId` is set**. This is the thing that disambiguates two HR trees or two AD OU trees. For variant=manual with no scope set, the chip is absent. For a generated plugin run that ran across all systems, the chip is absent.

A manual sub-tree under a synced or generated parent shows up as 🔵 fading to 🟫 on the lineage — an analyst sees instantly which nodes they own versus which get overwritten on the next sync or plugin run.

### 1.2 Multi-tree handling

Several valid configurations need to be unambiguous in the selector:

| Configuration | How the selector handles it |
|---|---|
| **Multiple synced HR trees** (two Entra tenants, one CSV feed) | Three separate entries under "OrgUnit (Identity)", each with its own system chip. Display names can collide; system chip is the tiebreaker. |
| **Multiple AD OU trees** from one `ad-ou-from-dn` plugin run per AD crawler | Separate entries under "AD-OU (Identity)", each with its system chip. |
| **System with no HR tree** | Nothing implicit. The system just doesn't appear under any OrgUnit root. The Systems tab may show a "No org hierarchy synced" hint, but the Contexts tab does not fabricate one. |
| **Generated tree spanning all systems** (e.g. one global LLM cluster run) | Appears in its group with no system chip. |
| **Duplicate plugin runs against the same system** | A plugin run against a system where a previous run of the same plugin already produced a tree **replaces** the prior tree's contents (matched by `sourceAlgorithmId` + `scopeSystemId`). The selector does not show two entries. |

A filter bar above the selector lets the analyst narrow by target type, variant, or system — useful when there are dozens of trees. The selector remembers the last-expanded groups per user.

## 2. Tree View

Left pane = tree selector (one entry per root tree). Right pane = the selected tree.

Expand/collapse on parents. Hover shows direct & total member count. Right-click or "⋯" opens:

- **View detail** — opens the Context Detail Page (§5).
- **Filter matrix by this node** — sets a context filter and jumps to the Matrix tab.
- **Add manual child** (variant=manual only) — inline name prompt, then opens the new child for editing.
- **Move** (manual only) — reparent.
- **Delete** (manual only).

Synced and generated nodes are read-only except for grafting manual children under them.

## 3. List View

The same tree flattened into a table. Columns:

| Column | Notes |
|---|---|
| Name | Indented by depth for a visual hint even in list mode |
| Variant | Badge |
| Target type | Badge |
| Context type | Free-form sub-classification |
| Parent | Name of parent node (clickable) |
| Direct members | Count |
| Total members | Count incl. descendants |
| Last updated | For synced/generated, when the last run touched it |
| Actions | Same menu as right-click in tree |

Sortable and filterable. Useful for large flat trees (e.g. 2000-node AD OU structure) where the tree view is too dense.

## 4. Creating a Context Tree

The "+ New" button offers three entry points matching the three variants:

### 4.1 "Import tree" (synced)

Not done from the UI — synced trees appear automatically when a crawler (Entra, CSV) ingests them. The UI just explains this and links to the Crawlers page.

### 4.2 "Run plugin" (generated)

Modal wizard:
1. **Pick plugin** from the registered list, grouped by target type.
2. **Configure parameters** — form generated from the plugin's `parametersSchema`.
3. **Preview** — show how many contexts and members the plugin would create (dry-run API).
4. **Run** — kicks off a background run; user lands on the run-detail page with live progress.

After the run succeeds, the new tree shows up in the tree selector.

### 4.3 "Create manual tree" (manual)

1. Pick **target type**.
2. Pick **context type** (free-form, e.g. "Application", "BusinessProcess").
3. Name + description.
4. Lands on the empty root node. Analyst can add children and members via drag-drop from a side panel or a searchable picker.

## 5. Context Detail Page

Opens as a tab (following the existing pattern for User/Resource/AP detail pages). Deep-linked via `#context:id`.

**Header card:**
- Display name, variant badge, target-type badge, context-type
- Scope system chip (when `scopeSystemId` set)
- Owner chip (when `ownerUserId` set) — click to reassign (manual contexts only; others show owner as read-only)
- Provenance line: "Synced from System X on 2026-04-20 11:03" / "Generated by manager-hierarchy plugin on System X, run 2026-04-20 09:15" / "Created by wim@example on 2026-04-18"
- Action buttons: "Filter matrix by this" · "Run plugin again" (generated) · "Edit" (manual) · "Set parent" (manual) · "Set owner"

**Sections (collapsible):**

1. **Direct members** — paginated, searchable list. For Identity/Principal contexts: columns name, UPN, department. For Resource contexts: columns name, type, system.
2. **All members (incl. descendants)** — same shape, larger list.
3. **Sub-contexts** — clickable list, same as the tree view for just this subtree.
4. **Matrix preview** — embedded mini-matrix pre-filtered to this context. For Resource contexts: the assignments to these resources + the business roles that govern them. For Identity contexts: the resources these identities have access to.
5. **Risk summary** — aggregate risk score for all members (replaces the risk-scoring Clusters page).
6. **Version history** — the same trigger-based audit diff used elsewhere.
7. **Plugin run history** (generated only) — list of runs with start/finish/status/counts.

## 6. Matrix Filtering

The Matrix toolbar gains a **Context filter** control beside the existing Tag / Type filters.

**Widget:**

```
[ Context ▾ ]  Procurement app  ✕   [ include children ☑ ]   + Add
```

Clicking the dropdown opens a tree picker with a search bar — users type "procurement" and pick a node from the flattened hits. Include-children toggle per filter. Multiple filters chip into an AND bar. "✕" removes one.

**Behavior recap (see backend doc §5):**

- Identity/Principal target → filters rows
- Resource/System target → filters columns

A small info icon next to each chip explains what got filtered, for clarity when someone's first filter hides half the columns.

## 7. Replacing the Risk-Scoring Clusters Page

The current Clusters page goes away. Its content becomes the Contexts tab filtered to `contextType=ResourceCluster, variant=generated`. The Risk Scoring page gets a "View clusters →" button that opens Contexts with that filter pre-applied.

Cluster ownership generalises — the `ownerUserId` column on `Contexts` is available on any context (synced, generated, manual). Clusters are one prominent consumer, but a team lead can equally own an "Application: Procurement" grouping or a manual sub-tree. Assigning an owner is an analyst action; it survives plugin re-runs because plugins never touch `ownerUserId`.

## 8. Tags UI

**The tag UX does not change.** Colored chips on rows, tag filter on list pages, "Manage tags" modal, bulk tag-by-filter — all identical to today. The analyst does not learn a new workflow.

Behind the scenes, each tag is a manual flat context with `contextType='Tag'`, stored color in `extendedAttributes.tagColor`. This gives the analyst a second door into the same data, via the Contexts tab:

- **"Tags" group** in the tree selector lists every tag-context as a flat row. Opening one brings up the standard Context Detail Page.
- **Give it a parent.** The detail page "Set parent" action lets the analyst drag the tag-context under any other manual context. Once parented it behaves like any other sub-tree. The tag chip on list pages still works exactly as before — the chip doesn't care about hierarchy.
- **Give it an owner.** Same "Set owner" action as any other context. Useful for governance views and accountability.
- **Demote back to flat.** Clearing the parent returns the tag-context to the flat Tags group.

No "promote to hierarchy" wizard — parenting is just a field set. The legacy `GraphTags` / `GraphTagAssignments` tables are gone in v6; tag operations hit `Contexts` / `ContextMembers` directly.

## 9. Frontend Structure (proposed files)

New:
- `app/ui/src/components/ContextsPage.jsx` — tree selector + tree/list view switch
- `app/ui/src/components/ContextDetailPage.jsx` — detail tab (replaces the current minimal one)
- `app/ui/src/components/contexts/ContextTreeView.jsx`
- `app/ui/src/components/contexts/ContextListView.jsx`
- `app/ui/src/components/contexts/ContextTreeSelector.jsx`
- `app/ui/src/components/contexts/NewContextModal.jsx` — "+ New" dispatcher
- `app/ui/src/components/contexts/RunPluginModal.jsx`
- `app/ui/src/components/contexts/CreateManualTreeModal.jsx`
- `app/ui/src/components/matrix/ContextFilterControl.jsx` — the chip widget

Changed:
- `app/ui/src/App.jsx` — register the new tab, route `#context:id`
- `app/ui/src/components/matrix/MatrixToolbar.jsx` — embed `ContextFilterControl`
- `app/ui/src/hooks/usePermissions.js` — accept `contextFilters` query state and pass through

Removed (phase 4):
- `app/ui/src/components/OrgChartPage.jsx` — replaced by the Contexts tab
- The Clusters portion of `app/ui/src/components/RiskScoringPage.jsx`

## 10. Accessibility & Performance Notes

- Tree nodes are real `<button>` elements for keyboard nav. `aria-expanded` on parents.
- Large trees (10k+ nodes) render via the virtualised `@tanstack/react-virtual` pattern already used in the matrix.
- Color is never the only signal — variant and target-type badges carry text labels too.
- Tree → list toggle persists per-tree in localStorage.

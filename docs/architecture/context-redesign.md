# Context Redesign

> **Status:** Design proposal — not yet implemented.
> **Author:** Wim van den Heijkant
> **Date:** 2026-04-21
> **Companion docs:** [context-redesign-ui.md](context-redesign-ui.md)

## 1. Problem Statement

The current `Contexts` table is effectively a thin overlay on `Principals` — a hierarchy of departments with manager pointers, populated by the CSV crawler and a refresh job that derives departments from `Principals.department`. Membership is implicit (via `Identities.contextId`), there is no membership table, and there is no way to:

- Group **resources** (e.g. all groups belonging to one application) into a logical container.
- Mix **synced**, **algorithmically generated**, and **analyst-curated** groupings in one model.
- Run **algorithm plugins** that produce context trees (manager hierarchy, AD OU structure, name-pattern clustering, LLM clustering).
- Filter the matrix by a context with include/exclude-children semantics.

Meanwhile, three adjacent features are doing context-shaped work in parallel:

| Today | What it really is | Proposal |
|-------|-------------------|----------|
| `OrgUnits` (calculated from `Principals.department`) | A tree of Identity-targeted contexts | Becomes a generated context, produced by a plugin |
| Risk-scoring `Clusters` (LLM-grouped resources) | A flat list of Resource-targeted contexts | Becomes generated Resource contexts |
| `Tags` (free-form labels on Resources/Principals) | A flat, multi-target labeling system | See §7 — open question |

The redesign collapses these into one model with a clear variant axis and a clear target-type axis, and introduces a plugin framework for the "generated" variant.

## 2. Goals & Non-Goals

**Goals**
- One unified Contexts model with three variants and four target types.
- Explicit, queryable membership (replaces the implicit `Identities.contextId` pattern).
- Parent/child hierarchy with the ability for an analyst to graft a manual sub-tree under a synced or generated parent.
- Plugin framework for generated contexts (manager hierarchy, AD OU, name-pattern, LLM clustering).
- Matrix filtering by context with include/exclude-children toggles.
- Multiple context trees visible side-by-side in the UI, with clear visual distinction by variant and target type.

**Non-Goals**
- Replacing Identities or Principals — Contexts are an overlay, not a primary entity.
- Real-time graph computation — generated contexts are produced by scheduled or manual plugin runs.
- Cross-target contexts (a single context cannot contain both Resources and Identities — see §3.1).

## 3. Data Model

### 3.1 Constraint: one target type per context

Every context targets **exactly one** of these member types:

| Target type | Examples |
|---|---|
| `Identity` | An org unit, a project team, a sub-team an analyst added below HR data |
| `Resource` | "All groups belonging to the Procurement app", a SharePoint site cluster, a business-role grouping |
| `Principal` | A subset of accounts within one system (e.g. all service principals owned by one team) |
| `System` | A grouping of source systems (e.g. "all SAP-adjacent systems") |

This constraint keeps queries and UI simple: a context-filter on the matrix knows whether to filter rows (Identity/Principal) or columns (Resource), without runtime type inspection.

A context tree may mix variants across levels (manual sub-tree under a generated parent), but **every node in one tree shares the same target type**.

### 3.2 Variants

| Variant | Created by | Refresh model | Mutable by analyst? |
|---|---|---|---|
| `synced` | A crawler (Entra, CSV, etc.) | Each crawl run | No — overwritten on next sync |
| `generated` | A plugin algorithm | Each plugin run | No — overwritten on next run |
| `manual` | An analyst in the UI | Never — explicit edits | Yes |

Variant is a property of the **node**, not the tree. An analyst can graft a `manual` sub-tree under a `synced` parent. On the next sync the parent updates but the manual children are preserved (matched by `parentContextId` + analyst-set name).

### 3.3 Schema (proposed)

```sql
-- Replaces the current Contexts table
CREATE TABLE Contexts (
    id                  UUID PRIMARY KEY,
    variant             TEXT NOT NULL CHECK (variant IN ('synced','generated','manual')),
    targetType          TEXT NOT NULL CHECK (targetType IN ('Identity','Resource','Principal','System')),
    contextType         TEXT NOT NULL,           -- free-form sub-classification, e.g. 'OrgUnit', 'AppGrouping', 'BusinessProcess'
    displayName         TEXT NOT NULL,
    description         TEXT,
    parentContextId     UUID REFERENCES Contexts(id) ON DELETE CASCADE,

    -- Provenance
    scopeSystemId       INT REFERENCES Systems(id),       -- system this tree belongs to.
                                                          -- REQUIRED for variant='synced'.
                                                          -- OPTIONAL for variant='generated' (set when the plugin run was scoped to one system).
                                                          -- OPTIONAL for variant='manual' (an analyst may pin a manual tree to a system).
    sourceAlgorithmId   UUID REFERENCES ContextAlgorithms(id), -- variant='generated'
    createdByUser       TEXT,                              -- variant='manual'
    ownerUserId         TEXT,                              -- optional owner on any context (analyst, team lead); surfaces on detail page

    -- Stable external identity for re-sync matching
    externalId          TEXT,                              -- (scopeSystemId, externalId) unique for synced
    sourceRunId         UUID,                              -- last plugin run that touched this row (generated)

    -- Calculated
    directMemberCount   INT NOT NULL DEFAULT 0,
    totalMemberCount    INT NOT NULL DEFAULT 0,            -- includes descendants
    lastCalculatedAt    TIMESTAMPTZ,

    -- Metadata
    extendedAttributes  JSONB,
    createdAt           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updatedAt           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ix_Contexts_externalId ON Contexts(scopeSystemId, externalId)
    WHERE scopeSystemId IS NOT NULL AND externalId IS NOT NULL;
CREATE INDEX ix_Contexts_parent ON Contexts(parentContextId);
CREATE INDEX ix_Contexts_targetType ON Contexts(targetType);
CREATE INDEX ix_Contexts_variant ON Contexts(variant);
CREATE INDEX ix_Contexts_scopeSystem ON Contexts(scopeSystemId);

-- Explicit membership table (NEW)
CREATE TABLE ContextMembers (
    contextId           UUID NOT NULL REFERENCES Contexts(id) ON DELETE CASCADE,
    memberType          TEXT NOT NULL,           -- must match parent context's targetType
    memberId            UUID NOT NULL,           -- FK to Identities/Resources/Principals/Systems by memberType
    addedBy             TEXT NOT NULL CHECK (addedBy IN ('sync','algorithm','analyst')),
    addedAt             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (contextId, memberId)
);

CREATE INDEX ix_ContextMembers_member ON ContextMembers(memberType, memberId);

-- Plugin registry
CREATE TABLE ContextAlgorithms (
    id                  UUID PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,    -- e.g. 'manager-hierarchy', 'ad-ou-structure'
    displayName         TEXT NOT NULL,
    description         TEXT,
    targetType          TEXT NOT NULL,           -- which type of context it produces
    parametersSchema    JSONB,                   -- JSON Schema for run parameters
    enabled             BOOLEAN NOT NULL DEFAULT true,
    createdAt           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Run history
CREATE TABLE ContextAlgorithmRuns (
    id                  UUID PRIMARY KEY,
    algorithmId         UUID NOT NULL REFERENCES ContextAlgorithms(id),
    parameters          JSONB,
    startedAt           TIMESTAMPTZ NOT NULL DEFAULT now(),
    finishedAt          TIMESTAMPTZ,
    status              TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
    contextsCreated     INT,
    contextsUpdated     INT,
    contextsRemoved     INT,
    membersAdded        INT,
    membersRemoved      INT,
    errorMessage        TEXT,
    triggeredBy         TEXT
);
```

### 3.4 Multiple trees per kind

Trees are not deduplicated by kind. The model supports:

- **Multiple synced trees of the same shape** — e.g. two Entra tenants each crawled separately produce two independent "HR org" trees, each with its own `scopeSystemId`. A CSV crawler importing from Workday produces a third.
- **Multiple AD OU trees** — if an analyst runs the `ad-ou-from-dn` plugin once per AD crawler, each run produces a separate generated tree (different `scopeSystemId`, same `sourceAlgorithmId`).
- **System without an HR tree** — nothing is implicit. If a given system's crawler doesn't ingest an org hierarchy, no HR tree exists for it. The UI must not invent one.
- **System-agnostic generated trees** — a plugin may run across all systems and produce one tree with `scopeSystemId = NULL`. Example: a cross-system LLM resource cluster.

A root context (one with `parentContextId IS NULL`) represents the top of one tree. The tree selector lists root contexts; `scopeSystemId` is the primary secondary identifier when multiple roots share a display name or contextType.

### 3.5 Greenfield only — no migration from v5

This redesign is a **v6 breaking change**. There is no migration path from the current schema. Greenfield deployments only. Existing tables (`Contexts` of the current shape, `OrgUnits`, `GraphResourceClusters`, `GraphResourceClusterMembers`, `Identities.contextId`) are dropped by the v6 migration. Customers on v5 or earlier rebuild.

Rationale: the mapping from old to new is lossy for Risk-Scoring Clusters (ownership, scoring provenance) and for implicit membership via `Identities.contextId`, and the one real production deployment today is on v4 and already expects a full rebuild to reach v5/v6.

## 4. Plugin Framework for Generated Contexts

A plugin is a registered algorithm that takes parameters, reads from the database (and optionally external sources), and produces a tree of contexts plus membership rows. Plugins are server-side code modules in the web container — not user-uploaded. Adding a plugin = adding a Node module in `app/api/src/contexts/plugins/` and a row in `ContextAlgorithms`.

### 4.1 Plugin contract

```js
// app/api/src/contexts/plugins/types.js
export interface ContextPlugin {
  name: string;                    // matches ContextAlgorithms.name
  targetType: 'Identity'|'Resource'|'Principal'|'System';
  parametersSchema: object;        // JSON Schema
  run(params, ctx): Promise<{
    contexts: Array<ContextNode>,  // tree by parentExternalId
    members: Array<{ contextExternalId, memberId }>
  }>;
}
```

The runner reconciles the plugin output with existing `Contexts` rows where `sourceAlgorithmId` matches: insert new, update changed, delete missing. Manual children grafted under a generated parent are preserved by `parentContextId`.

### 4.2 Initial plugin set

| Plugin | Target | Source | Notes |
|---|---|---|---|
| `manager-hierarchy` | Principal | `Principals.managerId` chain | Node displayName is `"<Department> (<Manager name>)"` when available. Replaces the old OrgChart logic in the Entra crawler + the `/api/org-chart` derived tree. |
| `department-tree` | Principal | `Principals.department` parsed by separator | Replaces the former `refresh-contexts` derived OrgUnit tree. |
| `ad-ou-from-dn` | Principal | LDAP DN (default: `extendedAttributes.onPremisesDistinguishedName`) | Field source is configurable via the `dnField` parameter. |
| `app-grouping-by-pattern` | Resource | `Resources.displayName` regex | One bucket per `{name, regex}` pair; first-match wins; optional fallback bucket. |
| `resource-cluster` | Resource | `Resources.displayName` tokenised + indexed | Deterministic, non-LLM. See [`resource-cluster-algorithm.md`](resource-cluster-algorithm.md). Replaces the former stem-based Risk-Scoring clusters. |
| `business-process-llm` | Resource | LLM seeded with a process description | Registered with parameter shape; run loop still a stub. |

### 4.3 Where plugins run

In the **web container**, in-process, queued via the same job system risk-scoring already uses. The worker container stays plugin-free — the Entra crawler stops computing the org chart and just feeds raw Principals + managerId. The `manager-hierarchy` plugin then produces the tree.

This is a hard split: **crawlers ingest, plugins derive.** No more derivations in crawlers.

## 5. Filtering by Context

The matrix gains a context filter with two controls per filter:

1. **Pick a context** (any node in any tree).
2. **Include children?** Toggle on/off. Default on.

Behavior depends on the context's `targetType`:

| `targetType` | Effect on matrix |
|---|---|
| `Identity` | Filters **rows** to identities that are members (or descendants if include-children is on). |
| `Principal` | Filters **rows** to principals in the membership set. |
| `Resource` | Filters **columns** to resources in the membership set. Useful for the AP / business-role columns too. |
| `System` | Filters **columns** to resources whose `systemId` is in the membership set. |

Multiple context filters AND together. Within one filter, include-children expands the membership set via a recursive CTE on `parentContextId`.

The filter is also exposed on the **detail pages** (e.g. on a Resource Cluster context detail, show "users with assignments to anything in this cluster").

## 6. Worked Examples

### 6.1 "All groups for one application"

1. Analyst creates a manual context: targetType=Resource, contextType=Application, name="Procurement app".
2. Drag-drops or bulk-adds groups into it. Or: runs the `app-grouping-by-pattern` plugin scoped to a regex.
3. In the matrix, click context filter → pick "Procurement app" → the columns collapse to just those groups, and the rows show only users with assignments. Business-role columns that touch any of those groups stay visible.

### 6.2 "The procurement process"

1. Analyst creates a manual parent context "Procurement process" (targetType=Resource, contextType=BusinessProcess).
2. Adds children: "Procurement app" (manual), "Vendor SharePoint" (manual), "AP entitlement" (manual).
3. Filter matrix by "Procurement process" with include-children → shows resources from all three children.

### 6.3 "Sub-team not in HR"

1. The synced HR org tree has a node "Finance".
2. Analyst creates a manual child under it: "Finance / Treasury automation squad" (targetType=Identity).
3. Adds 4 identities to it.
4. The next HR sync updates "Finance" but leaves the manual child intact (matched by parentContextId).

### 6.4 "AD OU structure as a context tree"

1. Admin enables the `ad-ou-from-dn` plugin and configures it with the LDAP DN root.
2. Plugin reads `Principals.distinguishedName`, parses each DN into OU components, builds the tree, links identities.
3. Result: a second Identity-targeted tree appears next to the HR tree. Both are visible in the Contexts tab.

## 7. Tags

**Decision: tags are manual contexts under the hood. The tag UX stays exactly as it is today.**

Why: analysts know and love the tag flow. A chip with a color, a filter on list pages, "tag selected rows" — simple, fast, obvious. No reason to disturb any of that. But every tag that gets created silently becomes a `variant='manual', contextType='Tag', targetType=<entity type>` context with `parentContextId=NULL`. Membership is stored in `ContextMembers`, matching every other context.

What the analyst gains:

- **Find the tag in the Contexts tab.** A "Tags" pseudo-grouping in the tree selector lists all tag-contexts as a flat list. From there the tag opens in the standard Context Detail Page.
- **Parent it.** The analyst can assign a `parentContextId` on a tag-context — dragging it under any other manual context (or, later, a generated one). Once parented, it's just a regular hierarchy node. The tag chip keeps working on the pages it always worked on; nothing else changes.
- **Own it.** Set `ownerUserId`. Shows up on the detail page; surfaces in governance/compliance views.
- **Demote back to a tag.** Clearing the parent returns it to the flat-Tags bucket.

Under this model, tag operations (assign/unassign, list, filter) and context operations (add member / remove member / list / filter) share one code path. The `GraphTags` / `GraphTagAssignments` tables go away in v6 — replaced by rows in `Contexts` / `ContextMembers`.

The tag color survives as `extendedAttributes.tagColor` on the context row, only rendered when `contextType='Tag'`.

## 8. Rollout

Greenfield v6 cut, no dual-write, no feature flag. See [context-redesign-plan.md](context-redesign-plan.md) for the concrete phased build plan.

Short version: schema + API foundations first, then crawler integration, then plugin framework, then UI, then matrix filtering, then replace Risk-Scoring Clusters, then Tags-as-contexts, then additional plugins, then export/import as a follow-up.

## 9. Out of Scope (For Now)

- Cross-tenant context federation.
- ABAC policy engine driven by context membership (would be a follow-up).
- Real-time membership recomputation (membership is always plugin-run-driven for generated, write-time for manual, sync-driven for synced).
- A user-facing plugin SDK — plugins remain in-tree code modules until there's a clear case for third-party plugins.

### 9.1 Near-term follow-up: export / import

The existing "export tags" feature must extend to cover **all manual analyst input**: manual contexts (including tag-contexts), manual members, owners, and parent relationships. Not part of the core v6 cut, but the first follow-up after the UI lands. Design sketch:

- Export: single JSON artifact with all rows where `variant='manual'` plus their `ContextMembers`. Synced and generated content is excluded (it rehydrates from crawlers / plugin runs).
- Import: matches on `externalId` where set, on `(parentContextId path, displayName)` otherwise. Import is additive by default; "replace" mode wipes existing manual data first.
- Symmetric for tag-contexts — no separate "export tags" path after v6.

# Effective-Access Engine — Design Specification

> **Status:** Draft for review & approval. Pre-implementation — no code exists yet.
> **Purpose of this document:** get sign-off on the model, the data contract, and the
> resolution semantics *before* any code is written. A reviewer should be able to
> approve (or push back on) every decision here without reading source.
> **Owner:** _TBD_ · **Reviewers:** _TBD_

---

## 1. TL;DR

Crawlers store where access is **declared**. In any system with a containment hierarchy
and inherited permissions, a declared grant *reaches* far beyond its declaration point — a
role at an Azure subscription reaches every resource group and resource beneath it; an ACL
on a folder reaches every descendant file. None of that reach is stored.

A matrix that reads only declared assignments therefore **systematically under-reports
effective access** — the single most important thing a role-mining / audit tool must show.

The **effective-access engine** is a **core product feature** (not a crawler feature) that
converts *declared grants + a containment hierarchy* into *effective access at a node*,
**computed lazily on demand**, bounded by what is being viewed. It supports both monotonic
(grant-only) and non-monotonic (**deny**-bearing, path-aware) permission models through a
**pluggable per-source resolution policy**. It is the shared substrate every "system with
nested permissions" plugs into.

It is built **before** the Azure RM crawler, because the crawler depends on it and the deny
semantics cannot be retrofitted cleanly.

---

## 2. Motivation

Today the matrix data source — the materialized view `vw_ResourceUserPermissionAssignments`
(current definition: migration `026_matrix_view_dedup_after_case_collapse.sql`) — is a flat
`SELECT FROM "ResourceAssignments"`. It does **not** join `ResourceRelationships`. So a
`Contains` edge sitting in the table is inert: storing "RG is a child of Subscription" does
not make anyone with a subscription-level role appear on the RG.

This was deliberate. Migration `013_matrix_matviews_and_indexes.sql` *removed* recursive
transitive expansion from the matview because it was the dominant performance cost, and
replaced it with **lazy click-time expansion** (`GET /api/group/:id/nested-groups`). There
is, today, **no generic "walk `Contains` → render inherited access" consumer** anywhere.

Two ways exist to close the declared-vs-effective gap:

1. **Materialize** every effective tuple (crawler or matview writes them all). Correct, but a
   single high-level grant × a deep tree = a combinatorial explosion of rows, recomputed
   every sync.
2. **Compute on demand** — store only declared grants + the hierarchy edges, and derive
   "effective access at node N" by traversal *when someone actually looks at N*.

This engine is option 2, generalized.

### The model is already half-proven

The capability-in-resource pattern this engine assumes **already ships**:

- **App roles** — `tools/crawlers/entra-id/Start-EntraIDCrawler.ps1` already emits one
  resource per app role (`displayName = "<role> on <app>"`, `resourceType='AppRole'`),
  linked to the application via `relationshipType='HasAppRole'`, assigned via
  `assignmentType='AppRole'` / `AppRoleViaGroup`.
- **OAuth2 delegated permissions** — same shape (`resourceType='DelegatedPermission'`).

So the engine does not invent a new model; it generalizes an existing one to arbitrary depth
and adds principled deny.

---

## 3. Goals / non-goals

**Goals**

- Compute effective access (**allow and deny**) for a focus node or a principal, on demand.
- One engine serving all sources via a pluggable per-source **resolution policy**.
- First-class **explainability** — return the access path that produced each result.
- Bounded, predictable performance; **no silent truncation**.
- Preserve existing nested-group behavior, migrated onto the engine with **no observable
  change** (golden-test gated).

**Non-goals**

- Not a full-tenant effective-access flattener for the interactive matrix (that is a separate
  async **export** path, §13.4).
- Not a crawler — it consumes crawler output.
- Not responsible for data collection (crawlers do that) or for the declared-grant base grid
  (the matview keeps that).

---

## 4. Terminology

| Term | Meaning |
|---|---|
| **Node** | A resource: a *container* (scope / folder / site / group / app) or a *capability-resource* (`Capability @ Target`). |
| **Containment edge** | `ResourceRelationships` row, `relationshipType='Contains'`, parent→child, carrying `propagates` (bool). |
| **Capability** | The grantable unit (RBAC role, permission level, ACE right). Has a stable, opaque `capabilityId`. |
| **Grant / ACE** | A declared assignment: principal → capability-resource, with `effect` and `propagationScope`. |
| **Effect** | `allow` \| `deny` \| `eligible` \| `notset`. |
| **PropagationScope** | `self` \| `descendants` \| `selfAndDescendants` — how far a grant reaches from its declared node. |
| **ResolutionPolicy** | Per-source pure function: ordered ACE list → effective effect + decisive ACE. |
| **EffectivePath** | The provenance chain explaining a result (for audit / "why?"). |
| **Badge** | Reachability shown in the matrix: `Direct` / `Indirect` / `Eligible`. |

---

## 5. Architecture overview — one graph, two edge types

A principal's effective access = **reachability** across two edge types, evaluated through
the source's resolution policy:

- **Assignment edges** — principal → resource (a declared grant). A resource can itself be a
  principal (a group holding a role), so these chain.
- **Containment edges** — resource → resource (`Contains`, parent→child) — the propagation
  channel. Carries the capability **constant** down the tree.

```
Principal --assigned--> EntraID Group          (Direct,   stored)
          --assigned--> Contributor @ Sub      (Indirect, group is a principal here)
          --contains--> Contributor @ RG       (Indirect, scope inheritance)
          --contains--> Contributor @ VM       (Indirect, scope inheritance)
```

First hop = **Direct**, everything transitive = **Indirect**. The whole problem reduces to
bounded graph reachability + a per-source decision function.

---

## 6. The crawler contract — what is stored

The engine operates over the existing tables. To feed it, a crawler emits:

1. **Container nodes** — `Resources` rows (scopes, folders, sites, groups…).
2. **Capability-resources** — `Resources` rows for `Capability @ Target`, **only where a grant
   is declared** (sparse). `id = uuidv5(NS_CAP, targetNodeId + '|' + capabilityId)`
   (deterministic, see §11). `extendedAttributes`: `capabilityId`, `capabilityName`,
   `targetNodeId`.
3. **Containment edges** — `Contains` relationships, parent→child, with `propagates` (bool,
   default `true`). A crawler sets `propagates = false` on the edge to a child that **breaks
   inheritance** (NTFS block-inheritance / SharePoint break-inheritance).
4. **Declared grants** — `ResourceAssignments` (principal → capability-resource) carrying:
   - `effect` — default `allow`; `deny` / `eligible` where the source supports it.
   - `propagationScope` — default `selfAndDescendants`; NTFS/DevOps can emit `self` or
     `descendants`.
5. **Group memberships** — so principal-side expansion works (already emitted today).

The crawler-contract additions are small and additive (`propagates`, `effect`,
`propagationScope`). Monotonic sources (Azure RM v1) take all defaults and behave as today.

### Schema impact (decided — §15.1)

`effect` and `propagationScope` become **first-class columns** on `ResourceAssignments`
(indexed, hot-path), added by a migration with safe defaults and a backfill so all existing
rows resolve unchanged. They are **not** stored in `extendedAttributes` (cannot be cleanly
indexed; read on every resolve).

> **`relationshipType` / `effect` and the enum gate:** `Contains` is already in
> `RELATIONSHIP_TYPES` (validation.js). `propagates` is free-form `extendedAttributes` on the
> relationship. `effect` is a new column with its own allowed-value set. `resourceType` /
> `contextType` are free-form, so new capability/scope types need no validation change.

---

## 7. Traversal — lazy, bounded, inheritance-aware

For a query `(principal P | principalSet, capability C | all, focusNode N)`:

1. **holders(P)** — P plus all groups P transitively belongs to (visited-set for cycles).
2. **Ancestor window** — ascend from N following `Contains` edges *upward*. **Stop the moment
   you would cross an edge with `propagates = false`** — the nearest inheritance-break boundary
   is N's effective root. Collect `M₀ = N … M_k = root-or-break`.
3. **Gather ACEs** — all grants of C where target ∈ ancestor window, principal ∈ holders(P),
   and `propagationScope` reaches N (`self` only at `M₀`; `descendants` / `selfAndDescendants`
   at strict ancestors). Each ACE retains `{ effect, distance, explicit (M == N),
   viaGroupId|null, nodePath }`. **Distance and node path are always retained** — deny
   precedence needs them.
4. **Resolve** — hand the ordered ACE list to the source's `ResolutionPolicy` →
   `{ effective, decisiveAce, contributing }`.
5. **Bound** — `maxDepth` and `maxNodesPerExpansion` caps (defaults §13.3). Exceeding emits an
   explicit `truncated: { more: N }` marker — **never silent**.

**Down-expansion** (the matrix chevron on a container) is the same machinery run for each
child in the focus subtree, **one level per click** — "multiple smaller fetches."

---

## 8. Resolution — monotonic *and* path-aware deny

The engine **gathers**; the per-source `ResolutionPolicy` **decides**. This is the seam that
makes deny first-class without leaking source-specific rules into the traversal.

```
resolve(aces: Ace[], ctx) -> {
  effective: 'allow' | 'deny' | 'none',
  decisiveAce: Ace,        // for explainability
  contributing: Ace[]      // everything that mattered
}
```

A policy is **pure and deterministic** and is unit-tested against its vendor's documented
truth table (§17). A new source means a new (or reused) policy — **never** new traversal code.

### Built-in policies

| Policy | Rule | Sources |
|---|---|---|
| `AdditiveAllow` | any `allow` → allow; `deny` ignored (monotonic) | Azure RM v1, SharePoint (additive levels) |
| `DenyOverrides` | any `deny` → deny; else any `allow` → allow | Azure DevOps (deny-wins) |
| `NtfsCanonical` | explicit deny ≻ explicit allow ≻ inherited deny ≻ inherited allow; among inherited, **closer node wins** | NTFS / file systems |
| `ClosestWins` | most-specific node decides; deny ≻ allow within a node; `notset` passes through | generic three-state |

### Capability granularity (decided — §15.7)

Resolution compares ACEs of the **same `capabilityId` only**. The engine treats capabilities
as **opaque atoms** and does **not** model subsumption (e.g. it does not know NTFS `Modify` ⊇
`Write`). A source that needs right-level deny semantics must emit capabilities at a
granularity where allow and deny are directly comparable — atomic rights
(`Read`/`Write`/`Execute`/`Delete`) or a level model the source guarantees is comparable.

This keeps the engine minimal and pushes the (source-specific) granularity choice into the
crawler, where the source's own semantics live. The engine design does **not** foreclose
correct filesystem deny — it requires the filesystem crawler to choose a comparable
granularity.

---

## 9. Badges, eligibility, and the effect axis

- **Badge** is reachability *at the focus node*: `Direct` iff the decisive `allow` is a grant
  declared *at N* held *directly* (no group hop); otherwise `Indirect`.
- **Eligibility** (`effect = 'eligible'`) is *potential* access (PIM-style): carried like allow
  for display, rendered `E`, but **excluded** from "current effective access" answers and
  never combined with deny.
- **`effect` vs legacy `assignmentType` (decided — §15.6):** `effect` is a **new orthogonal
  axis**. The engine computes reachability by traversal and **never reads `assignmentType` for
  reachability**. Legacy `assignmentType` values are sorted out by the harmonization work, not
  here. For safety the engine treats a **missing `effect` as `allow`**, so all existing data
  resolves unchanged on day one.

---

## 10. Explainability — first-class output

Every effective result returns its **EffectivePath(s)**. Example:

> *alice has **effective deny** on `/Finance/2026/budget.xlsx` for `Modify` because: she's in
> `Finance-RW` → `Modify allow @ /Finance` (inherited), **overridden by** an explicit
> `Modify deny @ /Finance/2026` on `Everyone`.*

This is **required**, not optional — it is the audit value of the product. The response carries
`decisiveAce`, the `contributing` chain, and the node path. The UI renders "why?" from it.

---

## 11. Synthesized resources & deterministic-id collapse

Inherited capability-resources with **no declared grant** (e.g. `Contributor @ VM` inherited
from the subscription) are **synthesized at expand time and never stored**:

```json
{ "id": "uuidv5(NS_CAP, vmNodeId + '|' + roleDefId)",
  "displayName": "Contributor @ VM-01",
  "capabilityId": "<roleDefId>", "targetNodeId": "<vmNodeId>", "virtual": true }
```

Because the id is deterministic **and the crawler uses the same `uuidv5` for stored
capability-resources**, a synthesized inherited row and a stored directly-declared row for the
same `(capability, node)` carry the **same id** and merge into one matrix row showing both
Direct and Indirect holders — with **no dedup logic**. `NS_CAP` is a single fixed namespace
UUID constant shared by engine and crawlers — defined once, documented, never changed.

---

## 12. API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/resource/:id/effective-access` | Expand a focus container/capability: synthesized inherited rows + resolved holders. Params: `direction=down\|up`, `depth`, `principalId?`, `capabilityId?`, `includeDeny`. **Supersedes** `/group/:id/nested-groups` and the proposed `/scope/:id/effective`. |
| `GET /api/principal/:id/effective-access?node=:n` | For one principal: effective access at/under a node, with paths. Detail pages. |
| `POST /api/effective-access/resolve` | Batch resolve `(principals × nodes × capabilities)` for the **export** path (§13.4) — paginated/streamed, cache-bypassing. |

`/group/:id/nested-groups` is retained as a **thin shim** over the engine during migration,
golden-tested to be byte-identical, then removed.

**Response row:**

```json
{ "capabilityResourceId": "...", "virtual": false, "nodeId": "...", "principalId": "...",
  "effect": "allow", "badge": "Indirect", "viaGroupId": "...",
  "decisivePath": [ ... ], "truncated": null }
```

Auth: reuse the existing matrix/permissions authorization middleware — this endpoint exposes
the same sensitivity class as the matrix.

---

## 13. Performance & matrix integration

### 13.1 Lazy + bounded
Interactive paths only ever expand a focus neighborhood. The live matrix never triggers
full-tenant computation.

### 13.2 Caching (decided — §15.2)
In-memory LRU **per web process**, keyed by `(focusNode, filters, dataVersion)`. `dataVersion`
bumps in the existing end-of-sync `refresh-views` hook → stale entries simply miss, never
serve wrong data. (Single `web` container today; revisit Redis only on horizontal scale-out.)

### 13.3 Caps
Defaults `maxDepth = 50`, `maxNodesPerExpansion = 1000`, configurable. Exceeding emits
`truncated: { more: N }` — surfaced in the UI, **never silently dropped**.

### 13.4 Export path
`POST /api/effective-access/resolve` streams in batches with backpressure for "give me
everything," explicitly separate from interactive expansion.

### 13.5 The base grid and deny (decided — §15.3)
The matview keeps showing **declared** grants (fast; unchanged for monotonic sources). For
deny-bearing systems, declared `allow` ≠ effective. **Decision:** the matview gains a per-row
`contested` flag, set from a cheap **deny-presence index** when a `(principal, capability,
node)` has *any* reachable deny — without running full resolution at refresh. The UI marks
contested cells and the engine resolves the true effect (with path) on demand. **Monotonic
systems never set `contested`, so they pay nothing.** The base grid never *lies* about access.

### 13.6 Indexing
Index `Contains(parentResourceId)` and `(childResourceId)`; index `ResourceAssignments` by
`(resourceId, effect)`; a partial deny-presence index backs the `contested` flag.

---

## 14. Edge cases — enumerated, with decisions

| Case | Decision |
|---|---|
| Group-membership cycle (A∈B∈A) | visited-set; each principal counted once. |
| Containment cycle | shouldn't occur; defend with visited-set + data-quality warning. |
| Multi-parent node (DAG) | resolved by the policy; default `DenyOverrides` for conflicts in deny systems, `AdditiveAllow` union otherwise (§15.4). |
| Inheritance break mid-path | ascent stops at the break boundary (§7.2). |
| `self`-scoped ACE | applies only at its node, never to children. |
| `notset` three-state | passes through to parent; contributes nothing itself. |
| Orphan capability-resource (parent unsynced) | treat as its own root; resolve what's present; flag data-quality. |
| Dangling edge (node deleted between syncs) | skip the edge; tolerate. |
| Thin-stub principal (no name) | expand by id; display falls back to GUID. |
| Same `(capability, node)` via two paths | one cell; strongest badge (`Direct` > `Indirect`); **all** paths retained for explainability. |
| Inherited `Contributor` + child's own `Reader` | distinct capabilities → distinct rows. |
| Eligibility under a deny | eligibility excluded from effective computation; shown `E` separately. |
| Cross-system inheritance (ARM scope → Entra group → members) | the graph is system-agnostic; traversal crosses systems freely. |

---

## 15. Decisions & rationale (resolved open questions)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 15.1 | `effect` / `propagationScope` storage | **First-class columns + migration** | Read in the innermost resolution loop; must be indexable; JSONB can't be cleanly indexed and pays extraction on every resolve. |
| 15.2 | Cache strategy | **In-memory LRU, `dataVersion`-keyed** | Single web container; `dataVersion` invalidation makes staleness impossible. Redis only on scale-out. |
| 15.3 | Deny vs base grid | **`contested` flag + resolve-on-demand** | Keeps the matview a fast declared projection; monotonic sources pay nothing; the grid never lies. |
| 15.4 | DAG conflict default | **Policy-owned**; deny-wins for deny policies, union for additive | Conflict semantics belong to the source's policy, not the traversal. |
| 15.5 | Synthesized-resource detail pages | **Matrix-only in v1** | Virtual rows carry a path but no drill-through; detail pages operate on stored resources. Revisit on demand. |
| 15.6 | `effect` vs `assignmentType` | **`effect` is a new orthogonal axis**; engine ignores `assignmentType` for reachability; missing `effect` = `allow` | Reachability is computed; legacy `assignmentType` is harmonized elsewhere; back-compat preserved. |
| 15.7 | Capability granularity under deny | **Compare same `capabilityId` only; no subsumption lattice** | Minimal engine; sources needing right-level deny emit comparable granularity. Doesn't foreclose correct filesystem deny. |

---

## 16. Phased delivery

| Phase | Scope | Unblocks |
|---|---|---|
| **P1** | Engine core + `AdditiveAllow` + migrate nested-group expand onto it. No behavior change (golden-test parity). | The framework; Entra Owner-harmonization. |
| **P2** | Containment down-expansion: constant-capability carry, synthesized rows, deterministic-id collapse. | **Azure RM crawler.** |
| **P3** | Deny-aware resolution + `DenyOverrides` / `NtfsCanonical` / `ClosestWins` + `contested` matview flag + path-aware explainability. | Filesystem / SharePoint / DevOps crawlers. |
| **P4** | Export path (`POST /resolve`, async/streamed). | Full effective-access export. |

Dependency summary: ARM crawler → **P1 + P2**; Entra Owner-harmonization → **P1**; deny-bearing
crawlers → **P3**.

---

## 17. Migration & backward compatibility

- The `effect` / `propagationScope` migration backfills defaults; existing rows resolve as
  today (missing `effect` = `allow`).
- `/group/:id/nested-groups` becomes a shim over the engine; **golden tests assert identical
  output** before the old code is deleted.
- The matview keeps its declared-grant contract; `contested` is additive.
- `NS_CAP` namespace constant is introduced once and frozen.
- Schema changes go through versioned migration files in
  `app/api/src/db/migrations/` — never edit existing migrations.

---

## 18. Testing requirements *(must ship with the feature — not optional)*

- **Resolution truth tables.** Each `ResolutionPolicy` unit-tested against its vendor's
  documented precedence — especially `NtfsCanonical` against the canonical Windows
  explicit/inherited/deny ordering, and `DenyOverrides` against DevOps deny-wins.
- **Graph fixtures (golden files).** Deterministic fixtures for: deep tree, wide tree, broken
  inheritance, `self`/`descendants` scopes, multi-parent DAG, membership cycle, thin stubs,
  orphan/dangling edges — each with an asserted expected effective-access set.
- **Explainability assertions.** Every fixture asserts the decisive path, not just the boolean.
- **Parity / regression.** Golden snapshots of current `/nested-groups` output; the engine must
  reproduce them exactly (the P1 gate).
- **Performance tests.** Deep (10k-nested) and wide (10k-children) trees and a root-level grant
  fan-out: assert bounded latency, cache behavior, and correct `truncated` markers.
- **Determinism.** Same input → identical ids and stable row ordering.
- **Cross-source conformance suite** that every new `ResolutionPolicy` must pass to be accepted.

---

## 19. Documentation requirements *(ship with the feature)*

- **Architecture doc** — this file, kept current.
- **Crawler-author guide** — additions to `docs/sync/custom-crawlers.md`: the engine contract
  (`Contains` edges + `propagates`, `effect`, `propagationScope`, deterministic `NS_CAP` id),
  with a worked example per hierarchy type.
- **ResolutionPolicy authoring guide** — how to add a source's precedence rules + the
  conformance suite it must pass.
- **API reference** — the three endpoints, params, response shape, `truncated` / `contested`
  semantics.
- **Operator / UI doc** — what *declared vs effective* means, the `contested` indicator, how to
  read an access path; update `docs/architecture/matrix.md` to point at the engine as the
  inheritance mechanism (superseding the bespoke nested-group note from migration 013).
- **Changelog fragment** on each implementing branch, per repo rules (do **not** edit
  `CHANGES.md` directly).

---

## 20. First consumers (how they map)

- **Azure RM crawler** — emits the scope tree (`Contains`, `propagates = true`), sparse
  `Role @ Scope` capability-resources, `Direct` `allow` grants (`selfAndDescendants`). Uses
  `AdditiveAllow`. Inheritance is pure P2 down-expansion; nothing inherited is stored.
- **Entra Owner-harmonization** — `Owner of <Group>` becomes a capability-resource; group
  nesting runs through P1; the `O` badge is retired in favor of `Direct`/`Indirect`.
- **Filesystem (future)** — folder tree with `propagates = false` on block-inheritance nodes,
  `effect = deny` ACEs, `self` / `descendants` scopes, atomic-right capabilities; uses
  `NtfsCanonical`. This is the reason deny is first-class from day one.

---

## 21. Reviewer sign-off

Please confirm agreement (or record objections) on each:

- [ ] **Model** — capability-in-resource + two-edge reachability is the right core abstraction.
- [ ] **Crawler contract** (§6) — the additive fields (`propagates`, `effect`,
      `propagationScope`) are acceptable.
- [ ] **Schema** (§15.1) — first-class columns + a backfilling migration.
- [ ] **Deny on the base grid** (§13.5) — the `contested` flag approach.
- [ ] **Capability granularity** (§15.7) — same-`capabilityId` comparison; sources emit
      comparable granularity; no subsumption lattice.
- [ ] **Phasing** (§16) — P1 before the ARM crawler; deny in P3.
- [ ] **Testing & documentation** (§18–19) — required to ship with the feature.

_Approved by: ____________________  Date: ___________

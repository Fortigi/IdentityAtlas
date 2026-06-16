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
  async **export** path, §13.4). **Consequence:** the base matrix continues to show only
  *declared* grants for unvisited nodes. Inherited access becomes visible when the user expands
  a container — not pre-populated for every row. This is intentional and must be communicated
  in the UI.
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
Principal --assigned--> EntraID Group          (group member, stored)
          --assigned--> Contributor @ Sub      (Indirect, group is a principal here)
          --contains--> Contributor @ RG       (Indirect, scope inheritance)
          --contains--> Contributor @ VM       (Indirect, scope inheritance)
```

First hop = **Direct**, everything transitive = **Indirect**. The whole problem reduces to
bounded graph reachability + a per-source decision function. **Note:** `Direct`/`Indirect`
badges (§9) are determined at the *capability-resource* level — a group-membership edge is
not itself a badge; it affects whether the capability grant is direct or indirect.

**How the two traversals interleave:** `holders(P)` (principal-side expansion) and the
ancestor window (containment traversal) are **independent passes that share the same graph**:

1. `holders(P)` expands principal → groups via `ResourceAssignments` (where the group is the
   *resource* being assigned to, and P is the *principal*). This is a standard group-membership
   walk — no `Contains` edges involved.
2. The ancestor window walks *upward* via `Contains` edges in reverse (index on
   `childResourceId`), collecting candidate nodes.
3. The gather step cross-joins: "does any holder of P have a grant at any node in the ancestor
   window?" Both expansions cross system boundaries freely because the graph is system-agnostic
   — an Entra group can be a principal on an ARM scope via a `ResourceAssignment`, and the
   traversal follows that edge regardless of which crawler emitted it.

---

## 6. The crawler contract — what is stored

The engine operates over the existing tables. To feed it, a crawler emits:

1. **Container nodes** — `Resources` rows (scopes, folders, sites, groups…).
2. **Capability-resources** — `Resources` rows for `Capability @ Target`, **only where a grant
   is declared** (sparse). `id = SHA256-UUID(targetNodeId + '|' + capabilityId)`
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
> `RELATIONSHIP_TYPES` (validation.js). `propagates` is stored in `extendedAttributes` on the
> relationship (decided — §15.8: JSONB is acceptable for a bounded ancestor window; a
> first-class column adds value only when P3 deny-bearing sources are in scope). `effect` is a
> new first-class column with its own allowed-value set. `resourceType` / `contextType` are
> free-form, so new capability/scope types need no validation change.

---

## 7. Traversal — lazy, bounded, inheritance-aware

For a query `(principal P | principalSet, capability C | all, focusNode N)`:

1. **holders(P)** — P plus all groups P transitively belongs to (visited-set for cycles).
   Bounded by `maxHoldersPerExpansion` (default 500); exceeding emits `truncated:
   { holders: N }` — never silent, same principle as the ancestor cap.
2. **Ancestor window** — ascend from N following `Contains` edges *upward*. **Stop the moment
   you would cross an edge with `propagates = false`** — the nearest inheritance-break boundary
   is N's effective root. Collect `M₀ = N … M_k = root-or-break`.

   **DAG case:** if N has multiple parent edges and some have `propagates = false` while others
   have `propagates = true`, follow **all unblocked paths** independently. The inheritance
   break is on the specific edge, not on the node globally. Grants reachable via any unblocked
   path are collected; ancestors only reachable via blocked paths are excluded.
   **Admission rule:** an ancestor node is admitted to the window the first time *any*
   unblocked path reaches it; the visited-set then prevents processing it a second time. If the
   first path to reach an ancestor happens to be blocked and a second path is unblocked, the
   node is still admitted — admission requires at least one unblocked path.
3. **Gather ACEs** — all grants of C where target ∈ ancestor window, principal ∈ holders(P),
   and `propagationScope` reaches N (`self` only at `M₀`; `descendants` / `selfAndDescendants`
   at strict ancestors). Each ACE retains `{ effect, distance, explicit (M == N),
   viaGroupId|null, nodePath }`. **Distance and node path are always retained** — deny
   precedence needs them. `notset` ACEs are included in the gathered list and passed to the
   policy; policies that do not use three-state may discard them internally.
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
| `AdditiveAllow` | any `allow` → allow; `deny` ignored (monotonic) | Azure RM v1, SharePoint permission levels (additive only — SharePoint's "Deny All" permission level is NOT covered; a SharePoint crawler that needs deny semantics must use `DenyOverrides` or a dedicated policy) |
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

- **Badge** is reachability *at the focus node*: `Direct` iff the decisive ACE is a grant
  declared *at N* held *directly* (no group hop); otherwise `Indirect`. For `deny` results,
  badge reflects the same Direct/Indirect logic applied to the decisive deny ACE — a
  `deny` with `badge=Direct` means the deny is explicit at N with no group hop.
- **Eligibility** (`effect = 'eligible'`) is *potential* access (PIM-style): carried like allow
  for display, rendered `E`, but **excluded** from "current effective access" answers.
  When a principal has both `eligible` and `deny` ACEs for the same capability at the same
  effective node: `deny` wins — the engine returns `{ effective: 'deny' }` and the `E` badge
  is not shown (a deny forecloses even potential access).
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
{ "id": "<SHA256-UUID of 'vmNodeId|roleDefId'>",
  "displayName": "Contributor @ VM-01",
  "capabilityId": "<roleDefId>", "targetNodeId": "<vmNodeId>", "virtual": true }
```

Virtual rows are synthesized as **output** of the gather/resolve step — they represent
inherited access paths where no stored grant exists at the target node. They are never
written to the database and are not queried in the gather SQL; the gather step queries only
stored `ResourceAssignments`. Virtual rows are merged in application memory into the result
set and carry the same deterministic id as any stored row for the same `(capability, node)`.

Because the id is deterministic **and the crawler uses the same algorithm for stored
capability-resources**, a synthesized inherited row and a stored directly-declared row for the
same `(capability, node)` carry the **same id** and merge into one matrix row showing both
Direct and Indirect holders — with **no dedup logic**.

**ID algorithm — SHA256-UUID:**
```
input  = UTF-8 bytes of (targetNodeId + '|' + capabilityId), no null terminator
hash   = SHA256(input)                          // 32 bytes
id     = lowercase hex of hash[0..15], formatted as UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```
No RFC 4122 version or variant bits are set — this is a deterministic opaque identifier used
only as a database primary key. Implementation: Node.js `crypto.createHash('sha256')`
(built-in, Node ≥ 18); PowerShell `[System.Security.Cryptography.SHA256]::Create()` (built-in,
.NET). No third-party package required in either runtime.

> **The input format is a one-way door.** Changing `targetNodeId + '|' + capabilityId`
> (including the separator) would require re-crawling all sources to regenerate stored
> capability-resource rows with new IDs, and purging all cached synthesized rows. If a crawler
> discovers its `capabilityId` values are unstable across versions, that is a crawler
> data-quality problem — fix it in the crawler, not by changing the input format.

**Cross-language conformance:** The engine (Node.js) and crawlers (PowerShell) must produce
identical ids from the same inputs. Define the algorithm once in
`app/api/src/lib/capabilityId.js` (engine side, exported) and
`tools/crawlers/shared/Get-CapabilityId.ps1` (crawler side, dot-sourced). A cross-language
conformance test (`test/unit/CapabilityId.Tests.ps1`) asserts that both implementations
return identical ids for a fixed set of `(targetNodeId, capabilityId)` pairs. This test
must run in CI and is a hard gate — a mismatch would cause synthesized rows to never
collapse with stored rows.

> **Pipe-free constraint:** Both `targetNodeId` and `capabilityId` **must be pipe-free
> strings**. UUIDs satisfy this inherently. Non-UUID `capabilityId` values (e.g. NTFS atomic
> rights `Read`/`Write`/`Execute`/`Delete`) are also pipe-free and safe. A future crawler
> emitting a compound capabilityId containing `|` would produce an ambiguous input format —
> crawlers must validate and reject any such value before calling `Get-CapabilityId.ps1`.
> The conformance test catches regressions on its fixed fixture set but cannot detect novel
> capabilityId formats; this constraint must be enforced in the crawler-author guide.

---

## 12. API surface

| Endpoint | Purpose |
|---|---|
| `GET /api/resource/:id/effective-access` | Expand a focus container/capability: synthesized inherited rows + resolved holders. Params: `direction=down\|up`, `depth`, `principalId?`, `capabilityId?`, `includeDeny`. **Supersedes** `/group/:id/nested-groups` and the proposed `/scope/:id/effective`. |
| `GET /api/principal/:id/effective-access?node=:n` | For one principal: effective access at/under a node, with paths. Detail pages. |
| `POST /api/effective-access/resolve` | Batch resolve `(principals × nodes × capabilities)` for the **export** path (§13.4) — paginated/streamed, cache-bypassing. |

`/group/:id/nested-groups` is retained as a **thin shim** over the engine during migration,
golden-tested to be byte-identical, then removed. **Removal gate:** (a) golden snapshot tests
pass for 30 days in production with zero diffs, AND (b) log analysis confirms no callers
outside the engine itself. Shims without removal gates tend to live forever.

**Shim phasing:** The shim is written in P1 (at migration time). In P1, the engine emits no
virtual rows, so the de-virtualization step is a no-op. In P2, the shim is updated to
actively drop `virtual=true` rows from the engine output. **The 30-day removal gate clock
starts after the P2 shim update is deployed** — not at P1 shim creation.

**Shim shape contract:** The existing endpoint returns `{ groups: [], memberships: [] }` — two
arrays of resources and flat membership rows. The engine returns structured rows with
`{ capabilityResourceId, principalId, badge, decisivePath, effect, … }`. The shim must
map engine output back to the legacy shape: de-virtualize synthesized rows (drop rows where
`virtual=true`), rename `principalId` → `memberId`, and strip `effect`/`badge`/`decisivePath`.
**Golden snapshots must be generated from the ORIGINAL endpoint BEFORE the shim is written**
— snapshots generated from the shim itself would validate the shim against itself and miss
any divergence.

**Error contract:** If `:id` does not exist as a known resource, the endpoint returns `404`.
If `:n` (node param on the principal endpoint) does not exist, the endpoint returns `404`.
Empty results (resource exists but no effective access) return `200` with an empty array.
When a traversal cap is hit before any matching grant is encountered, the endpoint returns
`200` with an empty rows array and a non-null `truncated` object — a `200` with
`truncated.more > 0` and empty rows is a valid pagination signal, not an error.

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
In-memory LRU **per web process** using the `lru-cache` npm package (add to
`app/api/package.json`). Size limit: `maxSize: 100_000_000` bytes with
`sizeCalculation: (v) => JSON.stringify(v).length`. Configurable via
`EFFECTIVE_ACCESS_CACHE_MAX_BYTES` env var.

**Cache key** — explicit colon-delimited string (no pipe characters to avoid NS_CAP separator
ambiguity in debug output):
```
`${focusNode}:${direction}:${depth ?? ''}:${principalId ?? ''}:${capabilityId ?? ''}:${includeDeny ? '1' : '0'}:${dataVersion}`
```

**`dataVersion`** is a **separate sync version counter** — **not** `MAX(GraphSyncLog.id)`.
The counter lives in the existing `WorkerConfig` table as a single row:
`WorkerConfig('syncVersion', '0')`, incremented atomically at sync completion. Using the sync
log max-id would advance the cache key as soon as a sync begins, causing requests during the
sync window to cache partially-updated data. The `WorkerConfig` counter advances only after
all sync writes are durable. **Who increments it:** the crawler (PowerShell), via a separate
`UPDATE "WorkerConfig" SET "configValue" = ("configValue"::int + 1) WHERE "configKey" =
'syncVersion'` committed immediately after all sync data is durable — not the API.
`dataVersion = 0` (no syncs completed yet on a fresh install) causes requests to run uncached,
which is correct.

(Single `web` container today; revisit Redis only on horizontal scale-out.)

> **Post-sync cache miss:** when a sync completes, all cached entries become stale
> simultaneously. On a heavily-used instance, the first wave of requests after a sync will
> all miss and trigger parallel traversals. With the current single-container, bounded-user
> deployment this is acceptable. Document and revisit at horizontal scale-out.

### 13.3 Caps
Defaults `maxDepth = 50`, `maxNodesPerExpansion = 1000`, `maxHoldersPerExpansion = 500`,
all configurable. Exceeding any cap emits a `truncated` marker — **never silently dropped**:

```json
{
  "truncated": {
    "more": 42,           // ancestor/descendant nodes cut off (null if not truncated)
    "holders": 15         // holder principals cut off (null if not truncated)
  }
}
```

All results are returned sorted by `(nodeId, principalId, capabilityId) ASC` for stable
pagination — the same query with the same data always returns rows in the same order.
When a result set is truncated, the returned subset is additionally surfaced sorted
alphabetically by `displayName` so the most relevant subset is visible. The caller can
filter/search to narrow results below the cap.

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

**Schema timing:** The `contested` column is added to the matview in the **P2 migration**
as `BOOLEAN DEFAULT FALSE NOT NULL`. The deny-presence index logic that populates it is
added in P3. This avoids a breaking schema change at P3 time (which may be months later)
and allows the UI to treat `contested=false` as "safe to show" from day one — without the
column being absent and requiring conditional rendering. **P3 readiness gate:** no deny-bearing
crawler may be enabled until the `contested` population logic is deployed and verified.

### 13.6 Indexing
Index `Contains(parentResourceId)` and `(childResourceId)`; index `ResourceAssignments` by
`(resourceId, effect)`; index `ResourceAssignments(principalId)` — verify this index exists
from prior migrations (group-membership queries already need it); add if absent. A partial
deny-presence index backs the `contested` flag (added in P3 alongside the population logic).

`capabilityId` is stored in `extendedAttributes` on capability-resource rows but is read in
the resolution inner loop. Add a **generated stored column** and index:
```sql
ALTER TABLE "Resources"
  ADD COLUMN "capabilityId" TEXT GENERATED ALWAYS AS
    (("extendedAttributes"->>'capabilityId')) STORED;
CREATE INDEX "ix_Resources_capabilityId" ON "Resources"("capabilityId")
  WHERE "capabilityId" IS NOT NULL;
```
This matches the reasoning in §15.1 (hot-path columns must be indexable).

---

## 14. Edge cases — enumerated, with decisions

| Case | Decision |
|---|---|
| Group-membership cycle (A∈B∈A) | visited-set; each principal counted once. |
| Containment cycle | shouldn't occur; defend with visited-set + data-quality warning. |
| Multi-parent node (DAG) | resolved by the policy; default `DenyOverrides` for conflicts in deny systems, `AdditiveAllow` union otherwise (§15.4). |
| Inheritance break mid-path | ascent stops at the break boundary (§7.2). |
| DAG with mixed `propagates` (some edges blocked, some not) | follow all unblocked paths; block is per-edge, not per-node. Visited-set prevents revisiting ancestors reached via multiple paths. |
| `self`-scoped ACE | applies only at its node, never to children. |
| `descendants`-scoped ACE declared AT N (focus node is the grant target) | does NOT apply at N — only at N's children. Engine correctly returns `none` at N from this ACE. This is correct semantics; crawlers that mean "self and descendants" must emit `selfAndDescendants`. |
| `notset` three-state | passes through to parent; contributes nothing itself. |
| Orphan capability-resource (parent unsynced) | treat as its own root; resolve what's present; flag data-quality. |
| Dangling edge (node deleted between syncs) | skip the edge; tolerate. |
| Thin-stub principal (no name) | expand by id; display falls back to GUID. |
| Same `(capability, node)` via two paths | one cell; strongest badge (`Direct` > `Indirect`); **all** paths retained for explainability. |
| Inherited `Contributor` + child's own `Reader` | distinct capabilities → distinct rows. |
| `eligible` + `deny` ACEs for same capability at same effective node | `deny` wins — engine returns `{ effective: 'deny' }`; `E` badge not shown (deny forecloses even potential access). |
| Eligibility under a deny (general) | eligible ACEs excluded from effective-access computation; shown `E` separately when no deny is present. |
| Cross-system inheritance (ARM scope → Entra group → members) | the graph is system-agnostic; traversal crosses systems freely. |

---

## 15. Decisions & rationale (resolved open questions)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 15.1 | `effect` / `propagationScope` storage | **First-class columns + migration** | Read in the innermost resolution loop; must be indexable; JSONB can't be cleanly indexed and pays extraction on every resolve. |
| 15.2 | Cache strategy | **In-memory LRU (`lru-cache`), `dataVersion`-keyed; `dataVersion` = `WorkerConfig('syncVersion')` counter incremented by crawler at sync completion** | Using `MAX(GraphSyncLog.id)` advances the cache key as soon as a sync begins, causing requests to cache partially-updated data for the duration of the sync. `WorkerConfig` already exists (migration 001); reusing it adds no new schema object. Redis only on scale-out. |
| 15.3 | Deny vs base grid | **`contested` flag + resolve-on-demand** | Keeps the matview a fast declared projection; monotonic sources pay nothing; the grid never lies. |
| 15.4 | DAG conflict default | **Policy-owned**; deny-wins for deny policies, union for additive | Conflict semantics belong to the source's policy, not the traversal. |
| 15.5 | Synthesized-resource detail pages | **Matrix-only in v1** | Virtual rows carry a path but no drill-through; detail pages operate on stored resources. Revisit on demand. |
| 15.6 | `effect` vs `assignmentType` | **`effect` is a new orthogonal axis**; engine ignores `assignmentType` for reachability; missing `effect` = `allow` | Reachability is computed; legacy `assignmentType` is harmonized elsewhere; back-compat preserved. |
| 15.7 | Capability granularity under deny | **Compare same `capabilityId` only; no subsumption lattice** | Minimal engine; sources needing right-level deny emit comparable granularity. Doesn't foreclose correct filesystem deny. |
| 15.8 | `propagates` storage on `ResourceRelationships` | **`extendedAttributes` (JSONB) — not a first-class column** | Interactive traversal reads a bounded ancestor window (≤ ~20 hops for the deepest expected hierarchy); JSONB extraction on that set is negligible. The main benefit of a first-class column would be a partial index for inheritance-break lookups — but that optimization is only material for deny-bearing filesystem crawlers. P3 is deferred (see §16), so the index is not needed now. **Concrete promotion trigger:** add a first-class column (+ partial index) when any hierarchy in production exceeds 500 nodes with >10% of edges having `propagates=false`, or when a deny-bearing source is scoped — whichever comes first. |
| 15.9 | `capabilityId` indexing | **Generated stored column + index on `Resources`** | `capabilityId` is in `extendedAttributes` but read in the resolution inner loop. Same reasoning as §15.1 — hot-path fields must be indexable. Generated column avoids schema drift between the JSONB blob and the query path. |
| 15.10 | `contested` column schema timing | **Added in P2 migration as `DEFAULT FALSE`; populated in P3** | Adding the column in P2 avoids a breaking schema change when P3 lands, allows the UI to render `contested=false` as "safe" from day one, and makes the P3 scope smaller (logic change only, no schema change). P3 readiness gate: deny-bearing crawlers blocked until population logic is deployed. |
| 15.11 | `holders(P)` cap | **`maxHoldersPerExpansion = 500` (configurable); exceeds emits `truncated:{holders:N}`** | Mirrors the ancestor window cap. Without a bound, a principal in deep nested AD mega-groups could exhaust memory. Silent truncation would violate the "no silent truncation" invariant; the structured truncated response preserves caller observability. |

---

## 16. Phased delivery

| Phase | Scope | Unblocks |
|---|---|---|
| **P1** | Schema migration adding `effect` and `propagationScope` columns to `ResourceAssignments` (with backfill). Engine core + `AdditiveAllow` + migrate nested-group expand onto it. Write `/group/:id/nested-groups` shim (de-virtualize is no-op in P1 — no virtual rows yet). No behavior change (golden-test parity). | The framework; Entra Owner-harmonization. |
| **P2** | Containment down-expansion: constant-capability carry, synthesized rows, deterministic-id collapse. Adds `contested BOOLEAN DEFAULT FALSE` column to matview. Update shim to drop `virtual=true` rows. **30-day shim removal gate clock starts here.** | **Azure RM crawler.** |
| **P3** | Deny-aware resolution + `DenyOverrides` / `NtfsCanonical` / `ClosestWins` + `contested` matview flag + path-aware explainability. | Filesystem / SharePoint / DevOps crawlers. |
| **P4** | Export path (`POST /resolve`, async/streamed). | Full effective-access export. |

Dependency summary: ARM crawler → **P1 + P2**; Entra Owner-harmonization → **P1**; deny-bearing
crawlers → **P3**.

> **P3 is deferred until a deny-bearing crawler is actually planned.** No filesystem,
> SharePoint, or DevOps crawler is currently in scope. Specifying `DenyOverrides`,
> `NtfsCanonical`, the `contested` flag, and the full deny traversal before there is a
> consumer is YAGNI. When a deny-bearing source is scoped, revisit §8 and §13.5 and add P3
> to the active roadmap. The engine architecture (pluggable `ResolutionPolicy`, `effect`
> column) is designed to make P3 addable without touching the traversal core — that is the
> extent of the current investment in deny.

---

## 17. Migration & backward compatibility

- The `effect` / `propagationScope` migration backfills defaults; existing rows resolve as
  today (missing `effect` = `allow`). **Exception:** rows with `assignmentType = 'Eligible'`
  must be backfilled to `effect = 'eligible'`, not `allow` — otherwise the engine would
  surface eligible-only access as granted access on day one. The migration SQL must be:
  ```sql
  UPDATE "ResourceAssignments"
  SET "effect" = CASE WHEN "assignmentType" = 'Eligible' THEN 'eligible' ELSE 'allow' END
  WHERE "effect" IS NULL;
  ```
- `/group/:id/nested-groups` becomes a shim over the engine; **golden tests assert identical
  output** before the old code is deleted.
- The matview keeps its declared-grant contract; `contested` is additive.
- `NS_CAP` namespace constant is introduced once and frozen.
- Schema changes go through versioned migration files in
  `app/api/src/db/migrations/` — never edit existing migrations.

---

## 18. Testing requirements *(must ship with the feature — not optional)*

- **Test runner:** engine unit tests and `ResolutionPolicy` truth tables use the **`node:test`
  built-in** (Node.js ≥ 18, no additional dev dependency). Pester continues for PowerShell
  crawler conformance (`test/unit/CapabilityId.Tests.ps1` and future crawler unit tests).
- **Resolution truth tables.** Each `ResolutionPolicy` unit-tested against its vendor's
  documented precedence — especially `NtfsCanonical` against the canonical Windows
  explicit/inherited/deny ordering, and `DenyOverrides` against DevOps deny-wins.
- **Graph fixtures (golden files).** Deterministic fixtures for: deep tree, wide tree, broken
  inheritance, `self`/`descendants` scopes, multi-parent DAG, membership cycle, thin stubs,
  orphan/dangling edges — each with an asserted expected effective-access set. Mandatory
  additional fixtures:
  - **DAG mixed inheritance-break:** N has parents M₁ (propagates=true) and M₃
    (propagates=false). Grant at M₁'s ancestor. Expected: grant is effective at N via M₁
    path; M₃'s ancestors are not consulted. Verifies "follow all unblocked paths" (§7).
  - **`descendants`-only at focus node:** grant declared AT N with `propagationScope =
    'descendants'`. Query: does P have access at N? Expected: `none`. Verifies that
    `descendants` scope does not include the grant's own node.
- **Explainability assertions.** Every fixture asserts the decisive path, not just the boolean.
- **Parity / regression.** Golden snapshots of current `/nested-groups` output — captured from
  the **ORIGINAL endpoint before the shim is written**; the engine must reproduce them exactly
  (the P1 gate). The shim's shape transform (de-virtualize, rename principalId → memberId,
  strip effect/badge/decisivePath) must be separately tested against a known-good fixture.
- **Performance tests.** Deep (10k-nested) and wide (10k-children) trees and a root-level grant
  fan-out: assert bounded latency, cache behavior, and correct `truncated` markers.
- **holders(P) truncation fixture.** Principal transitively belongs to N > `maxHoldersPerExpansion`
  groups via nested chains. Expected: `truncated:{holders:N}` returned; subset is sorted
  alphabetically by group `displayName`; result is deterministic across calls.
- **Cache staleness determinism test.** Unit test (mocked DB): if the `dataVersion` read at
  cache-key construction differs from the `dataVersion` read at result-population time (a sync
  completed mid-traversal), the result is discarded and re-fetched — never cached under the
  stale key. Separately, an integration smoke test: run a sync against a real test database,
  verify no stale data is returned immediately after the version increments (without asserting
  sub-millisecond timing properties).
- **Determinism.** Same input → identical ids and stable row ordering.
- **Cross-source conformance suite** that every new `ResolutionPolicy` must pass to be accepted.

---

## 19. Observability requirements *(ship with the feature)*

Every traversal request emits one structured log line at exit:

```json
{ "event": "effective-access-resolve", "focusNode": "...", "direction": "down|up",
  "traversalDepth": 4, "nodesVisited": 12, "holdersCount": 3,
  "cacheHit": false, "truncated": false, "durationMs": 18, "dataVersion": 42 }
```

**Required metrics (from log aggregation):**
- Cache hit rate by endpoint (`GET /resource/:id/effective-access`, `GET /principal/:id/effective-access`)
- Traversal depth histogram (p50, p99)
- Truncation rate — percent of requests where `truncated = true`
- p99 traversal latency per endpoint

**Alerting:**
- Cache hit rate falls below 50% for 5 minutes → investigate `dataVersion` or LRU size
- Traversal depth p99 exceeds 40 levels (80% of `maxDepth=50`) → investigate data model or raise cap
- p99 traversal latency exceeds 500ms → investigate query plan or index coverage
- Truncation rate exceeds 10% → containers too wide for default cap; surface to UI team

## 20. Documentation requirements *(ship with the feature)*

- **Architecture doc** — this file, kept current.
- **Crawler-author guide** — additions to `docs/sync/custom-crawlers.md`: the engine contract
  (`Contains` edges + `propagates`, `effect`, `propagationScope`, SHA256-UUID capability-resource id),
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

## 21. First consumers (how they map)

- **Azure RM crawler** — emits the scope tree (`Contains`, `propagates = true`), sparse
  `Role @ Scope` capability-resources, `Direct` `allow` grants (`selfAndDescendants`). Uses
  `AdditiveAllow`. Inheritance is pure P2 down-expansion; nothing inherited is stored.
- **Entra Owner-harmonization** — `Owner of <Group>` becomes a capability-resource; group
  nesting runs through P1; the `O` badge is retired in favor of `Direct`/`Indirect`.
- **Filesystem (future)** — folder tree with `propagates = false` on block-inheritance nodes,
  `effect = deny` ACEs, `self` / `descendants` scopes, atomic-right capabilities; uses
  `NtfsCanonical`. This is the reason deny is first-class from day one.

---

## 22. Reviewer sign-off

Please confirm agreement (or record objections) on each:

- [ ] **Model** — capability-in-resource + two-edge reachability is the right core abstraction.
- [ ] **Crawler contract** (§6) — the additive fields (`propagates`, `effect`,
      `propagationScope`) are acceptable.
- [ ] **Schema** (§15.1) — first-class columns + a backfilling migration.
- [ ] **Deny on the base grid** (§13.5) — the `contested` flag approach.
- [ ] **Capability granularity** (§15.7) — same-`capabilityId` comparison; sources emit
      comparable granularity; no subsumption lattice.
- [ ] **Phasing** (§16) — P1 before the ARM crawler; deny in P3.
- [ ] **Testing & documentation** (§18–20) — required to ship with the feature.
- [ ] **Observability** (§19) — structured log line + metrics + alerts required to ship.
- [ ] **`capabilityId` generated column** (§13.6, §15.9) — added to migration scope.
- [ ] **DAG inheritance-break semantics** (§7) — follow all unblocked paths; confirm this matches any DAG-native source planned for the future.
- [ ] **`holders(P)` cap** (§7, §13.3, §15.11) — `maxHoldersPerExpansion=500`, emits `truncated:{holders:N}`.
- [ ] **Sync version counter** (§13.2, §15.2) — `WorkerConfig('syncVersion')` counter incremented by crawler at sync completion; not `MAX(GraphSyncLog.id)`.
- [ ] **`contested` column timing** (§13.5, §15.10) — added in P2 as `DEFAULT FALSE`; populated in P3; P3 readiness gate enforced.
- [ ] **Shim shape contract** (§12) — golden snapshots captured from original endpoint before shim is written; shape transform specified.
- [ ] **Pipe-free constraint** (§11) — `capabilityId` must be pipe-free; crawler-author guide to enforce.

_Approved by: ____________________  Date: ___________

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAN | HOLD SCOPE; 5 doc gaps fixed, 1 TODO deferred |
| Outside Voice (CEO) | Claude subagent | Independent 2nd opinion | 1 | ISSUES FOUND → ACTIONED | 9 findings, 5 actioned in-session, 4 deferred to later phases |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAN | D1–D8 decisions + 14 OV findings; all actioned in-session |
| Outside Voice (Eng) | Claude subagent | Independent 2nd opinion | 1 | ISSUES FOUND → ACTIONED | 14 findings; all resolved in-session (spec clarifications + algorithm decisions) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** SPEC APPROVED — CEO review and Eng review complete. All decisions resolved. Ready for implementation.

**Key decisions locked in Eng Review:**
- D1: SHA256-UUID for capability-resource ids (no third-party dep; native in Node.js + PowerShell)
- D2: `WorkerConfig('syncVersion')` counter (reuses existing table; incremented by crawler at sync completion)
- D3: `lru-cache` npm package for in-process LRU
- D4: Explicit colon-delimited cache key string
- D5: All results sorted `(nodeId, principalId, capabilityId) ASC`; truncated subsets also by `displayName`
- D6: Migration backfill test mandatory (`Eligible` rows → `effect='eligible'`)
- D7: `node:test` built-in for engine unit tests (Node ≥ 18, no new dep)
- D8: `maxSize: 100MB` with `sizeCalculation: (v) => JSON.stringify(v).length`

NO UNRESOLVED DECISIONS

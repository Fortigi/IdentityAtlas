# Assignment Model Redesign — collapse `assignmentType` to the universal "how"

> **Status:** Proposed (ADR / design doc — no code yet)
> **Date:** 2026-06-25
> **Companion files:** [`matrix.md`](matrix.md), [`crawler-architecture.md`](crawler-architecture.md), [`043_matrix_view_directory_roles.sql`](../../app/api/src/db/migrations/043_matrix_view_directory_roles.sql), [`app/api/src/ingest/engine.js`](../../app/api/src/ingest/engine.js), [`app/api/src/ingest/validation.js`](../../app/api/src/ingest/validation.js)

## TL;DR

`ResourceAssignments.assignmentType` currently has **ten** values
(`Direct, Indirect, Eligible, Owner, Governed, OAuth2Grant, AppRole, AppRoleViaGroup, DirectoryRole, DirectoryRoleEligible`).
That single column is silently doing **three unrelated jobs**, and the matrix has
to undo the damage with a lossy, hand-maintained `CASE` collapse.

This document proposes shrinking `assignmentType` to the **three universal
membership semantics** — `Direct` / `Indirect` / `Eligible` — and moving "what
kind of access this is" entirely onto the **resource** axis (`resourceType`),
where the synthetic-resource pattern already lives. Group ownership becomes a
resource you hold a `Direct` assignment to, mirroring how an app role hangs off
its application.

The blocker — and the reason this is a **crawler + ingest-side** change, not a
view tweak — is that today the full-sync delete uses `assignmentType` as its
partition key. That has to move to the resource axis first.

---

## 1. Problem: `assignmentType` is overloaded

The column conflates three orthogonal concerns:

| Job | Values doing it | Where it's consumed |
|---|---|---|
| **1. The "how"** (membership semantics) | `Direct`, `Indirect`, `Eligible`, `Owner` | matrix badges, risk scoring, governance |
| **2. The sync-partition key** (which crawler phase owns the row) | `AppRole`, `OAuth2Grant`, `DirectoryRole`, `DirectoryRoleEligible`, `AppRoleViaGroup`, `Owner`, … | `engine.js` `scopedDelete` |
| **3. Governed-ness** (came via an access package) | `Governed` | `managedByAccessPackage` flag |

Because "what kind" got crammed onto the assignment axis (as a side effect of
job #2), the matrix can't read it directly — it has to **collapse** the ten
types back into four in the matview, every time, by hand:

```sql
-- 043_matrix_view_directory_roles.sql (the collapse, duplicated in both arms)
CASE
  WHEN ra."assignmentType" IN ('Governed','OAuth2Grant','AppRole','DirectoryRole') THEN 'Direct'
  WHEN ra."assignmentType" = 'AppRoleViaGroup'                                     THEN 'Indirect'
  WHEN ra."assignmentType" = 'DirectoryRoleEligible'                               THEN 'Eligible'
  ELSE ra."assignmentType"
END AS "membershipType"
```

This `CASE` is **fragile**: it is duplicated across the matview's two arms
(principal-level + identity-level), it is coupled to the
`validation.js ASSIGNMENT_TYPES` enum with **no test enforcing the two stay in
sync**, and any new assignment type that is added to the enum but not to the
`CASE` falls through `ELSE` and **leaks its raw value into the matrix** as a
garbage badge. The lossy collapse is a *symptom*; the overloaded column is the
disease.

## 2. Current state (evidence)

### 2.1 Producers — where each type is written

All citations are in `tools/crawlers/entra-id/Start-EntraIDCrawler.ps1` unless noted.

| `assignmentType` | Producer | Target resource | `resourceType` |
|---|---|---|---|
| `Direct` | group members (`:1350`); Omada (`omada/…:1184`); Azure (`azure-rm/…:462`); CSV | the group itself / a resource | `Group`, `AzureRoleAssignment`, … |
| `Owner` | group owners (`:1375`) | **the group itself** | `Group` |
| `Eligible` | PIM-eligible group members (`:1442`) | the group itself | `Group` |
| `Governed` | access packages (`:1628`); Omada managed (`omada/…:1066`) | the AP / business role | `AccessPackage`, `BusinessRole` |
| `OAuth2Grant` | OAuth2 consent (`:2007`) | **synthetic** | `DelegatedPermission` |
| `AppRole` | app-role assignment (`:2220`, `:2249`) | **synthetic** | `AppRole` |
| `AppRoleViaGroup` | app role expanded through a group (`:2290`) | **synthetic** | `AppRole` |
| `DirectoryRole` | active directory role (`:2444`) | **synthetic** | `EntraDirectoryRole` |
| `DirectoryRoleEligible` | PIM-eligible directory role (`:2466`) | **synthetic** | `EntraDirectoryRole` |

**Two facts that frame the whole redesign:**

1. **The "source" types already point at synthetic resources.** `OAuth2Grant`,
   `AppRole`, `DirectoryRole`, and `DirectoryRoleEligible` all target a resource
   (`DelegatedPermission`, `AppRole`, `EntraDirectoryRole`) that *already* carries the
   "what." Their distinct `assignmentType` is **redundant for "what"** — it only
   survives as the sync-partition key (job #2) plus the direct/indirect/eligible
   distinction (job #1). The codebase is already halfway to the target model.

2. **Owner is purely a flag.** Group owners are written against the group's
   **own** `Group` resourceId with `assignmentType='Owner'`. There is **no**
   "ownership of group X" resource. So owner-as-resource is genuinely new
   modeling — but it is the *only* "how" that isn't already
   direct/indirect/eligible.

### 2.2 The delete is partitioned by `assignmentType`

`validation.js`:

```js
export const ENTITY_SCOPE_MAP = {
  'resource-assignments':          ['assignmentType'],
  'resource-assignments-identity': ['assignmentType'],
  // …
};
```

`engine.js → scopedDelete()` builds the reconcile delete's `WHERE` from
`systemId` plus each scope key **that is an actual column on the table**:

```js
if (systemId != null && tableColumnNames.has(systemIdColumn))
  where += ` AND t."${systemIdColumn}" = $n`;
for (const [key, value] of Object.entries(scope || {})) {
  if (value == null || !tableColumnNames.has(key)) continue;   // <-- key MUST be a real column
  where += ` AND t."${key}" = $n`;
}
if (scopeDeleteFilter) where += ` AND (${scopeDeleteFilter})`;  // <-- escape hatch for join-based filters
// soft-delete: UPDATE … SET deletedAt = now() WHERE <where> AND deletedAt IS NULL
//              AND NOT EXISTS (SELECT 1 FROM <temp> src WHERE <key-join>)
```

Every crawler phase sends `-Scope @{ assignmentType = '…' }`, so each phase's
full sync only deletes its own rows (`Direct` deletes only `Direct`, `AppRole`
deletes only `AppRole`, …). **This is exactly why the distinct source types
exist** — and exactly what blocks collapsing them.

> Note the two important mechanics: a scope key is only applied if it is a real
> column (`tableColumnNames.has(key)`), and `scopeDeleteFilter` already exists as
> a hook for arbitrary SQL (used today to protect account-linking rows). Both
> matter for the partition decision in §4.1.

### 2.3 `ResourceAssignments` columns today

`resourceId, principalId, assignmentType, systemId, principalType,
complianceState, policyId, state, assignmentStatus, expirationDateTime,
extendedAttributes, id, identityId, effect, propagationScope, deletedAt`.

There is **no `resourceType` and no source/phase column** — `resourceType` lives
on `Resources`, reachable only via `resourceId`. This is the crux of the
partition decision.

### 2.4 Which crawlers already conform?

Target: every producer emits only `Direct`/`Indirect`/`Eligible`. Audited from
the `assignmentType = '…'` literals in each crawler entry point:

| Crawler | Emits today | Conforms? |
|---|---|---|
| `azure-rm` | `Direct` | ✅ yes |
| `csv` | pass-through — whatever the file's type column says (defaults `Direct`) | ⚠️ only if the file does |
| `omada` | `Direct`, `Governed` | ❌ no |
| `midpoint` | `Direct`, `Governed` | ❌ no |
| `entra-id` | `Direct`, `Eligible`, `Owner`, `Governed`, `AppRole`, `AppRoleViaGroup`, `DirectoryRole`, `DirectoryRoleEligible` | ❌ no |

So **phase 2 is not Entra-only**: `omada` and `midpoint` also emit `Governed`
and need the same `Governed → Direct + flag` conversion; `csv` passes the input
through untouched, so its conformance is only as good as the uploaded file — the
runtime guard (§6, phase 3) is what actually protects it. Only `azure-rm` is
already clean.

## 3. Target model

- **`assignmentType` ∈ `{ Direct, Indirect, Eligible }`** — the universal "how,"
  and nothing else.
- **"What kind" lives entirely on `resourceType`** (`Group`, `AppRole`,
  `DelegatedPermission`, `EntraDirectoryRole`, `AccessPackage`, `BusinessRole`, … plus a
  **new ownership resource**).
- **Owner → `Direct` assignment to an `Owner @ <name>` resource**, linked to the
  owned resource by a `ResourceRelationship` (mirroring `AppRole --HasAppRole-->
  Application`). See §4.2 — this is a deliberate choice, not a foregone one.
- **Governed → stays the orthogonal `managedByAccessPackage` flag** (already
  materialized in the matview from `Governed` rows / `governed_pairs`); it is not
  a "how" and does not belong on `assignmentType`.
- **The matview's per-type `CASE` largely disappears** — only `Indirect`
  derivation and the governed flag remain. The fragile enum↔`CASE` coupling is
  gone, and new resource types surface in the matrix with **zero** matview
  changes.

End state of `assignmentType`'s three jobs:

| Job | Today | Target |
|---|---|---|
| how | mixed into 10 values | `assignmentType` ∈ {Direct, Indirect, Eligible} |
| sync-partition | `assignmentType` | the **resource axis** (see §4.1) |
| governed | `Governed` type | `managedByAccessPackage` flag (unchanged) |

## 4. Key decisions

### 4.1 Re-home the sync-partition key (the central decision)

If `assignmentType` collapses, the delete can no longer isolate phases with it.
A partition on **`(systemId, resourceType, assignmentType)`** uniquely separates
every current phase:

| Phase | resourceType | how |
|---|---|---|
| group members | Group | Direct |
| group owners | **GroupOwnership** (new) | Direct |
| group PIM-eligible | Group | Eligible |
| app role (direct / via group) | AppRole | Direct / Indirect |
| OAuth grant | DelegatedPermission | Direct |
| directory role (active / eligible) | EntraDirectoryRole | Direct / Eligible |
| access package | AccessPackage | Direct (+ governed flag) |

Three ways to make the delete key on `resourceType`:

- **Option A — denormalize `resourceType` onto `ResourceAssignments`** *(recommended)*.
  Add the column, populate it from the resource at ingest, index it, and change
  `ENTITY_SCOPE_MAP['resource-assignments']` to `['resourceType','assignmentType']`.
  The existing `scopedDelete` then works unchanged (the scope keys are real
  columns). Bonus: matrix and many detail queries can drop a `Resources` join.
  Cost: a denormalized column to keep correct at write time (drift risk, managed
  by always setting it from the resource during ingest).
- **Option B — join-filter via the existing `scopeDeleteFilter`** (no schema
  change). The engine translates a `resourceType` scope into
  `EXISTS (SELECT 1 FROM "Resources" r WHERE r.id = t."resourceId" AND r."resourceType" = $x)`.
  Cost: a correlated subquery in every reconcile delete, and engine plumbing to
  translate the scope key.
- **Option C — a dedicated `sourcePhase` marker column.** Most explicit
  decoupling (partition is neither "how" nor "what"), minimal engine change
  (swap the scope key). Cost: introduces a fourth concept that is *not* part of
  the "what lives on resourceType" model this redesign is built around.

**Recommendation: Option A.** It keeps the partition on the resource axis (the
whole point of the redesign), needs no per-delete subquery, and the denormalized
`resourceType` pays for itself across the read path. Option B is the
zero-migration fallback if denormalization is judged too risky.

### 4.2 Owner: resource, or a fourth "how"?

This is a genuine choice, unlike §4.1.

- **The source-type collapse (AppRole/OAuth2Grant/DirectoryRole) is unambiguous**
  — those types are pure redundancy with the resource and should go regardless.
- **Owner-as-resource** (recommended for consistency): `assignmentType` becomes a
  clean 3-value set; ownership is a first-class, certifiable thing; every system's
  notion of ownership is uniform (`Owner @ X`). **Cost:** resource-count growth
  (one ownership resource per owned group), and the matrix shows ownership as its
  own column rather than an `O` badge on the group.
- **Owner-stays-a-how** (4 values: Direct/Indirect/Eligible/Owner): no resource
  growth, no migration of owner rows; but `assignmentType` keeps a special case
  and consumers keep handling four.

Recommend **owner-as-resource** to fully realize the uniform model, while
acknowledging the matrix-shape change is the thing to validate with users.

### 4.3 Governed stays a flag

`Governed` assignments already drive `managedByAccessPackage` in the matview. In
the target model an access-package assignment is a `Direct` assignment to an
`AccessPackage`/`BusinessRole` resource with the governed flag set — the flag
remains orthogonal to the "how."

**Decision needed:** once `Governed` is no longer an `assignmentType`, the
governed signal must be carried by *something else*. Two candidates — a boolean
column on `ResourceAssignments`, or derive it from `resourceType ∈
{AccessPackage, BusinessRole}`. This matters because `Governed` is emitted by
**three** crawlers (`entra-id`, `omada`, `midpoint`; see §2.4), so all three
switch to `Direct` + the chosen governed signal in phase 2.

## 5. Matrix impact

The matview's collapse `CASE` shrinks to (at most) the `Indirect` derivation and
the governed flag. The validation-enum↔`CASE` sync hazard disappears. Badge and
count consumers (`MatrixCell.jsx`, scope statistics) already operate on the
collapsed `{Direct, Indirect, Eligible, Owner}` set; after this change they see
`{Direct, Indirect, Eligible}` (plus ownership as a resource row, if §4.2 is
adopted). `matrix.md` must be updated to match.

## 6. Migration & rollout (phased)

Order matters — the partition must move **before** the types collapse, or a sync
mid-migration could wipe another phase's rows.

1. **Foundation (this PR — migration 044).** Add `resourceType` to
   `ResourceAssignments`, backfill it from `Resources`, and index
   `(systemId, resourceType, assignmentType)`. `ENTITY_SCOPE_MAP` starts
   *accepting* `resourceType` on the assignment scopes. Entirely inert: nothing
   reads or partitions on the column yet, the matview is untouched, and
   `ingest.js` only copies scope keys present in the request body — so crawlers
   that send only `assignmentType` get a byte-identical delete. Verified a
   behaviour-preserving no-op on SK1/SK3.
2. **Crawlers + partition activation.** Every non-conforming producer (§2.4 —
   `entra-id`, `omada`, `midpoint`, and `csv`'s input contract) starts sending
   `resourceType` in its reconcile scope (and populating it on write), switches
   from the source types to `Direct/Indirect/Eligible`, and creates the
   `GroupOwnership` resources + relationships for owners. The reconcile delete
   now partitions on the resource axis. Verified on SK3 (large matrices,
   soft-delete behaviour).
3. **Matview.** Drop the per-type `CASE`; rebuild from the now-clean
   `assignmentType`. Add the **enum↔collapse guard test** regardless.
4. **Consumers.** Audit matrix badges, scope statistics, governance, risk
   scoring, and the effective-access engine for hardcoded source-type / `Owner`
   handling.
5. **Cleanup + the hard rule.** Once no producer writes the legacy types and
   backfill is complete, lock the model down with two layers:
   - **Runtime (airtight).** Narrow `validation.js ASSIGNMENT_TYPES` to exactly
     `['Direct','Indirect','Eligible']`. Because every crawler — Entra, Omada,
     midpoint, CSV, and any external importer — writes through the same ingest
     validation, the API then **rejects any other value with a 400**, with no
     per-crawler trust required. A vitest pins the enum so it can't silently
     regrow.
   - **Static dev-time scan.** A CI test (Pester or vitest) that greps every
     `tools/crawlers/**/*.ps1` for `assignmentType = '<X>'` — in both the record
     payloads *and* the `-Scope @{ … }` calls — and fails if any `X ∉
     {Direct, Indirect, Eligible}`. Catches a non-conforming crawler before it
     ever reaches ingest.

Each step is its own PR; the foundation is a verified no-op, which lets the
risky crawler change in step 2 land behind a partition that already exists in
the schema. The partition must move **before** the types collapse, or a sync
mid-migration could soft-delete a sibling phase's rows.

## 7. Risks & backward compatibility

- **Soft-delete + re-sync:** `ResourceAssignments` is soft-deleted. The
  backfill and partition change must not mass-stamp `deletedAt`. Validate on SK3
  (large matrices) before any crawler change.
- **Mixed-state window:** between steps 3 and 6 some rows carry legacy types and
  some the new model; the matview `CASE` must tolerate both until cleanup.
- **External/CSV importers** that send the legacy `assignmentType` values must be
  given a deprecation path before step 6 removes them from the enum.
- **Resource-count growth** from ownership resources (§4.2) — measure on SK3.

## 8. Open questions

- Confirm the exact current producers of `Indirect` (transitive group
  membership vs. `AppRoleViaGroup` expansion) so the "how" mapping is complete.
- Ownership resource granularity: one `Owner @ <resource>` per owned resource,
  or a single ownership resource per system with the owned resource as the
  relationship target?
- Do governance/risk consumers need to distinguish *source* (was-an-app-role vs
  was-a-directory-role) for any logic today? If so, that distinction must be
  recoverable from `resourceType` — verify nothing reads `assignmentType` for it.
- Option A vs B for the partition — decide after a quick perf check of the
  join-filter delete on SK3-scale data.

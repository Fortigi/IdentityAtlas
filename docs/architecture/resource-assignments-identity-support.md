# ResourceAssignments: Identity-Level Assignment Support

> **Status:** Implemented — T7 (tests) outstanding.
> **Owner:** _TBD_ · **Reviewers:** _TBD_

---

## 1. TL;DR

In IGA (Identity Governance and Administration), access is assigned to **people**,
not to individual system accounts. When a person is given a role, that access spans
multiple applications — each component applies to whichever account that person holds
in that system. IdentityAtlas currently has no way to model this: every assignment must
point to a specific account, so the fact that "Alice the person was given this access"
is lost regardless of the resource type.

**Technical accounts are different.** Mailbox accounts, service accounts, and functional
accounts are created for a specific system, and their roles only contain permissions within
that system. Assigning those roles to the account directly is correct and sufficient.

Both patterns coexist in every IGA-managed organisation. This spec adds a first-class
`identityId` assignment target to `ResourceAssignments`, alongside the existing
`principalId`, so IGA crawlers can store any person-level assignment without disrupting
existing data or non-IGA deployments.

---

## 2. Problem Statement

### 2.1 The IGA assignment model

In IGA, a business role like "Finance Manager" is assigned to **Alice the person**. That
role is composed of permissions across multiple applications — an AD group, a SAP role, an
Exchange mailbox policy. Each permission applies to a specific account Alice holds in that
application's system.

A person can also have multiple accounts in the same system — a day-to-day account and an
admin account, for example. Business roles specify which type of account gets which access:
Finance Manager goes to the day-to-day account; an AD Admin role goes to the admin account.

```
Alice (identity)
  ├─ AD account: alice@contoso.com       (day-to-day)
  ├─ AD account: alice.admin@contoso.com (admin)
  └─ SAP account: alice.sap

Business Role "Finance Manager"
  └─ Contains: AD group "Finance-AD"    → alice@contoso.com (day-to-day)
  └─ Contains: SAP role "Finance-SAP"   → alice.sap

Business Role "AD Admin"
  └─ Contains: AD group "Admins"        → alice.admin@contoso.com
```

The IGA assignment is fundamentally about the person. Which account in which system
receives each permission is a separate concern — resolved through the resource/system
hierarchy, not by duplicating the assignment row.

IdentityAtlas today cannot store this. Every assignment row must point to a specific
account, so an IGA crawler is forced to either pick one account (losing the others) or
duplicate the business role row once per account (losing the "assigned to the person" fact):

```sql
-- Forced workaround today:
ResourceAssignments: resourceId=FinanceManager, principalId=Alice_AD_account
ResourceAssignments: resourceId=FinanceManager, principalId=Alice_SAP_account
-- "Alice the person was assigned Finance Manager" is not representable.
```

### 2.2 Technical accounts: principal assignment is correct

A mailbox account or service account belongs to one system. Its roles only grant
permissions within that system. There is no cross-system expansion to do —
`principalId` assignment is complete and correct for these accounts.

### 2.3 Both must coexist

Most IGA-managed organisations assign business roles to human identities and manage
technical accounts separately via direct principal assignments. Some organisations go
further and model identities for their technical accounts too — in that case, even
technical account roles can be assigned at the identity level.

| Account type | Assignment target | Notes |
|---|---|---|
| Human person | `identityId` | Standard IGA practice |
| Technical account | `principalId` | Most orgs; role is system-scoped |
| Technical account | `identityId` | Orgs that model identities for technical accounts |
| Non-IGA org | `principalId` only | No `Identities` rows exist |

Both assignment targets must be valid simultaneously. The choice is per-org (and
per-account-type within an org), not a global switch.

### 2.3 What does NOT change

- Organisations that never use IGA continue writing `principalId` assignments exactly as
  today. No code changes needed on their crawlers.
- The `assignmentType` semantics (`Direct`, `Governed`, `AppRole`, etc.) are unchanged.
- The matrix view continues to render correctly for principal-only rows.

---

## 3. Data Model Change

### 3.1 Current schema (migration 001)

```sql
CREATE TABLE "ResourceAssignments" (
    "resourceId"    UUID NOT NULL,
    "principalId"   UUID NOT NULL,          -- ← always required today
    "assignmentType" TEXT NOT NULL,
    "systemId"      INTEGER REFERENCES "Systems"("id") ON DELETE CASCADE,
    "principalType" TEXT,
    "complianceState" TEXT,
    "policyId"      UUID,
    "state"         TEXT,
    "assignmentStatus" TEXT,
    "expirationDateTime" TIMESTAMPTZ,
    "extendedAttributes" JSONB,
    PRIMARY KEY ("resourceId", "principalId", "assignmentType")
);
```

### 3.2 Target schema (migration 036)

```sql
-- Migration 036_resource_assignments_identity_support.sql
-- Not wrapped in a transaction: Docker deploy stops at startup on migration
-- failure; manual cleanup via psql is acceptable given the simple, tested steps.

-- 1. Drop the existing PK (it includes principalId which will become nullable)
ALTER TABLE "ResourceAssignments"
    DROP CONSTRAINT "ResourceAssignments_pkey";

-- 2. Make principalId nullable
ALTER TABLE "ResourceAssignments"
    ALTER COLUMN "principalId" DROP NOT NULL;

-- 3. Add identityId column — bare UUID, no FK (symmetric with principalId).
--    Both columns are unvalidated at the DB layer; data integrity relies on
--    the crawler ordering contract (push identities before assignments) and
--    the re-sync pattern (crawlers re-push after an identity is deleted).
--    A FK + CASCADE can be added in a later migration once principalId also
--    gets a FK, making the two columns consistent.
ALTER TABLE "ResourceAssignments"
    ADD COLUMN "identityId" UUID;

-- 4. Enforce: exactly one of principalId / identityId must be non-null
ALTER TABLE "ResourceAssignments"
    ADD CONSTRAINT "ck_RA_principal_or_identity"
    CHECK (
        ("principalId" IS NOT NULL)::int + ("identityId" IS NOT NULL)::int = 1
    );

-- 5. Recreate uniqueness as two partial unique indexes (replaces the PK)
CREATE UNIQUE INDEX "uq_RA_principal"
    ON "ResourceAssignments"("resourceId", "principalId", "assignmentType")
    WHERE "principalId" IS NOT NULL;

CREATE UNIQUE INDEX "uq_RA_identity"
    ON "ResourceAssignments"("resourceId", "identityId", "assignmentType")
    WHERE "identityId" IS NOT NULL;

-- 6. Supporting index for identity-side lookups
CREATE INDEX "ix_RA_identityId"
    ON "ResourceAssignments"("identityId")
    WHERE "identityId" IS NOT NULL;
```

**Why no surrogate PK?** IdentityAtlas uses raw SQL (no ORM) and Docker-deployed PostgreSQL
with no logical replication. Two partial unique indexes provide the same uniqueness guarantees
for the application's use patterns. Adding a surrogate `id` would require changing every
`ON CONFLICT` clause in the ingest paths.

**No FK on identityId.** `principalId` has no FK to `Principals` (historical pattern).
`identityId` is kept symmetric — bare UUID, no FK. Both columns rely on the crawler
ordering contract for data integrity. A FK + CASCADE migration can follow once both
columns are handled together.

**No data migration needed.** All existing rows have `principalId` set and `identityId`
NULL. The CHECK (`principalId IS NOT NULL ∧ identityId IS NULL` → sum = 1) is satisfied by
every existing row.

**Lock window.** `DROP CONSTRAINT` and `ALTER COLUMN DROP NOT NULL` require a brief exclusive
table lock. At 1M rows on container startup this takes seconds before API traffic arrives.
Accepted — document in changelog.

---

## 4. Ingest API Contract

### 4.1 Two endpoints — batch type enforced by route

**Person-level and account-level assignments use separate endpoints.** The routing rule is
based on *who the source system says has the access*: if the subject is a person (identity)
→ use the identity endpoint; if the subject is a specific account (principal) → use the
principal endpoint. Resource type is irrelevant to the routing decision.

Batch type is enforced at the route level — no runtime detection, no mixed-batch validation.

| Endpoint | Accepted records | Key columns |
|---|---|---|
| `POST /ingest/resource-assignments` | `{ resourceId, principalId, assignmentType }` | `['resourceId', 'principalId', 'assignmentType']` |
| `POST /ingest/resource-assignments-identity` _(new)_ | `{ resourceId, identityId, assignmentType }` | `['resourceId', 'identityId', 'assignmentType']` |

Both endpoints write to `ResourceAssignments`. Mixed batches are structurally impossible —
the schema for each endpoint only accepts its own key type.

### 4.2 Principal endpoint — no changes to existing schema

`resource-assignments` in `validation.js`, `ENTITY_TABLE_MAP`, and `ENTITY_KEY_MAP` is
unchanged. Existing crawlers continue to work without modification.

One change: the handler passes `scopeDeleteFilter: '"principalId" IS NOT NULL'` to
`ingest()` on full syncs. See section 4.5.

### 4.3 Identity endpoint — new entity type

Add `resource-assignments-identity` across four maps in `validation.js` and `ingest.js`:

```javascript
// ENTITY_TABLE_MAP:
'resource-assignments-identity': 'ResourceAssignments',

// ENTITY_KEY_MAP:
'resource-assignments-identity': ['resourceId', 'identityId', 'assignmentType'],

// ENTITY_SCOPE_MAP:
'resource-assignments-identity': ['assignmentType'],
```

Validation schema:
```javascript
'resource-assignments-identity': {
  required: ['assignmentType'],
  requiredOneOf: [
    { fields: ['resourceId', 'resourceExternalId'] },
    { fields: ['identityId', 'identityExternalId'] },
  ],
  fields: {
    resourceId:          { type: 'uuid' },
    resourceExternalId:  { type: 'string', maxLength: 500 },
    identityId:          { type: 'uuid' },
    identityExternalId:  { type: 'string', maxLength: 500 },
    assignmentType:      { type: 'string', enum: ASSIGNMENT_TYPES },
    principalType:       { type: 'string', maxLength: 50 },
    complianceState:     { type: 'string', maxLength: 50 },
    policyId:            { type: 'string', maxLength: 255 },
    state:               { type: 'string', maxLength: 50 },
    assignmentStatus:    { type: 'string', maxLength: 50 },
    expirationDateTime:  { type: 'string' },
    extendedAttributes:  { type: 'json' },
  },
},
```

New route in `ingest.js`:
```javascript
router.post('/ingest/resource-assignments-identity', createIngestHandler('resource-assignments-identity'));
```

### 4.4 identityExternalId resolution (E1)

`identityExternalId` is resolved to a deterministic UUID using the existing
`normalization.js` pattern (line 99) — no normalization changes needed:

```javascript
// Already in normalization.js:
if (rec.identityExternalId && !normalized.identityId) {
  normalized.identityId = deterministicGuid(`${sysPrefix}-identities`, String(rec.identityExternalId));
}
```

The `sysPrefix` comes from the caller's `idPrefix` (e.g. `"MidPoint"`). The identity must
already be in the DB under the same `deterministicGuid` UUID — push identities before
assignments (same ordering contract as `principalExternalId`).

**Ordering contract violation:** If `identityExternalId` resolves to a UUID not in
`Identities`, the assignment row is inserted with a dangling `identityId` — no FK to
enforce integrity. Same behavior as `principalExternalId` with a missing principal.
Prevention: push identities before assignments; the matview INNER JOIN on `IdentityMembers`
means a dangling identity assignment never appears in the matrix.

### 4.5 scopedDelete cross-contamination prevention

Both endpoints write to the same table. A full sync from one endpoint must not delete
rows belonging to the other.

**The bug without this fix:** `scopedDelete()` builds `NOT EXISTS (... t."principalId" = src."principalId" ...)`.
For identity rows where `principalId IS NULL`: `NULL = uuid = false` → `NOT EXISTS = true` →
identity rows deleted by the principal full-sync. Same problem in reverse.

**Fix:** add a `scopeDeleteFilter` option to `ingest()` / `scopedDelete()` that appends
a safe server-side SQL condition to the DELETE WHERE clause:

```javascript
// engine.js — scopedDelete signature change:
export async function scopedDelete(
  client, tableName, keyColumns, tempName,
  systemId, scope, systemIdColumn, tableColumnNames,
  scopeDeleteFilter = null   // ← new optional param
) {
  // ...existing WHERE building...
  if (scopeDeleteFilter) where += ` AND (${scopeDeleteFilter})`;
  // ...
}
```

```javascript
// ingest.js — principal handler passes scopeDeleteFilter to ingest():
await ingest(null, tableName, keyColumns, normalized, {
  syncMode: ..., systemId: ..., scope,
  scopeDeleteFilter: '"principalId" IS NOT NULL',
});

// ingest.js — identity handler:
await ingest(null, tableName, keyColumns, normalized, {
  syncMode: ..., systemId: ..., scope,
  scopeDeleteFilter: '"identityId" IS NOT NULL',
});
```

`ingest()` passes `scopeDeleteFilter` through to `scopedDelete()` via its options.

### 4.6 classify-business-role-assignments fix

The existing `classify-business-role-assignments` endpoint promotes BusinessRole Direct
assignments to Governed. Its dedup DELETE uses `ra2."principalId" = ra."principalId"` —
for identity rows (`principalId IS NULL`), `NULL = NULL = false` so identity Direct rows
are never cleaned up, and the subsequent UPDATE fails with a unique constraint violation
when a Governed row already exists.

Fix the dedup DELETE to handle both key types:

```javascript
// In the DELETE EXISTS subquery — replace the principalId-only check:
AND (
  (ra."principalId" IS NOT NULL AND ra2."principalId" = ra."principalId")
  OR
  (ra."identityId"  IS NOT NULL AND ra2."identityId"  = ra."identityId")
)
```

The UPDATE (`SET "assignmentType" = 'Governed'`) requires no changes — it promotes all
remaining BusinessRole Direct rows regardless of key type.

---

## 5. Matrix View Impact

### 5.1 Expansion strategy

The UNION arm is placed **inside** the `collapsed` CTE, before the `GROUP BY`. This
ensures the existing deduplication absorbs cross-arm duplicates (person with both a
principal-level and an identity-level assignment to the same resource).

```sql
-- In migration 037_matrix_view_identity_support.sql
-- Rebuilds the materialized view to add the identity expansion arm.

-- Drop dependent view first (matches migration 026 pattern; CASCADE would also
-- work but hiding unknown dependents is riskier than being explicit).
DROP VIEW IF EXISTS "vw_UserPermissionAssignments";
DROP MATERIALIZED VIEW IF EXISTS "vw_ResourceUserPermissionAssignments";

CREATE MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments" AS
WITH governed_pairs AS (
    SELECT DISTINCT "resourceId", "principalId"
      FROM "ResourceAssignments"
     WHERE "assignmentType" = 'Governed'
       AND "principalId" IS NOT NULL
),
collapsed AS (
    -- Existing arm: principal-level assignments
    SELECT
        ra."resourceId",
        ra."principalId",
        ra."principalType",
        CASE
          WHEN ra."assignmentType" IN ('Governed', 'OAuth2Grant', 'AppRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                       THEN 'Indirect'
          ELSE ra."assignmentType"
        END AS "membershipType",
        (ra."assignmentType" = 'Governed' OR gp."resourceId" IS NOT NULL) AS "managedByAccessPackage"
    FROM "ResourceAssignments" ra
    LEFT JOIN governed_pairs gp
           ON gp."resourceId"  = ra."resourceId"
          AND gp."principalId" = ra."principalId"
    WHERE ra."principalId" IS NOT NULL

    UNION ALL

    -- New arm: identity-level assignments expanded through IdentityMembers
    SELECT
        ra."resourceId",
        im."principalId",
        NULL AS "principalType",
        CASE
          WHEN ra."assignmentType" IN ('Governed', 'OAuth2Grant', 'AppRole') THEN 'Direct'
          WHEN ra."assignmentType" = 'AppRoleViaGroup'                       THEN 'Indirect'
          ELSE ra."assignmentType"
        END AS "membershipType",
        (ra."assignmentType" = 'Governed') AS "managedByAccessPackage"
    FROM "ResourceAssignments" ra
    JOIN "IdentityMembers" im ON im."identityId" = ra."identityId"
    WHERE ra."identityId" IS NOT NULL
)
SELECT
    "resourceId",
    "principalId",
    MAX("principalType") AS "principalType",
    "membershipType",
    bool_or("managedByAccessPackage") AS "managedByAccessPackage"
FROM collapsed
GROUP BY "resourceId", "principalId", "membershipType"
WITH NO DATA;

CREATE UNIQUE INDEX "ix_vw_ResUserPerm_pk"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId", "principalId", "membershipType");
CREATE INDEX "ix_vw_ResUserPerm_principalId"
    ON "vw_ResourceUserPermissionAssignments" ("principalId");
CREATE INDEX "ix_vw_ResUserPerm_resourceId"
    ON "vw_ResourceUserPermissionAssignments" ("resourceId");

CREATE VIEW "vw_UserPermissionAssignments" AS
SELECT
    "resourceId"  AS "groupId",
    "principalId" AS "memberId",
    "principalType",
    "membershipType",
    "managedByAccessPackage"
FROM "vw_ResourceUserPermissionAssignments";
```

**Row expansion behaviour.** An identity-level assignment for a person with 3 principals
produces 3 expanded rows `(resourceId, principal_AD, type)`, `(resourceId, principal_SAP, type)`,
`(resourceId, principal_Oracle, type)`. This is correct IGA behaviour: the business role
reaches each account. The matrix renders one cell per account — expected.

### 5.2 No expansion for identity-only orgs

If an identity has no `IdentityMembers` rows (e.g. no account linking has run yet), the
`INNER JOIN` produces zero rows for that assignment. No phantom access. The assignment is
visible in the admin stats (E3) even though it doesn't appear in the matrix.

---

## 6. Admin Stats (E3)

Extend the stats query in `admin.js` to include identity-level assignment count:

```javascript
// In the existing stats SELECT (around line 608):
(SELECT COUNT(*)::int FROM "ResourceAssignments" WHERE "identityId" IS NOT NULL) AS "identityAssignments",
```

Displayed alongside `governedAssignments` in the admin panel. Provides immediate
post-deploy verification that IGA crawlers are pushing identity-level assignments.

---

## 7. Scope

### In scope

- Migration `036_resource_assignments_identity_support.sql` — schema change
- Migration `037_matrix_view_identity_support.sql` — matview rebuild with identity arm (DROP VIEW first)
- `app/api/src/ingest/validation.js` — new `resource-assignments-identity` entity type + XOR validation on `resource-assignments`
- `app/api/src/routes/ingest.js` — new `/ingest/resource-assignments-identity` route + `scopeDeleteFilter` on both RA handlers + classify fix
- `app/api/src/ingest/engine.js` — `scopeDeleteFilter` option in `ingest()` + `scopedDelete()`
- `app/api/src/routes/admin.js` — `identityAssignments` stat
- `changes/<branch>.md` — changelog fragment

### NOT in scope

| Item | Rationale |
|---|---|
| Provisioning / effective-access engine | Separate spec already approved; this spec only stores the assignment |
| UI badge distinguishing identity-level vs principal-level origin | Deferred — ship data model first, add visual distinction in follow-up PR |
| Diagnostic stat for identity assignments with no linked principals | Skip — operators can query psql directly |
| FK constraints on `principalId` / `identityId` | Deferred — both columns are currently bare UUIDs; add FKs together in a later migration once both sides are ready |

### What already exists (reuse, don't rebuild)

| Existing thing | How it's reused |
|---|---|
| `normalization.js` line 99 | `identityExternalId` → `deterministicGuid` already implemented — no changes |
| `engine.js` `ingest()` + `scopedDelete()` | Reused with new `scopeDeleteFilter` option; minimal structural change |
| `createIngestHandler()` | Both endpoints use the same factory function — identity endpoint gets its own entity type |
| `IdentityMembers` table | JOIN target for the matrix UNION arm — no changes |
| Migration 026 GROUP BY dedup + DROP VIEW pattern | Identity arm UNION goes inside `collapsed` CTE for free dedup; DROP VIEW pattern reused exactly |

---

## 8. Migration Strategy

| Step | Who | When |
|---|---|---|
| Apply migrations 036 + 037 | DB migration runner at container startup | Automatically on deploy |
| Existing crawlers (Entra, AD, CSV) | No change needed | — |
| IGA crawlers (Omada, MidPoint) | Switch any assignment where the source system's subject is a person to `/ingest/resource-assignments-identity` (use `identityId` / `identityExternalId` instead of `principalId`). Account-level assignments (shadow memberships, entitlements assigned to a specific account) stay on `/ingest/resource-assignments`. | After this ships |

The migrations are **non-destructive**: no data loss, no column removals, no breaking changes
to existing `principalId` paths. Brief exclusive lock during 035 on container startup.

---

## 9. Dream State Delta

```
CURRENT STATE              THIS PLAN                       12-MONTH IDEAL
-----------------          -----------------------         -----------------
All assignments target      Assignments can target          Effective-access engine
principalId only.           identityId OR principalId.      reads identity-level
IGA crawlers can't          Ingest API accepts both +       assignments, expands
express "person has         identityExternalId.             via IdentityMembers,
business role" without      Matrix expands identity         computes effective
picking one account.        rows through IdentityMembers.   access per scope node.
                            MidPoint/Omada crawlers          One person. One view.
                            emit identity-level              All systems.
                            assignments (any resource).
```

---

## 10. Implementation Tasks

- [x] **T1 (P1)** — DB — Write migration `036_resource_assignments_identity_support.sql`
  - Files: `app/api/src/db/migrations/036_resource_assignments_identity_support.sql`

- [x] **T2 (P1)** — DB — Write migration `037_matrix_view_identity_support.sql`
  - Files: `app/api/src/db/migrations/037_matrix_view_identity_support.sql`

- [x] **T3 (P1)** — API — Add `resource-assignments-identity` entity type to validation.js
  - Files: `app/api/src/ingest/validation.js`

- [x] **T4 (P1)** — API — Add identity route + scopeDeleteFilter + classify fix to ingest.js + sessions.js
  - Files: `app/api/src/routes/ingest.js`, `app/api/src/ingest/sessions.js`

- [x] **T5 (P1)** — API — Add `scopeDeleteFilter` option to engine.js
  - Files: `app/api/src/ingest/engine.js`

- [x] **T6 (P2)** — API — Add `identityAssignments` admin stat
  - Files: `app/api/src/routes/admin.js`

- [ ] **T7 (P1)** — Tests — Add ingest + matview + engine tests
  - Files: `app/api/src/ingest/validation.test.js`, `app/api/src/ingest/engine.test.js`, nearest ingest integration test
  - Tests:
    1. identity batch to `/resource-assignments-identity` accepted
    2. principal batch to `/resource-assignments` still works
    3. XOR validation: record with both `principalId` AND `identityId` → 400
    4. `identityExternalId` resolves to deterministic UUID
    5. full-sync scopedDelete removes stale identity rows AND does not touch principal rows
    6. full-sync scopedDelete on principal endpoint does not touch identity rows
    7. cross-arm dedup: person has both principal-level and identity-level assignment → single matrix row
    8. identity with no IdentityMembers → zero matrix rows, not an error
    9. classify endpoint: identity Direct + existing Governed → dedup DELETE fires, no constraint error
    10. classify endpoint: identity Direct with no Governed → promoted to Governed correctly
    11. session path: identity batch using syncSession start/continue/end uses correct keyColumns

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 2 | CLEAR | SELECTIVE EXPANSION: 3 proposals, 2 accepted (identityExternalId, admin stat); problem statement refined (IGA identity model, technical accounts, multi-account-per-system) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 7 issues found, all resolved: DROP VIEW missing (P1), XOR validation gap (P1), two-endpoint design replacing batch detection (P1 + architectural decision), scopedDelete cross-contamination (P1), classify endpoint NULL=NULL bug (P2), FK asymmetry resolved by removing identityId FK (P2), identityExternalId failure mode documented |
| Outside Voice | Claude subagent | Independent 2nd opinion | 1 | issues_found | 6 points; 1 false positive (managedByAccessPackage misread); 1 already covered (principalId FK); 4 real: DROP VIEW, XOR, scopedDelete, externalId failure — all resolved above |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | SKIPPED — no UI scope |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** CEO + ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS

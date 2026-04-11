# Governance Model

Identity Atlas supports business roles, certification reviews, and access policies from any IGA platform — not just Entra ID. The governance model is unified with the resource model: business roles **are** Resources, their assignments **are** ResourceAssignments, and their resource grants **are** ResourceRelationships. Only governance-specific metadata (policies, requests, certification decisions) lives in dedicated tables.

---

## Overview

In v3.1, the governance model was merged into the universal resource model. The practical effect is that business roles from any IGA platform participate in the same views, risk scores, and queries as Entra ID groups and directory roles — without a separate schema.

The unification uses discriminator columns:

- `Resources.resourceType = 'BusinessRole'` — identifies business roles among all resources
- `ResourceAssignments.assignmentType = 'Governed'` — identifies governed assignments among all assignments
- `ResourceRelationships.relationshipType = 'Contains'` — identifies resource grants among all relationships

The four governance-specific tables (`GovernanceCatalogs`, `AssignmentPolicies`, `AssignmentRequests`, `CertificationDecisions`) contain only data that has no place in the shared model.

!!! info "Breaking change from v3.0"
    In v3.0, governance used seven separate tables: GovernanceCatalogs, BusinessRoles, BusinessRoleResources, BusinessRoleAssignments, BusinessRolePolicies, BusinessRoleRequests, and CertificationDecisions. In v3.1, three of those were absorbed into the shared resource model. Existing v3.0 deployments must re-sync to populate the unified tables.

---

## Governance Entity Diagram

```mermaid
erDiagram
    GovernanceCatalogs {
        guid id PK
        string displayName
        string description
    }
    Resources {
        guid id PK
        string displayName
        string resourceType
        guid catalogId FK
        bool isHidden
    }
    ResourceAssignments {
        guid resourceId FK
        guid principalId FK
        string assignmentType
        guid policyId
        string state
        string assignmentStatus
        datetime expirationDateTime
    }
    ResourceRelationships {
        guid parentResourceId FK
        guid childResourceId FK
        string relationshipType
        string roleName
        string roleOriginSystem
    }
    AssignmentPolicies {
        guid id PK
        guid resourceId FK
        string displayName
        jsonb policyConditions
        bool hasAutoAddRule
        bool hasAutoRemoveRule
        bool hasAccessReview
    }
    AssignmentRequests {
        guid id PK
        guid resourceId FK
        guid requestorId
        string requestType
        string requestState
        string requestStatus
        string justification
        datetime createdDateTime
        datetime completedDateTime
    }
    CertificationDecisions {
        guid id PK
        guid resourceId FK
        guid principalId
        string decision
        string recommendation
        string justification
        guid reviewedBy
        datetime reviewedDateTime
        guid reviewDefinitionId
        guid reviewInstanceId
        string reviewInstanceStatus
    }

    GovernanceCatalogs ||--o{ Resources : "contains (BusinessRole)"
    Resources ||--o{ ResourceAssignments : "assignmentType=Governed"
    Resources ||--o{ ResourceRelationships : "relationshipType=Contains"
    Resources ||--o{ AssignmentPolicies : "governed by"
    Resources ||--o{ AssignmentRequests : "requested via"
    Resources ||--o{ CertificationDecisions : "reviewed via"
```

---

## IGA Platform Mapping

The same governance tables absorb data from any IGA platform. The source platform determines the sync method; the model is always the same.

| Concept | Entra ID | Omada | SailPoint | Table |
|---|---|---|---|---|
| Catalog / Container | Catalog | — | Source | `GovernanceCatalogs` |
| Business Role | Access Package | Business Role | Access Profile | `Resources` (`resourceType = 'BusinessRole'`) |
| Resource Grant | Resource Role Scope | Role Entitlement | Entitlement | `ResourceRelationships` (`relationshipType = 'Contains'`) |
| Assignment | AP Assignment | Role Assignment | Access Request Result | `ResourceAssignments` (`assignmentType = 'Governed'`) |
| Policy | Assignment Policy | Assignment Policy | Access Request Config | `AssignmentPolicies` |
| Request | AP Assignment Request | — | Access Request | `AssignmentRequests` |
| Certification | Access Review Decision | CRA | Certification | `CertificationDecisions` |

---

## Governance-Specific Columns

The unified model extends the three shared tables with extra columns that carry governance semantics. These columns are `NULL` for non-governance rows, so they do not break existing queries.

`Initialize-FGGovernanceTables` adds these columns if they are not already present.

### Resources (business roles)

| Column | Type | Purpose |
|---|---|---|
| `catalogId` | GUID | Links the business role to its `GovernanceCatalogs` parent |
| `isHidden` | BIT | Hides the business role from self-service request portals |

### ResourceAssignments (governed assignments)

| Column | Type | Purpose |
|---|---|---|
| `policyId` | GUID | The `AssignmentPolicies` row that granted this assignment |
| `state` | NVARCHAR(50) | Lifecycle state: `Delivered`, `Expired`, `PendingApproval`, etc. |
| `assignmentStatus` | NVARCHAR(100) | Finer-grained status from the source IGA platform |
| `expirationDateTime` | DATETIME2 | When the assignment expires (NULL = no expiry) |

### ResourceRelationships (business role resource grants)

| Column | Type | Purpose |
|---|---|---|
| `roleName` | NVARCHAR(100) | The role within the target resource: `Member` or `Owner` |
| `roleOriginSystem` | NVARCHAR(100) | Which system defined this role (e.g. `EntraID`, `Omada`) |

---

## IST vs SOLL Analysis

Identity Atlas uses IST/SOLL terminology to express the gap between actual access and governed access.

**SOLL (should-be state)**
Access granted through a business role. Rows in `ResourceAssignments` where `assignmentType = 'Governed'`. This is access that was formally requested, approved, and periodically reviewed.

**IST (as-is state)**
Direct access assignments outside governance. Rows in `ResourceAssignments` where `assignmentType = 'Direct'`. This is access that exists but was not channeled through the IGA process.

**The gap**
Users who have direct membership to a group that is also granted by a business role. They have the access, but not through the approved channel. This is the primary finding that role mining and certification campaigns aim to remediate.

The following SQL views expose the IST/SOLL picture:

```sql
-- All access assignments outside business role governance
SELECT * FROM vw_UnmanagedPermissions;

-- A principal's full access picture: every assignment and how it was granted
SELECT *
FROM vw_ResourceUserPermissionAssignments
WHERE principalId = 'your-user-guid-here';
```

!!! tip "Matrix view IST/SOLL toggle"
    The Role Mining UI matrix view has an IST/SOLL toggle in the toolbar. SOLL filters to governed assignments only; IST filters to direct (unmanaged) assignments only; All shows both. The underlying queries use `assignmentType` to implement this filter.

---

## Certification Review Flow

```mermaid
flowchart LR
    A[Business Role\nresourceType=BusinessRole] --> B{Has policy with\nreview configured?}
    B -->|No| C[Not required]
    B -->|Yes| D{Any review\ninstances created?}
    D -->|No| E[Pending first review]
    D -->|Yes| F{Last review\ndecision?}
    F --> G[Approved / Denied /\nSystem-completed]
    F --> H{Review\ndeadline passed?}
    H -->|Yes| I[Missed]
    H -->|No| J[In progress]
```

Certification decisions are stored in `CertificationDecisions`. The `certificationScopeType` column distinguishes what was reviewed:

| certificationScopeType | Meaning |
|---|---|
| `BusinessRole` | The entire business role assignment was reviewed |
| `ResourceAssignment` | A specific resource within the business role was reviewed |

The UI differentiates two states that might otherwise appear identical:

- **Not required** — no review policy is configured for this business role
- **Pending first review** — a review policy exists, but no review instance has been created yet

---

## How governance data is ingested

You don't call any sync functions by hand. In v5, every governance-related table is populated by a **crawler** — configured in the browser, running in the worker container, and posting its data through the [Ingest API](../architecture/ingest-api.md). The UI does the orchestration for you; there is no PowerShell command to memorise.

### Entra ID

The built-in Entra ID crawler (**Admin → Crawlers → Add Crawler → Entra ID**) pulls the full governance graph from Microsoft Graph in one pass:

| Graph resource | Target table (`filter`) |
|---|---|
| Access package catalogs | `GovernanceCatalogs` |
| Access packages | `Resources` (`resourceType = BusinessRole`) |
| Access package assignments | `ResourceAssignments` (`assignmentType = Governed`) |
| Access package resource scopes | `ResourceRelationships` (`relationshipType = Contains`) |
| Access package assignment policies | `AssignmentPolicies` |
| Access package assignment requests | `AssignmentRequests` |
| Access package access reviews | `CertificationDecisions` |

The crawler requires the `EntitlementManagement.Read.All` and `AccessReview.Read.All` Graph permissions; the wizard validates both during setup. See [Entra ID sync](../sync/entra-id.md) for the step-by-step flow.

### Other IGA platforms (Omada, SailPoint, etc.)

For any non-Entra source, the **CSV crawler** imports data against the canonical Identity Atlas CSV schema. Each IGA platform gets a small transform script that converts its native export to the canonical schema, which is then uploaded through the wizard (**Admin → Crawlers → Add Crawler → CSV**). The CSV crawler writes to the same governance tables as the Entra ID crawler — the only difference is the `System.Name` column identifying the source system.

Canonical CSV schemas and an Omada-to-Identity-Atlas transform are both in the repo: see [CSV Import Schema](../architecture/csv-import-schema.md) and [CSV Import](../sync/csv-import.md).

---
type: concept
prereq: concepts/data-model.md
outcome: You can tell designed access from accumulated access, and know where each is stored.
---

# Governance Model

!!! info "Before this page"
    Assumes you have read **[Data Model](./data-model.md)**.
    Brand new? Start at [The words you need first](../start/glossary.md).

Identity Atlas supports business roles, certification reviews, and access policies from any IGA platform — not just Entra ID. The governance model is unified with the resource model: business roles **are** Resources, their assignments **are** ResourceAssignments, and their resource grants **are** ResourceRelationships. Only governance-specific metadata (policies, requests, certification decisions) lives in dedicated tables.

---

## Overview

In v3.1, the governance model was merged into the universal resource model. The practical effect is that business roles from any IGA platform participate in the same views, risk scores, and queries as Entra ID groups and directory roles — without a separate schema.

The unification uses discriminator columns:

- `Resources.resourceType = 'BusinessRole'` — identifies business roles among all resources
- `ResourceAssignments.governed = true` — flags governed assignments among all assignments (the `assignmentType` stays one of the three universal values `Direct` / `Indirect` / `Eligible`)
- `ResourceRelationships.relationshipType = 'Contains'` — identifies resource grants among all relationships

The three governance-specific tables (`AssignmentPolicies`, `AssignmentRequests`, `CertificationDecisions`) contain only data that has no place in the shared model.

A **catalog** — the container a governance source groups its business roles in — is a synced context of the `Catalog` template (`contextCategory = 'Catalog'`), not a table of its own. Its members are the business roles it holds, the source's catalog properties sit in its `extendedAttributes`, and the people who answer for it are its Accountable and Responsible. The UI calls them **role portfolios**: they have their own **Role portfolios** tab on the Contexts page, and someone who is Accountable or Responsible for one finds it on the same sub-tab of their owner page (see [Context-owner access](../architecture/context-owner-access.md)). Until migration 117 they lived in a `GovernanceCatalogs` table with a `Resources.catalogId` pointer; that table is gone and the next crawl writes the catalogs again as contexts.

!!! info "Breaking change from v3.0"
    In v3.0, governance used seven separate tables: GovernanceCatalogs, BusinessRoles, BusinessRoleResources, BusinessRoleAssignments, BusinessRolePolicies, BusinessRoleRequests, and CertificationDecisions. In v3.1, three of those were absorbed into the shared resource model. Existing v3.0 deployments must re-sync to populate the unified tables.

---

## Governance Entity Diagram

<!-- ontology: validated -->
```mermaid
erDiagram
    Contexts {
        guid id PK
        string displayName
        string contextCategory
    }
    ContextMembers {
        guid contextId FK
        string memberType
        guid memberId FK
    }
    Resources {
        guid id PK
        string displayName
        string resourceType
        bool isHidden
    }
    ResourceAssignments {
        guid resourceId FK
        guid principalId FK
        string assignmentType
        bool governed
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

    Contexts ||--o{ ContextMembers : "contextCategory=Catalog"
    ContextMembers }o--|| Resources : "BusinessRole"
    Resources ||--o{ ResourceAssignments : "governed=true"
    Resources ||--o{ ResourceRelationships : "relationshipType=Contains"
    Resources |o--o{ AssignmentPolicies : "governed by"
    Resources |o--o{ AssignmentRequests : "requested via"
    Resources |o--o{ CertificationDecisions : "reviewed via"
```

---

## IGA Platform Mapping

The same governance tables absorb data from any IGA platform. The source platform determines the sync method; the model is always the same.

| Concept | Entra ID | Omada | SailPoint | Table |
|---|---|---|---|---|
| Catalog / Container | Catalog | — | Source | `Contexts` (`contextCategory = 'Catalog'`), members in `ContextMembers` |
| Business Role | Access Package | Business Role | Access Profile | `Resources` (`resourceType = 'BusinessRole'`) |
| Resource Grant | Resource Role Scope | Role Entitlement | Entitlement | `ResourceRelationships` (`relationshipType = 'Contains'`) |
| Assignment | AP Assignment | Role Assignment | Access Request Result | `ResourceAssignments` (`governed = true`) |
| Policy | Assignment Policy | Assignment Policy | Access Request Config | `AssignmentPolicies` |
| Request | AP Assignment Request | — | Access Request | `AssignmentRequests` |
| Certification | Access Review Decision | CRA | Certification | `CertificationDecisions` |

---

## Governance-Specific Columns

The unified model extends the three shared tables with extra columns that carry governance semantics. These columns are `NULL` for non-governance rows, so they do not break existing queries.

These columns are created by the PostgreSQL migrations (`001_core_schema.sql`, `047_governed_assignment_flag.sql`).

### Resources (business roles)

| Column | Type | Purpose |
|---|---|---|
| `isHidden` | BOOLEAN | Hides the business role from self-service request portals |

### ResourceAssignments (governed assignments)

| Column | Type | Purpose |
|---|---|---|
| `governed` | BOOLEAN | `true` marks the assignment as governed (channelled through an IGA business role / access package). Defaults to `false`. This flag — not a dedicated `assignmentType` — is what distinguishes governed access from direct access |
| `policyId` | UUID | The `AssignmentPolicies` row that granted this assignment |
| `state` | TEXT | Lifecycle state: `Delivered`, `Expired`, `PendingApproval`, etc. |
| `assignmentStatus` | TEXT | Finer-grained status from the source IGA platform |
| `expirationDateTime` | TIMESTAMPTZ | When the assignment expires (NULL = no expiry) |

### ResourceRelationships (business role resource grants)

| Column | Type | Purpose |
|---|---|---|
| `roleName` | TEXT | The role within the target resource: `Member` or `Owner` |
| `roleOriginSystem` | TEXT | Which system defined this role (e.g. `EntraID`, `Omada`) |

---

## How a business role is gained and lost

A business role's assignment policies (`AssignmentPolicies`) say how a person comes to hold it and how they lose it. Identity Atlas derives both from the policies when it reads them; nothing extra is stored. A role can have several of each at once.

| Ways in | Meaning |
|---|---|
| `Rule` | A rule hands the role to everyone who matches it |
| `Request` | Someone can request the role, for themselves or for another person, with or without approval |
| `Assigned` | An administrator assigns the role directly |

| Ways out | Meaning |
|---|---|
| `Rule` | The role is removed when a person no longer matches a rule |
| `Review` | An access review can remove the role |
| `Expiry` | The assignment ends by itself after a date or a duration |
| `Manual` | Someone can request the role's removal |

`Unknown` means the source does not say. A role whose policies state that nothing removes access has no way out at all.

From these follows the role's **type**:

- **Rule based** (`Automatic`): a rule alone hands the role out and a rule takes it away. Nobody decides who holds it, so its holders need no periodic review, only what it contains does.
- **Manual**: anything else, including a rule that adds people but does not remove them. A person decides who holds it, so it needs a periodic review; a Manual role with no `Review` way out is flagged as a review gap.
- **Unknown**: the source does not say how the role is gained.

The same reasoning applies to one person's holding: someone a policy both adds and removes by rule is held automatically, everyone else is the part a review has to cover. The vocabularies are defined in the core ontology (`AccessWayIn`, `AccessWayOut`, `BusinessRoleControl`); the business roles list returns them as `accessModel` (see the [Governance API](../api/governance.md)).

---

## IST vs SOLL Analysis

Identity Atlas uses IST/SOLL terminology to express the gap between actual access and governed access.

**SOLL (should-be state)**
Access granted through a business role. Rows in `ResourceAssignments` where `governed = true`. This is access that was formally requested, approved, and periodically reviewed.

**IST (as-is state)**
Direct access assignments outside governance. Rows in `ResourceAssignments` where `governed = false` (typically `assignmentType = 'Direct'`). This is access that exists but was not channeled through the IGA process.

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
    The Role Mining UI matrix view has an IST/SOLL toggle in the toolbar. SOLL filters to governed assignments only; IST filters to direct (unmanaged) assignments only; All shows both. The underlying queries use the `governed` flag to implement this filter.

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

## Doing a review

Identity Atlas **reports on** certifications — it does not **conduct** them. There is no reviewer-decision screen or approve/deny endpoint in the product; the `CertificationDecisions` table is a **read-only mirror** ingested from the source IGA platform (e.g. Entra ID Access Reviews). Its only write path is the crawler ingest (`POST /api/ingest/governance/certifications`), which replaces the mirror on each sync — nothing in Identity Atlas ever authors a decision.

So a review is done **in the source system**, not here:

- **Make the actual decisions** in the IGA platform that owns the campaign — for Entra ID, that's **Access Reviews** in the Microsoft Entra admin center; for Omada or SailPoint, their own certification / recertification screens. Approvals, denials, and completions all happen there.
- **Re-sync** the Entra ID (or CSV) crawler to pull the updated decisions back into `CertificationDecisions`.
- **Track compliance in Identity Atlas** using the read-only review-compliance view — per-access-package last-review status (Compliant / In Progress / Reviewed Late / Missed), backed by the `GET /api/governance/review-compliance` and `GET /api/governance/summary` endpoints (see the [Governance API](../api/governance.md)). Use it to find which business roles are overdue or were reviewed late, then drive the next campaign in the source system.

### Reviewing what a business role contains

The one review Identity Atlas does hold itself is a **composition review**: at the top of a business role's **Requests & reviews** tab, **Review this role** opens a wizard. It reviews the role itself — who answers for it, how people get and lose it, and what it contains — not each person who holds it, so it does not replace the access reviews above.

The wizard has one screen per step, and a last one to sign:

1. **Who answers for it** — the Accountable and Responsible people as they are now.
2. **Lifecycle** — how people get, keep and lose the role: the rules, who approves a request and who reviews the holders, each shown only where it applies. Who has the role now, and who lost it in the last 90 days, is one click away.
3. **Permissions** — the resources the role contains.
4. **Improvements** — what role mining suggests to make the role better (see below), each to propose, decline or ask about.
5. **Sign** — what you said per step, room for general comments, and the signature.

On each of the first three steps you choose **Good**, **Needs a change** or **I do not understand what I am reading**. A change needs saying what should change; "I do not understand" may carry your question. On the first step a change can instead name the people it should be, picked from the directory.

- **A review is a review, not a change.** Proposed owners are stored with the review as a proposal; nothing on the role changes. Signing does not mean agreeing: a review whose steps are all good reads **no findings**, any other reads the number of findings.
- A review is an object of its own, linked to the role, and never changed after it is signed: one verdict per step with its remark, the general comments, who signed (the signed-in user's e-mail or user name, and their display name), when, and a **snapshot** of the role at that moment — its type and ways in and out, how many held it, who was Accountable and Responsible, who approved requests and reviewed the holders, its assignment policies with their rules, and the resources it contained (name, type, system).
- The tab shows every review with what it said per step and **What was reviewed** (the snapshot, as it was), and for the latest review what changed since: resources added or removed, a different type, a changed policy or rule, or other people answering for it.
- A review holds the steps that were asked: all four, or those a review campaign asks.
- It lives in its own tables, `BusinessRoleCompositionReviews` and `BusinessRoleCompositionReviewSteps` (migrations 116, 120 and 122), never in `CertificationDecisions`, so a crawler sync cannot overwrite it and it is never mistaken for a decision from the source.
- It is **experimental** and off by default: switch it on under **Admin → Experimental → Composition review**. While it is off the section is hidden and its endpoints answer 404; reviews already saved are kept.

#### The improvements step: role mining without guessing

The fourth step looks at who holds the role and what else they have, and suggests a change only when it is **at least 95% sure** — without AI, by counting. How sure is the overlap between two groups of people: those who hold the role, and those a suggestion is about. Everyone in both groups, divided by everyone in either; one person too many or too few lowers it. Three kinds of suggestion:

- **Add a permission everyone has.** A permission every holder of the role has themselves (directly, not through another group), that nobody else has, and that no business role contains yet — an exact match, 100%.
- **Add a new permission that nearly everyone has.** The same, within 95% of exact, but only for a permission created since the last review of the role (or, when nobody reviewed it yet, in the last 90 days). An old near match was most likely left out on purpose, so it is not suggested.
- **Hand the role out by a rule.** For a role handed out by hand — no assignment policy with an automatic rule, and nobody holding it by one: a rule on department, job title and/or company that would pick the people who hold it, at least 95% right. The fewest conditions win.

Nothing is suggested for a role held by fewer than 5 people: an exact match among a handful of people is as often a coincidence. Roles, applications, app registrations, consents, app-only permissions, ownership and dynamic groups (whose members a rule keeps, such as the AutoAssignment_ groups Entra makes for automatic assignment policies) are never suggested as a permission. When nothing comes that close, the step says so: **Role mining found no improvements for this role.**

Per suggestion the reviewer chooses **Propose this**, **Not for this role** or **I do not understand this** (with a question). Proposing anything makes the step a finding; like a proposed owner, it is a proposal and changes nothing. The suggestions are worked out again when the review is signed and stored with the review as they were then, each with its decision. A suggestion declined in the last review is not asked again. Who may review the role may ask for its suggestions (`GET /api/access-package/:id/composition-reviews/improvements`).
- Reviewing needs the **Certification decisions** permission (`data.write.certifications`) — or answering for the role (its **Accountable** or **Responsible**, through any of your accounts) where **Admin → Roles & Permissions → Relative permissions** ticks **Composition review** for their role (Accountable or Responsible) on the Business roles row. Anyone who can read data sees the reviews (`GET` / `POST /api/access-package/:id/composition-reviews`). Whoever may review a role may also look up people to propose as its owner (`GET /api/access-package/:id/composition-reviews/people?search=`): name and e-mail of at most ten matching user accounts.
- In the ontology it is `ia:CompositionReview` with its `ia:CompositionReviewStep`s ([core model](../reference/core-model.md)).

### Review campaigns

A **review campaign** asks people to do that composition review, instead of waiting for them to think of it. You set one up on the top-level **Reviews** tab (permission **Review campaigns**, `data.write.review-campaigns`; experimental, part of Composition review — the tab shows only while that is on, and only to whoever holds the permission):

- **What to review** — any of the four steps: who answers for the role, its lifecycle, its permissions, the improvements role mining suggests. The wizard then shows only those.
- **Which business roles** — whole **role portfolios**, business roles one by one, or both. A portfolio is read again when each round starts, so a role added to it joins the next round.
- **When** — once, or on a schedule (every month, quarter, half year or year), from a start date, with a number of days to do the review.

**Who is asked** is the **Accountable** of each role — whoever that is at the moment of looking, so a new Accountable inherits the request. A role with **nobody Accountable** is in scope but **outside the campaign**: nobody is asked. The form says how many such roles there are before you start, the list counts them, and the campaign shows them apart with a note to set an Accountable.

What the Accountable sees: after signing in, a notice right under the header — how many business roles wait for their review, by when, and a button per role. The role is marked under **Role portfolios**, its page says which campaign asks and by when, and **Start the review** opens the wizard. Nothing is sent: no e-mail, no message.

- **Being asked is the right to answer.** An Accountable asked by a campaign may do that review also where the relative permissions give their role no Composition review. Signing in and opening the role is still the relative permissions' (View for Accountable on the Business roles row); the campaign warns when that is off.
- **One review answers the request.** The review of the asked person closes every open request for that role whose campaign asked no step the review left out. A review by somebody else (an analyst with the Certification decisions permission) is a review of the role, but answers no request.
- **Rounds.** Each time a campaign asks is a round, due at the end of its last day. A request not answered by then reads **Late** and stays open until the next round starts; only the newest round is open. A round is made the first time anybody looks on or after its first day.
- **Progress** per role: waiting, late, reviewed without findings, reviewed with findings, or nobody to ask. **End the campaign** stops asking and closes its open requests; **Delete** removes the campaign with its rounds. The reviews themselves always stay.
- In the ontology: `ia:ReviewCampaign`, `ia:ReviewCampaignScope`, `ia:ReviewCampaignRound` and `ia:ReviewCampaignRequest` (migration 121).

---

## How governance data is ingested

You don't call any sync functions by hand. In v5, every governance-related table is populated by a **crawler** — configured in the browser, running in the worker container, and posting its data through the [Ingest API](../architecture/ingest-api.md). The UI does the orchestration for you; there is no PowerShell command to memorise.

### Entra ID

The built-in Entra ID crawler (**Admin → Crawlers → Add Crawler → Entra ID**) pulls the full governance graph from Microsoft Graph in one pass:

| Graph resource | Target table (`filter`) |
|---|---|
| Access package catalogs | `Contexts` (`contextCategory = Catalog`, `contextType = AccessPackageCatalog`), the access packages as `ContextMembers` |
| Catalog owners and managers | `ContextRoles` on the catalog: a catalog's only owner is `Accountable`; with several owners each is `Responsible`, and every access package manager and access package assignment manager is `Responsible`. Catalog readers are left out |
| Access packages | `Resources` (`resourceType = BusinessRole`) |
| Access package assignments | `ResourceAssignments` (`governed = true`) |
| Access package resource scopes | `ResourceRelationships` (`relationshipType = Contains`) |
| Access package assignment policies | `AssignmentPolicies` |
| Access package assignment requests | `AssignmentRequests` |
| Access package access reviews | `CertificationDecisions` |

The crawler requires the `EntitlementManagement.Read.All` and `AccessReview.Read.All` Graph permissions; the wizard validates both during setup. See [Entra ID sync](../sync/entra-id.md) for the step-by-step flow.

### Other IGA platforms (Omada, SailPoint, etc.)

For any non-Entra source, the **CSV crawler** imports data against the canonical Identity Atlas CSV schema. Each IGA platform gets a small transform script that converts its native export to the canonical schema, which is then uploaded through the wizard (**Admin → Crawlers → Add Crawler → CSV**). The CSV crawler writes to the same governance tables as the Entra ID crawler — the only difference is the `System.Name` column identifying the source system.

Canonical CSV schemas and an Omada-to-Identity-Atlas transform are both in the repo: see [CSV Import Schema](../architecture/csv-import-schema.md) and [CSV Import](../sync/csv-import.md).

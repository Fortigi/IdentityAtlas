# Features

The four pillars, written in benefit language. Each links to the reference docs
for exact detail.

## 1. Unified permission model

**What it means for you:** every system's permissions live in one schema, so you
can query and compare across them instead of stitching exports together.

- Systems, Resources, Principals, ResourceAssignments, ResourceRelationships —
  one model for groups, directory roles, app roles, SharePoint sites, SAP
  authorizations, and business roles alike.
- Full, row-level audit history: every change is captured as a snapshot you can
  query over time.
- Business roles, governed assignments, and resource grants share the same tables
  as direct permissions — no parallel universe for governance data.

*Detail: [Data Model](../concepts/data-model.md), [Audit History](../architecture/audit-history.md).*

## 2. Role-mining UI

**What it means for you:** analysts review access visually, the way they think
about it — not by reading SQL.

- A **permission matrix**: principals as rows, business roles as columns, colored
  by access package, with Direct / Indirect / Eligible membership badges.
- **IST vs. SOLL**: filter to actual (unmanaged) or governed access to surface
  drift between what is and what should be.
- **Entity detail pages** for users, groups, resources, and business roles — every
  attribute, current memberships, and a version-history diff.
- **Certifications and reviews**: decisions, approval timelines, pending requests.
- Excel export, drag-and-drop row reordering, and server-side scaling for large
  tenants.

*Detail: [Role Mining UI](../ui/overview.md), [Matrix](../api/matrix.md).*

## 3. Identity risk scoring

**What it means for you:** every identity gets a defensible risk score, and your
sensitive data never leaves your environment.

- **LLM-assisted, privacy-preserving**: the model discovers organizational context
  from *public* domain information only — no identity data is sent externally.
- **Industry-tuned classifiers** generated for your organization.
- **Four-layer scoring**: direct classifier match → membership analysis →
  structural hygiene → cross-entity propagation, producing tiers from Critical
  (90–100) to None (0).
- **Non-human identity detection**: Copilot Studio agents, managed identities,
  workload identities, and other service principals.
- **Analyst overrides** with mandatory reasoning, stored with a full audit trail.
- **Multi-provider**: Anthropic Claude, OpenAI, and Azure OpenAI.

*Detail: [Risk Scoring Overview](../risk-scoring/overview.md), [Classifiers](../risk-scoring/classifiers.md).
Note: scoring layers 3–4 are still being completed — describe what ships today.*

## 4. Multi-system governance

**What it means for you:** governance data from any IGA platform sits alongside raw
permissions, in one model.

- Native sync for **Entra ID**: users, groups, PIM eligibility, app roles,
  directory roles, access packages, access reviews.
- **CSV import** for Omada, SailPoint, SAP/Pathlock, SharePoint, Azure RBAC, DevOps —
  a fixed, documented canonical schema.
- **Ingest API** for building custom crawlers in any language.

*Detail: [Governance Model](../concepts/governance-model.md), [CSV Import](../sync/csv-import.md),
[Ingest API](../architecture/ingest-api.md).*

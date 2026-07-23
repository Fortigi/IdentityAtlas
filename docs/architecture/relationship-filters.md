# Relationship Filters

The entity list pages (Principals / AI Agents, Resources / Groups) let you filter
not only by **attributes on the object** (name, department, resource type, …) but
also by whether the object **has or lacks a relationship** to something else —
for example "AI agents without an owner", "groups without an owner", or "groups
without any members".

## Using it

In the list's **"+ Add filter"** control, alongside the attribute fields you'll
see relationship fields:

| List | Field | Meaning |
|------|-------|---------|
| Principals / **AI Agents** | **Has owner** | The principal has (Yes) / lacks (No) an owner |
| Resources / **Groups** | **Has owner** | The resource has (Yes) / lacks (No) an owner |
| Resources / **Groups** | **Has members** | The resource has (Yes) / lacks (No) members |

Pick the field, choose **Yes** or **No**, and it combines (AND) with your other
filters. A relationship field only appears when the underlying data exists in the
tenant (e.g. "Has owner" shows once any owner relationships have been crawled).

To find ownerless AI agents: open **AI Agents**, add **Has owner = No**.

## How it maps to the data model

Relationship filters are a **read/query-layer** feature — no schema change. Each
filter is translated to an `EXISTS` (Yes) / `NOT EXISTS` (No) subquery over the
relationship tables that already hold the data:

- **Principal "Has owner"** → `PrincipalRelationships` with
  `relationshipType = 'Owner'` (the AI-agent / guest owner link, migration 057).
- **Resource "Has owner"** → a `Direct` assignment on the object's synthetic
  ownership resource (`GroupOwnership` / `ServicePrincipalOwnership` /
  `ApplicationOwnership`) reached via a `HasOwnership` / `HasAppOwnership`
  relationship. Covers both group ownership and app / service-principal
  ownership.
- **Resource "Has members"** → a live `Direct` `ResourceAssignments` row on the
  resource, excluding the ownership assignment (an owner is not a member) and
  soft-deleted rows. This mirrors the existing member-count definition. A nested
  subgroup counts as a member (it is itself a `Direct` member), so a group whose
  members arrive only via nesting is correctly **not** reported as memberless.

The mechanism is generic: new relationship filters are added by extending the
spec in `app/api/src/lib/relationshipFilters.js` (a domain entry with a
predicate, an existence probe, and the tables it needs). The filter fields are
advertised to the UI from the column-discovery endpoints, so no UI code changes
are needed to surface a new one.

### Wire format

Relationship filters travel in the same `?filters=<json>` query parameter as
attribute filters, as plain keys with a `Yes` / `No` value, e.g.

```
GET /api/users?filters={"principalType":"AIAgent","hasOwner":"No"}
GET /api/resources?filters={"resourceType":"Group","hasMembers":"No"}
```

An unrecognised value is ignored (the filter becomes a no-op), and a filter whose
backing table is absent on an older deployment is skipped rather than failing the
request.

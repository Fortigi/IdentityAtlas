# Entity Detail API

These endpoints power the detail pages for users, resources, business roles, systems, org units, and identities. All endpoints require `Authorization: Bearer <JWT>`.

---

## Users

### Column Discovery

#### GET /api/user-columns-page

Column discovery for the Users page. Returns all populated columns from the `Principals` table with distinct values, plus the virtual `__userTag` column if any user tags exist. Used to build the filter UI on the Users page.

Same response format as [`GET /api/user-columns`](matrix.md#get-apiuser-columns).

---

### User List

#### GET /api/users

Paginated list of principals with their tags.

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | string | | Full-text search on `displayName` and `userPrincipalName` (SQL `LIKE %term%`) |
| `limit` | int | 100 | Page size. Maximum: 500. |
| `offset` | int | 0 | Pagination offset. |
| `filters` | JSON string | | Attribute filters. Same format as [Matrix filters](matrix.md#filter-architecture). |

**Response**

```json
{
  "data": [
    {
      "id": "uuid",
      "displayName": "Jane Doe",
      "userPrincipalName": "jane.doe@contoso.com",
      "department": "Finance",
      "jobTitle": "Analyst",
      "principalType": "User",
      "tags": ["VIP", "External"]
    }
  ],
  "total": 3421
}
```

**Reads From:** `Principals` + `GraphTagAssignments` + `GraphTags`

---

### User Detail

#### GET /api/user/:id

Single user attributes and counts (number of resource memberships, number of business role assignments).

**Response**

```json
{
  "id": "uuid",
  "displayName": "Jane Doe",
  "userPrincipalName": "jane.doe@contoso.com",
  "department": "Finance",
  "jobTitle": "Analyst",
  "principalType": "User",
  "extendedAttributes": {
    "accountEnabled": true,
    "lastSignInDateTime": "2026-03-20T08:14:00Z"
  },
  "membershipCount": 12,
  "accessPackageCount": 3
}
```

**Reads From:** `Principals`

---

#### GET /api/user/:id/memberships

All resource memberships for a user, with membership type badges. Used by the Memberships section of the User detail page.

**Response**

```json
{
  "data": [
    {
      "groupId": "uuid",
      "groupDisplayName": "SG-Finance-Base",
      "membershipType": "Direct",
      "managedByAccessPackage": true,
      "accessPackageIds": ["ap-001"]
    }
  ]
}
```

**Reads From:** `mat_UserPermissionAssignments` + `Resources`

---

#### GET /api/user/:id/access-packages

Business role (access package) assignments for a user. Only returns active governed assignments (`state='Delivered'`).

**Response**

```json
{
  "data": [
    {
      "resourceId": "ap-001",
      "displayName": "Finance Base Access",
      "catalogDisplayName": "Corporate Catalog",
      "assignmentStatus": "Delivered",
      "assignedDateTime": "2026-01-10T09:00:00Z",
      "expirationDateTime": null,
      "policyId": "pol-001"
    }
  ]
}
```

**Reads From:** `ResourceAssignments` (`assignmentType='Governed'`) + `Resources` (`resourceType='BusinessRole'`) + `GovernanceCatalogs`

---

#### GET /api/user/:id/history

Version history for a user principal. Each entry represents a recorded change from the `_history` audit table, including the operation type and a JSONB snapshot of the row data.

**Response**

```json
{
  "history": [
    {
      "changedAt": "2026-01-15T10:23:00Z",
      "operation": "U",
      "rowData": { "displayName": "Jane Doe", "department": "Finance" },
      "prevData": { "displayName": "Jane Doe", "department": "HR" }
    }
  ]
}
```

**Reads From:** `_history` audit table (filtered by `tableName = 'Principals'`)

---

## Resources

### Column Discovery

#### GET /api/group-columns

Column discovery for the Groups/Resources page. Returns populated columns from the `Resources` table with distinct values, plus the virtual `__groupTag` column if any group tags exist.

**Reads From:** `Resources` (via `db/columnCache.js`, 5-minute TTL)

---

### Resource List

#### GET /api/groups

Paginated resource list with tags. The legacy path used by the Groups page; identical behavior to `/api/resources` with `resourceType` pre-filtered to group-like types.

**Query Parameters:** Same as [`GET /api/users`](#get-apiusers).

**Reads From:** `Resources` + `GraphTagAssignments` + `GraphTags`

---

#### GET /api/resources

Paginated resource list with optional type and system filters. Used by the Resources page.

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | string | | Search `displayName` (SQL `LIKE`) |
| `resourceType` | string | | Filter by `resourceType` (e.g. `Group`, `DirectoryRole`, `AppRole`, `BusinessRole`) |
| `systemId` | string | | Filter by originating system |
| `limit` | int | 100 | Page size. Maximum: 500. |
| `offset` | int | 0 | Pagination offset. |
| `filters` | JSON string | | Attribute filters. |

**Reads From:** `Resources` + `GraphTagAssignments` + `GraphTags`

---

### Resource Detail

#### GET /api/resources/:id

Single resource attributes including the `extendedAttributes` JSON column, plus counts (members, business roles that grant access to this resource).

**Response**

```json
{
  "id": "uuid",
  "displayName": "SG-Finance-Base",
  "resourceType": "Group",
  "systemId": "sys-001",
  "systemDisplayName": "EntraID",
  "extendedAttributes": {
    "mailEnabled": false,
    "securityEnabled": true,
    "groupTypes": []
  },
  "memberCount": 47,
  "accessPackageCount": 2,
  "tags": ["Finance", "Baseline"]
}
```

**Reads From:** `Resources`

---

#### GET /api/resources/:id/members

Paginated list of principals assigned to this resource, with membership type badges.

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `membershipType` | string | | Filter by type: `Direct`, `Indirect`, `Eligible`, `Owner` |
| `limit` | int | 100 | Page size. Maximum: 500. |
| `offset` | int | 0 | Pagination offset. |

**Reads From:** `mat_UserPermissionAssignments`

---

#### GET /api/resources/:id/history

Version history for a resource. Same format as [`GET /api/user/:id/history`](#get-apiuseridhistory).

**Reads From:** `Resources via `_history` audit table`

---

#### GET /api/group/:id/access-packages

Business roles that include this resource as a contained resource (i.e. granting membership or ownership of this group as part of a business role).

**Response**

```json
{
  "data": [
    {
      "resourceId": "ap-001",
      "displayName": "Finance Base Access",
      "roleName": "Member",
      "catalogDisplayName": "Corporate Catalog"
    }
  ]
}
```

**Reads From:** `ResourceRelationships` (`relationshipType='Contains'`) + `Resources` (`resourceType='BusinessRole'`) + `GovernanceCatalogs`

---

## Business Role Detail

### GET /api/access-package/:id

Core attributes for a business role, including assignment counts, catalog info, and review status.

Review status distinguishes two "no decisions yet" states:

| Review Status | Meaning |
|---|---|
| `"Not required"` | No review policy is configured on this role |
| `"Pending first review"` | A review policy exists but no review instance has run yet |
| `"Active"` | Review instance exists with decisions |

**Reads From:** `Resources` (`resourceType='BusinessRole'`) + `GovernanceCatalogs` + `AssignmentPolicies` + `CertificationDecisions`

---

### GET /api/access-package/:id/assignments

Active governed assignments for a business role. Only assignments with `state='Delivered'` are returned.

**Response**

```json
{
  "data": [
    {
      "principalId": "uuid",
      "principalDisplayName": "Jane Doe",
      "userPrincipalName": "jane.doe@contoso.com",
      "assignedDateTime": "2026-01-10T09:00:00Z",
      "expirationDateTime": null,
      "policyId": "pol-001",
      "assignmentStatus": "Delivered"
    }
  ],
  "total": 48
}
```

**Reads From:** `ResourceAssignments` (`assignmentType='Governed'`) + `Principals`

---

### GET /api/access-package/:id/resource-roles

Resources granted by this business role (the SOLL definition — what resources a user gets when this role is assigned).

**Response**

```json
{
  "data": [
    {
      "resourceId": "uuid",
      "displayName": "SG-Finance-Base",
      "resourceType": "Group",
      "roleName": "Member",
      "roleOriginSystem": "EntraID"
    }
  ]
}
```

**Reads From:** `ResourceRelationships` (`relationshipType='Contains'`) + `Resources`

---

### GET /api/access-package/:id/policies

Assignment policies for a business role. Distinguishes auto-assigned (ABAC) policies from request-based (self-service) policies.

**Response**

```json
{
  "data": [
    {
      "policyId": "pol-001",
      "displayName": "All Employees",
      "policyType": "AutoAssignment",
      "requestorScope": "AllMemberUsers",
      "policyConditions": {
        "department": "Finance"
      }
    }
  ]
}
```

**Reads From:** `AssignmentPolicies`

---

### GET /api/access-package/:id/reviews

Certification decisions for this business role.

**Response**

```json
{
  "data": [
    {
      "reviewId": "rev-001",
      "principalDisplayName": "Jane Doe",
      "reviewerDisplayName": "John Smith",
      "decision": "Approve",
      "reviewedDateTime": "2026-03-01T14:30:00Z",
      "isAutoReview": false,
      "certificationScopeType": "BusinessRole"
    }
  ]
}
```

`isAutoReview: true` indicates an AAD Access Review auto-applied decision (no human reviewer).

**Reads From:** `CertificationDecisions`

---

### GET /api/access-package/:id/requests

Pending (open) assignment requests for a business role.

**Reads From:** `AssignmentRequests` + `Principals`

---

### GET /api/access-package/:id/history

Version history for the business role resource record. Same format as [`GET /api/user/:id/history`](#get-apiuseridhistory).

**Reads From:** `Resources via `_history` audit table`

---

## Systems & Contexts

### Systems

| Endpoint | Method | Description |
|---|---|---|
| `/api/systems` | `GET` | All connected systems with resource counts, assignment counts, and resource type breakdown |
| `/api/systems/:id` | `GET` | Single system detail |
| `/api/systems/:id` | `PUT` | Update system metadata. Body: `{ displayName?, description?, enabled? }` |
| `/api/systems/:id/owners` | `GET` | List system owners (principals assigned as responsible for this system) |
| `/api/systems/:id/owners` | `POST` | Add system owner. Body: `{ principalId }` |
| `/api/systems/:id/owners/:userId` | `DELETE` | Remove a system owner |

**GET /api/systems response example:**

```json
{
  "data": [
    {
      "systemId": "sys-001",
      "displayName": "EntraID",
      "enabled": true,
      "resourceCount": 412,
      "assignmentCount": 8903,
      "resourceTypes": ["Group", "DirectoryRole", "AppRole"]
    }
  ]
}
```

**Reads From:** `Systems` + `Resources` + `ResourceAssignments`

---

### Contexts

Contexts represent organizational and structural groupings (departments, divisions, cost centers, teams, etc.) that belong to Identities — the real persons — not to individual system accounts. The `contextType` column discriminates between context types.

| Endpoint | Method | Description |
|---|---|---|
| `/api/contexts` | `GET` | Flat list of contexts with hierarchy pointers |
| `/api/contexts/tree` | `GET` | Pre-built nested tree structure for the Org Chart page |
| `/api/contexts/:id` | `GET` | Context detail with member count and sub-context list |
| `/api/contexts/:id/members` | `GET` | Paginated list of identities (and their correlated principals) in this context |

**GET /api/contexts/tree response excerpt:**

```json
{
  "tree": [
    {
      "id": "ctx-001",
      "displayName": "Finance",
      "contextType": "Department",
      "memberCount": 142,
      "children": [
        {
          "id": "ctx-007",
          "displayName": "Finance - Controllers",
          "contextType": "Team",
          "memberCount": 23,
          "children": []
        }
      ]
    }
  ]
}
```

**Reads From:** `Contexts` + `Identities` + `IdentityMembers`

---

## Identity Correlation

### GET /api/identities

Paginated list of correlated identities — real persons aggregated from multiple accounts across systems.

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | string | | Search by display name |
| `limit` | int | 100 | Page size. Maximum: 500. |
| `offset` | int | 0 | Pagination offset. |

**Response**

```json
{
  "data": [
    {
      "identityId": "iid-001",
      "displayName": "Jane Doe",
      "accounts": [
        { "principalId": "uuid", "systemDisplayName": "EntraID", "principalType": "User" },
        { "principalId": "uuid", "systemDisplayName": "GitHub", "principalType": "ServicePrincipal" }
      ],
      "verifiedAt": null,
      "verifiedBy": null
    }
  ],
  "total": 1280
}
```

**Reads From:** `Identities` + `IdentityMembers` + `Principals` + `Systems`

---

### PUT /api/identities/:id/verify

Analyst verification that the correlation result is correct (or mark it as incorrect for manual remediation).

**Request Body**

```json
{
  "verified": true,
  "notes": "Confirmed — same person, separate admin account"
}
```

`notes` is capped at 2000 characters.

---

## User Preferences

Preferences are stored per-user in the `GraphUserPreferences` SQL table (auto-created on first access). The user is identified by the Entra ID `oid` claim from their JWT. In no-auth mode, the key `anonymous` is used as a fallback.

### GET /api/preferences

Returns the current user's tab visibility preferences.

**Response**

```json
{
  "visibleTabs": ["risk-scores", "identities", "performance"]
}
```

Optional tabs that can be toggled: `risk-scores`, `identities`, `org-chart`, `performance`. All are hidden by default until the user enables them via the settings dropdown (user avatar, top right).

---

### PUT /api/preferences

Update the current user's tab visibility.

**Request Body**

```json
{
  "visibleTabs": ["risk-scores", "performance"]
}
```

**Response:** `204 No Content`

---

## Operations

### Performance Metrics

Performance monitoring is opt-in. Enable by setting `PERF_METRICS_ENABLED=true`.

| Endpoint | Method | Description |
|---|---|---|
| `/api/perf` | `GET` | Aggregated endpoint summaries — P50, P95, P99 latency per route |
| `/api/perf/recent` | `GET` | Last N requests with per-SQL-query timing breakdowns |
| `/api/perf/slowest` | `GET` | Slowest N requests (by total duration) |
| `/api/perf/export` | `GET` | Download full ring buffer as JSON for offline analysis |
| `/api/perf/clear` | `POST` | Clear the ring buffer (admin use) |

The ring buffer holds 1000 entries. When disabled (`PERF_METRICS_ENABLED` is unset or `false`), no overhead is incurred — the middleware is a no-op.

`Server-Timing` response headers are emitted on every request when enabled, making per-request SQL timing visible in browser DevTools (Network tab → Timing).

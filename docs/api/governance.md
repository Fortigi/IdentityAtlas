# Governance & Business Roles API

These endpoints manage business roles (access packages), review compliance, categories, and tags. All endpoints require `Authorization: Bearer <JWT>`.

---

## Business Roles List

### GET /api/access-packages

Paginated list of business roles with category and compliance metadata. This powers the Access Packages page.

**Query Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | string | | Search `displayName` or catalog name (SQL `LIKE %term%`) |
| `categoryId` | int | | Filter to roles assigned to this category |
| `uncategorized` | string | | `true` = only roles with no category assigned |
| `limit` | int | 100 | Page size. Maximum: 500. |
| `offset` | int | 0 | Pagination offset. |

!!! note
    `categoryId` and `uncategorized=true` are mutually exclusive. If both are provided, `categoryId` takes precedence.

**Response**

```json
{
  "data": [
    {
      "resourceId": "ap-001",
      "displayName": "Finance Base Access",
      "description": "Grants baseline access for Finance employees",
      "catalogId": "cat-001",
      "catalogDisplayName": "Corporate Catalog",
      "isHidden": false,
      "categoryId": 3,
      "categoryName": "Finance",
      "categoryColor": "#3B82F6",
      "assignmentCount": 48,
      "hasReview": true
    }
  ],
  "total": 67
}
```

**Response Fields**

| Field | Type | Description |
|---|---|---|
| `isHidden` | boolean | Whether the role is hidden in the Entra ID My Access portal |
| `categoryId` / `categoryName` | int / string | Assigned category (null if uncategorized) |
| `categoryColor` | string | Hex color for the category indicator stripe (null if uncategorized) |
| `assignmentCount` | int | Number of active governed assignments (`state='Delivered'`) |
| `hasReview` | boolean | Whether any certification decisions exist for this role |

**Reads From:** `Resources` (`resourceType='BusinessRole'`) + `GovernanceCatalogs` + `GovernanceCategoryAssignments` + `GovernanceCategories` + `ResourceAssignments` (`governed=true`)

---

## Review Compliance

These endpoints report on the state of certification reviews. Identity Atlas does not conduct reviews — decisions are made in the source IGA platform (e.g. Entra ID Access Reviews) and mirrored read-only into `CertificationDecisions` by the crawler. Both endpoints summarise, per access package, the **most recent review instance** only.

Both endpoints require `USE_SQL=true`; when SQL mode is off they return an empty result (`{}` / `[]`).

### GET /api/governance/summary

Tenant-wide review-compliance KPIs — one count per compliance status across all access packages that have review decisions.

**Query Parameters:** none.

**Response**

```json
{
  "totalAPs": 42,
  "compliant": 30,
  "overdue": 4,
  "reviewedLate": 3,
  "inProgress": 5
}
```

**Response Fields**

| Field | Type | Description |
|---|---|---|
| `totalAPs` | int | Access packages that have at least one review instance |
| `compliant` | int | APs whose last review was fully completed on time |
| `overdue` | int | APs whose last review deadline passed with decisions still outstanding (`Missed`) |
| `reviewedLate` | int | APs whose last review was completed, but after the deadline |
| `inProgress` | int | APs whose last review is still open and not yet past its deadline |

**Reads From:** `CertificationDecisions`

---

### GET /api/governance/review-compliance

Per-access-package last-review status, ordered worst-first (Missed → Reviewed Late → In Progress → Compliant, then by days overdue).

**Query Parameters**

| Parameter | Type | Description |
|---|---|---|
| `filter` | string | Restrict to one status: `compliant`, `overdue`, `reviewed-late`, or `in-progress`. Omit for all. |
| `category` | int / string | Restrict to a category id, or `uncategorized` for access packages with no category. Omit for all. |

**Response**

A JSON array (not wrapped in a `data` envelope), one object per access package:

```json
[
  {
    "resourceId": "ap-001",
    "accessPackageName": "Finance Base Access",
    "catalogName": "Corporate Catalog",
    "categoryName": "Finance",
    "categoryColor": "#3B82F6",
    "complianceStatus": "Missed",
    "deadline": "2026-05-01T00:00:00.000Z",
    "daysOverdue": 12,
    "totalDecisions": 48,
    "onTime": 40,
    "reviewedLate": 3,
    "notReviewed": 5,
    "lastReviewedDate": "2026-05-03T09:12:00.000Z",
    "lastReviewedBy": "Alice Reviewer",
    "reviewInstanceStatus": "Completed"
  }
]
```

**Response Fields**

| Field | Type | Description |
|---|---|---|
| `resourceId` | string | The business role (access package) id |
| `accessPackageName` | string | Access package display name |
| `catalogName` | string | Owning `GovernanceCatalogs` name (null if none) |
| `categoryName` / `categoryColor` | string | Assigned category label and hex color (null if uncategorized) |
| `complianceStatus` | string | `Compliant`, `Missed`, `Reviewed Late`, or `In Progress` |
| `deadline` | datetime | End date of the last review instance |
| `daysOverdue` | int | Days past the deadline (0 if not overdue) |
| `totalDecisions` | int | Decisions in the last review instance |
| `onTime` | int | Decisions made on or before the deadline |
| `reviewedLate` | int | Decisions made after the deadline |
| `notReviewed` | int | Decisions still outstanding (`NotReviewed`) |
| `lastReviewedDate` | datetime | Most recent decision timestamp in the instance |
| `lastReviewedBy` | string | Display name of the most recent reviewer |
| `reviewInstanceStatus` | string | Raw instance status from the source IGA platform |

**Reads From:** `CertificationDecisions` + `Resources` (`resourceType='BusinessRole'`) + `GovernanceCatalogs` + `GovernanceCategoryAssignments` + `GovernanceCategories`

---

## Category Management

Categories are single-assignment labels for business roles. Unlike tags, a business role can have **at most one** category. This constraint is enforced by a primary key on `(resourceId)` in the `GovernanceCategoryAssignments` table.

Categories drive AP column ordering in the Matrix view — SOLL columns are sorted first by category name, then by total assignment count within each category. Uncategorized business roles appear at the end. Category boundaries are marked with thicker borders and a colored indicator stripe.

### GET /api/categories

List all categories with the count of business roles assigned to each.

**Response**

```json
{
  "data": [
    {
      "id": 1,
      "name": "Finance",
      "color": "#3B82F6",
      "assignmentCount": 12
    },
    {
      "id": 2,
      "name": "HR",
      "color": "#10B981",
      "assignmentCount": 8
    }
  ]
}
```

**Reads From:** `GovernanceCategories` + `GovernanceCategoryAssignments`

---

### POST /api/categories

Create a new category.

**Request Body**

```json
{
  "name": "Legal",
  "color": "#F59E0B"
}
```

| Field | Required | Constraints |
|---|---|---|
| `name` | Yes | Must be unique. Max 200 characters. |
| `color` | No | Hex color string (`#RRGGBB` format). Validated with `/^#[0-9a-fA-F]{6}$/`. |

**Response:** `201 Created` with the new category object (including assigned `id`).

---

### PATCH /api/categories/:id

Update an existing category's name and/or color.

**Request Body**

```json
{
  "name": "Legal & Compliance",
  "color": "#EF4444"
}
```

All fields are optional. Omitted fields are unchanged.

**Response:** `200 OK` with the updated category object.

---

### DELETE /api/categories/:id

Delete a category and cascade-remove all its assignments from `GovernanceCategoryAssignments`. Business roles that had this category become uncategorized.

**Response:** `204 No Content`

---

### POST /api/categories/:id/assign

Assign a category to a business role. If the business role already has a category, it is **replaced** (not stacked).

**Request Body**

```json
{
  "resourceId": "ap-001"
}
```

**Response:** `200 OK`

---

### POST /api/categories/unassign

Remove the category from a business role (makes it uncategorized).

**Request Body**

```json
{
  "resourceId": "ap-001"
}
```

**Response:** `200 OK`

---

### GET /api/category-assignments

All category assignments as a flat list. Used by the Matrix view to determine column ordering without making per-category requests.

**Response**

```json
{
  "data": [
    {
      "resourceId": "ap-001",
      "categoryId": 1,
      "categoryName": "Finance",
      "categoryColor": "#3B82F6"
    }
  ]
}
```

**Reads From:** `GovernanceCategoryAssignments` + `GovernanceCategories`

---

## Tag Management

Tags are free-form labels for users and resources. Unlike categories, an entity can have **multiple tags**, and tags are scoped by `entityType` (`user` or `group`). Tags read/write through `GraphTags` and `GraphTagAssignments`, which since the v6 Contexts redesign are **backward-compatibility views** over the unified `Contexts` model (`contextType='Tag'`), not standalone base tables.

### GET /api/tags

List all tags, optionally filtered by entity type.

**Query Parameters**

| Parameter | Type | Description |
|---|---|---|
| `entityType` | string | `user` or `group`. Omit to return all tags. |

**Response**

```json
{
  "data": [
    {
      "id": 42,
      "name": "VIP",
      "color": "#F59E0B",
      "entityType": "user",
      "assignmentCount": 17
    }
  ]
}
```

**Reads From:** `GraphTags` + `GraphTagAssignments` (COUNT via LEFT JOIN)

---

### POST /api/tags

Create a new tag.

**Request Body**

```json
{
  "name": "Contractor",
  "color": "#8B5CF6",
  "entityType": "user"
}
```

| Field | Required | Constraints |
|---|---|---|
| `name` | Yes | Must be unique within the same `entityType`. Max 200 characters. |
| `color` | No | Hex color string (`#RRGGBB`). Validated with `/^#[0-9a-fA-F]{6}$/`. |
| `entityType` | Yes | `user` or `group`. |

**Response:** `201 Created` with the new tag object.

---

### PATCH /api/tags/:id

Update a tag's name and/or color. `entityType` cannot be changed.

**Request Body**

```json
{
  "name": "External Contractor",
  "color": "#7C3AED"
}
```

**Response:** `200 OK` with the updated tag object.

---

### DELETE /api/tags/:id

Delete a tag and cascade-remove all its assignments from `GraphTagAssignments`.

**Response:** `204 No Content`

---

### POST /api/tags/:id/assign

Assign a tag to one or more entities.

**Request Body**

```json
{
  "entityIds": ["uuid-1", "uuid-2", "uuid-3"]
}
```

| Field | Constraints |
|---|---|
| `entityIds` | Array of entity UUIDs. Maximum **500 IDs** per request. |

Assignment is idempotent — entities that already have the tag are skipped (single batched `INSERT ... WHERE NOT EXISTS`).

**Response:** `200 OK`

---

### POST /api/tags/:id/unassign

Remove a tag from one or more entities.

**Request Body**

```json
{
  "entityIds": ["uuid-1", "uuid-2"]
}
```

Maximum **500 IDs** per request. Uses a single batched `DELETE ... WHERE id IN (...)`.

**Response:** `200 OK`

---

### POST /api/tags/:id/assign-by-filter

Bulk-assign a tag to all entities matching a server-side filter. Useful for tagging entire departments or job title groups at once.

**Request Body**

```json
{
  "entityType": "user",
  "search": "contractor",
  "filters": {
    "department": "Finance"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `entityType` | Yes | `user` or `group` — determines which table is queried |
| `search` | No | Full-text search on `displayName` / `userPrincipalName` |
| `filters` | No | Attribute filters (same format as Matrix server-side filters) |

!!! warning "Row Cap"
    This endpoint applies a **50,000-row safety cap** (`LIMIT 50000` in SQL). Adjust your filter to narrow the scope if the target set exceeds this limit.

**Response:** `200 OK` with count of newly assigned entities.

```json
{
  "assigned": 134
}
```

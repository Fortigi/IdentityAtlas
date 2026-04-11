# Risk Scores API

These endpoints expose identity risk scoring data and allow analysts to apply score adjustments with audit trails. In v5, scoring is driven from the UI (Admin > Risk Scoring) via the Node.js scoring engine. All endpoints require `Authorization: Bearer <JWT>`.

---

## Risk Score Overview

The scoring engine assigns a numeric score (0–100) to every principal, resource, business role, context, and identity. Scores map to named tiers:

| Tier | Score Range | Color |
|---|---|---|
| Critical | 80–100 | Red |
| High | 60–79 | Orange |
| Medium | 40–59 | Yellow |
| Low | 20–39 | Blue |
| Minimal | 1–19 | Green |
| None | 0 | Grey |

Scoring runs in four layers:

1. **Direct match** — classifier regex patterns matched against display names, job titles, and attributes
2. **Membership analysis** — score contributions from high-risk resources the principal is a member of
3. **Structural hygiene** — stale sign-ins, never-signed-in accounts, accounts with no expiration, orphaned identities
4. **Cross-entity propagation** — risk flowing from high-risk principals upward to their contexts

Analyst overrides (+50 to −50) are preserved across re-scoring runs and applied after all four layers, with the final score clamped to 0–100.

---

## Summary

### GET /api/risk-scores

Overall risk score summary across all entity types. Used by the Risk Scoring page header and dashboard widgets.

**Response**

```json
{
  "summary": {
    "totalEntities": 4210,
    "scored": 4008,
    "overrides": 23,
    "lastScoredAt": "2026-03-27T04:05:00Z"
  },
  "tierDistribution": {
    "Principal": {
      "Critical": 12,
      "High": 87,
      "Medium": 341,
      "Low": 1204,
      "Minimal": 1809,
      "None": 68
    },
    "Resource": {
      "Critical": 4,
      "High": 31,
      "Medium": 128,
      "Low": 249,
      "Minimal": 0,
      "None": 0
    },
    "BusinessRole": { ... },
    "Context": { ... },
    "Identity": { ... }
  }
}
```

**Reads From:** `RiskScores`

---

## Entity Type Lists

Each entity type has a dedicated paginated list endpoint.

| Endpoint | Entity Type | Reads From |
|---|---|---|
| `GET /api/risk-scores/users` | Principals | `RiskScores` + `Principals` |
| `GET /api/risk-scores/groups` | Resources (non-BusinessRole) | `RiskScores` + `Resources` |
| `GET /api/risk-scores/business-roles` | Resources (`resourceType='BusinessRole'`) | `RiskScores` + `Resources` |
| `GET /api/risk-scores/contexts` | Contexts | `RiskScores` + `Contexts` |
| `GET /api/risk-scores/identities` | Identities | `RiskScores` + `Identities` |

### Common Query Parameters

All list endpoints accept the same parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `search` | string | | Filter by `displayName` (SQL `LIKE %term%`) |
| `tier` | string | | Filter by tier: `Critical`, `High`, `Medium`, `Low`, `Minimal`, `None` |
| `overridesOnly` | string | | `true` = only entities that have an active analyst override |
| `limit` | int | 100 | Page size. Maximum: 500. |
| `offset` | int | 0 | Pagination offset. |

### Response Format

```json
{
  "data": [
    {
      "entityId": "uuid",
      "displayName": "Jane Doe",
      "entityType": "Principal",
      "score": 73,
      "tier": "High",
      "baseScore": 68,
      "overrideAdjustment": 5,
      "overrideReason": "Privileged project access — temporary elevation approved",
      "overrideBy": "john.smith@contoso.com",
      "overrideAt": "2026-03-15T11:00:00Z",
      "topContributors": [
        { "factor": "DirectMatch", "weight": 35, "detail": "Classifier: Finance-Privileged" },
        { "factor": "MembershipRisk", "weight": 28, "detail": "Member of 3 Critical resources" },
        { "factor": "StaleSignIn", "weight": 10, "detail": "Last sign-in: 95 days ago" }
      ]
    }
  ],
  "total": 521
}
```

**Response Fields**

| Field | Type | Description |
|---|---|---|
| `score` | int | Effective score (0–100) = base components + override, clamped |
| `baseScore` | int | Score before any analyst override |
| `overrideAdjustment` | int | Analyst adjustment (−50 to +50). `null` if no override. |
| `overrideReason` | string | Required reasoning supplied by the analyst. `null` if no override. |
| `topContributors` | array | Top scoring factors with weights and descriptions |

---

## Single Entity & Override

### GET /api/risk-scores/:type/:id

Retrieve the current risk score for a single entity.

**Path Parameters**

| Parameter | Values |
|---|---|
| `type` | `users`, `groups`, `business-roles`, `contexts`, `identities` |
| `id` | Entity UUID |

**Response:** Same structure as a single item from the list endpoints above, plus full `contributors` array (not just top 3).

---

### PUT /api/risk-scores/:type/:id/override

Apply an analyst score adjustment to a single entity. The adjustment is stored with the analyst's identity (from JWT `upn` claim) and required reasoning.

**Path Parameters**

| Parameter | Values |
|---|---|
| `type` | `users`, `groups`, `business-roles`, `contexts`, `identities` |
| `id` | Entity UUID |

**Request Body**

```json
{
  "adjustment": -20,
  "reason": "False positive — display name matches classifier but account is a shared mailbox with no sensitive access"
}
```

| Field | Type | Required | Constraints |
|---|---|---|---|
| `adjustment` | int | Yes | Integer from −50 to +50 |
| `reason` | string | Yes | Non-empty. Capped at **500 characters**. |

**Response**

```json
{
  "entityId": "uuid",
  "newScore": 48,
  "baseScore": 68,
  "overrideAdjustment": -20,
  "overrideReason": "False positive — ...",
  "overrideBy": "john.smith@contoso.com",
  "overrideAt": "2026-03-27T14:22:00Z"
}
```

!!! note "Override Persistence"
    Overrides are preserved when `Invoke-FGRiskScoring` re-runs. The engine writes the base score from its four-layer calculation; the override adjustment is applied on top when the API reads back the score.

!!! note "Clearing an Override"
    To remove an override, set `adjustment` to `0` and supply a `reason` explaining the removal.

---

## Resource Clusters

### GET /api/risk-scores/clusters

List resource clusters created by `Save-FGResourceClusters`. Each cluster groups related resources by classifier or name-stem and has an aggregate risk score computed from its members.

**Response**

```json
{
  "data": [
    {
      "clusterId": "clust-001",
      "displayName": "Finance Access Cluster",
      "clusterType": "Classifier",
      "ownerDisplayName": "Jane Doe",
      "memberCount": 14,
      "aggregateScore": 71,
      "tier": "High",
      "assignedBy": "john.smith@contoso.com"
    }
  ]
}
```

**Response Fields**

| Field | Description |
|---|---|
| `clusterType` | `Classifier` (grouped by risk classifier) or `NameStem` (grouped by shared display name prefix) |
| `ownerDisplayName` | Analyst-assigned owner for remediation accountability |
| `aggregateScore` | Weighted average of member entity scores |
| `assignedBy` | Identity who assigned the cluster owner (derived from authenticated user, not request body) |

**Reads From:** `ResourceClusters` + `ResourceClusterMembers` + `RiskScores`

---

## Org Chart

### GET /api/org-chart

Manager hierarchy tree with risk scores propagated to department nodes. Used by the Org Chart page.

**Caching:** Response is cached for **5 minutes** server-side. This avoids expensive recursive CTE execution on every page load.

**Response**

```json
{
  "tree": [
    {
      "principalId": "uuid",
      "displayName": "Alice Johnson",
      "jobTitle": "Chief Financial Officer",
      "department": "Finance",
      "riskScore": 42,
      "riskTier": "Medium",
      "directReportCount": 8,
      "totalReportCount": 142,
      "children": [
        {
          "principalId": "uuid",
          "displayName": "Bob Chen",
          "jobTitle": "Finance Director",
          "riskScore": 67,
          "riskTier": "High",
          "directReportCount": 12,
          "totalReportCount": 58,
          "children": [ ... ]
        }
      ]
    }
  ],
  "cachedAt": "2026-03-27T14:00:00Z"
}
```

**Reads From:** `Principals` (manager hierarchy via `managerId` self-join) + `RiskScores` + `Contexts`

Risk tiers on manager nodes reflect the **highest risk tier among all direct and indirect reports** — allowing managers to identify high-risk subtrees at a glance.

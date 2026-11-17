# Risk Scores API

These endpoints read risk scores, let an analyst adjust a single score, and start or follow a scoring run. Scoring is started from **Admin → Risk Scoring** in the UI, which calls the run endpoints below; you can call them yourself too. Authentication works as described in the [API overview](index.md#authentication).

Risk scoring is an optional feature, switched off on a new install. See [How Scoring Works](../risk-scoring/overview.md) for what the scores mean.

---

## How a score is made

A scoring run gives every account (`entityType` `Principal`) and every resource (`entityType` `Resource`, business roles included) a score from 0 to 100, built from four layers:

| Layer | Weight | What it looks at |
|---|---|---|
| Direct match | 0.50 | The best classifier pattern matching the name, e-mail, job title, department, description and attributes. Non-production groups get a quarter of the score (at least 5). |
| Membership | 0.20 | Groups: small groups, groups without an owner. Accounts: membership of many groups or of a high-risk group, owning several groups, a wide span of control. Capped at 40. |
| Structural | 0.10 | Groups: no description, mail-enabled security group, role-assignable group, dynamic membership. Accounts: disabled but still a member, guest account, no sign-in for more than 90 days. Capped at 25. |
| Propagated | 0.20 | An account inherits 30% of the score of its riskiest group; a group inherits 25% of the score of its riskiest member. One pass. |

The final score is the weighted sum, capped at 100. It maps to a tier:

| Tier | Score |
|---|---|
| Critical | 90–100 |
| High | 70–89 |
| Medium | 40–69 |
| Low | 20–39 |
| Minimal | 1–19 |
| None | 0 |

The engine writes `Principal` and `Resource` rows only. The endpoints below also accept business roles, contexts and identities as types, but no scoring run writes rows of those types: the business-role and identity lists come back empty and single lookups answer `404`. The contexts list answers `500`, because its query reads context columns that do not exist.

!!! warning "A scoring run removes overrides"
    A run replaces every row of the scores table. Analyst overrides made before the run are not carried over: after the run each entity has its computed score and no override.

---

## Scoring runs

### POST /api/risk-scoring/runs

Starts a scoring run in the background. Requires the `admin.crawlers` permission.

**Request body** (optional)

```json
{ "classifierId": 12 }
```

Without `classifierId` the active classifier set is used.

**Responses**

| Status | When |
|---|---|
| `202` | The run started. The body is the new run (see below). |
| `404` | `classifierId` does not exist |
| `409` | A run is already in progress |
| `412` | No `classifierId` given and no classifier set is active |

### GET /api/risk-scoring/runs

The 50 most recent runs, newest first, as `{ "data": [ ... ] }`. Any signed-in user with a role may read it.

### GET /api/risk-scoring/runs/:id

One run. The UI polls this every 2 seconds while a run is going.

```json
{
  "id": 7,
  "classifierId": 12,
  "status": "running",
  "step": "Propagating risk across memberships",
  "pct": 75,
  "totalEntities": 4210,
  "scoredEntities": 0,
  "errorMessage": null,
  "startedAt": "2026-11-12T08:00:00Z",
  "completedAt": null,
  "triggeredBy": "admin@contoso.com"
}
```

`status` moves from `pending` to `running` and ends as `completed` or `failed`.

---

## Summary

### GET /api/risk-scores

Totals and top lists for the Risk Scores page.

```json
{
  "available": true,
  "useResources": true,
  "scoredAt": "2026-11-12T08:04:10Z",
  "summary": {
    "totalUsers": 1475,
    "totalGroups": 448,
    "totalBusinessRoles": 0,
    "totalContexts": 0,
    "totalIdentities": 0,
    "userOverrides": 3,
    "groupOverrides": 1,
    "usersByTier": { "High": 12, "Medium": 140, "Low": 610, "Minimal": 700, "None": 13 },
    "groupsByTier": { "Critical": 2, "High": 9, "Medium": 51, "Low": 160, "Minimal": 226 },
    "topUsers": [ ... ],
    "topGroups": [ ... ],
    "resourceTypeBreakdown": [ { "resourceType": "Group", "count": 448, "avgScore": 21.4 } ]
  }
}
```

The summary also has `businessRoleOverrides`, `contextOverrides`, `identityOverrides`, `businessRolesByTier`, `contextsByTier` and `identitiesByTier`. `topUsers` and `topGroups` hold the ten highest-scoring accounts and resources, in the row format described below.

When no scores exist yet, the response is `{ "available": false, "message": "..." }`.

---

## Lists per type

| Endpoint | Rows | Extra filter |
|---|---|---|
| `GET /api/risk-scores/users` | Accounts | `department` (exact match) |
| `GET /api/risk-scores/groups` | Resources | `resourceType` (exact match) |
| `GET /api/risk-scores/business-roles` | Business roles | |
| `GET /api/risk-scores/contexts` | Contexts | |
| `GET /api/risk-scores/identities` | Identities | |

Deleted accounts and resources are left out.

### Query parameters

| Parameter | Default | Description |
|---|---|---|
| `search` | | Case-insensitive text match on the display name and a few other columns per type (e-mail and department for accounts, description for resources) |
| `tier` | | `Critical`, `High`, `Medium`, `Low`, `Minimal` or `None` |
| `overridesOnly` | | `true` returns only rows that have an override value |
| `limit` | 100 | Page size, at most 500 |
| `offset` | 0 | Rows to skip |

Rows are sorted by score, highest first.

### Response

```json
{
  "data": [
    {
      "entityId": "6f1c2a8e-0b7d-4e58-9a51-3c2f1e7d9b40",
      "entityType": "Principal",
      "displayName": "Megan Bowen",
      "userPrincipalName": "megan.bowen@contoso.com",
      "department": "Finance",
      "jobTitle": "Finance Manager",
      "riskScore": 73,
      "riskTier": "High",
      "riskDirectScore": 80,
      "riskMembershipScore": 20,
      "riskStructuralScore": 5,
      "riskPropagatedScore": 40,
      "riskOverride": null,
      "riskOverrideReason": null,
      "riskScoredAt": "2026-11-12T08:04:10Z",
      "effectiveScore": 73,
      "classifierMatches": [ ... ],
      "explanation": {
        "direct":     { "score": 80, "reasons": ["Matched 'Finance' on department [+80]"] },
        "membership": { "score": 20, "reasons": [ ... ] },
        "structural": { "score": 5,  "reasons": [ ... ] },
        "propagated": { "score": 40, "reasons": [ ... ] }
      }
    }
  ],
  "total": 1475,
  "available": true
}
```

| Field | Description |
|---|---|
| `riskScore`, `riskTier` | The stored score and tier |
| `riskDirectScore` … `riskPropagatedScore` | The four layer scores before weighting |
| `riskOverride`, `riskOverrideReason` | The analyst adjustment and its reason; `null` when none was ever set |
| `effectiveScore` | `riskScore` plus `riskOverride` when an override is present, clamped to 0–100; otherwise `riskScore` |
| `classifierMatches` | Every classifier that matched |
| `explanation` | Per layer: the score and the reasons behind it |

The columns next to these depend on the type: account fields for `users`, resource fields for `groups`, catalog name for `business-roles`, and so on. `groups` responses also carry `"useResources": true`.

---

## One entity

### GET /api/risk-scores/:type/:id

| Parameter | Values |
|---|---|
| `type` | `users`, `groups`, `resources`, `business-roles`, `contexts`, `identities` (`groups` and `resources` mean the same) |
| `id` | The entity's UUID |

Returns one row in the format above, plus `displayName`. `404` when the entity has no score.

### PUT /api/risk-scores/:type/:id/override

Sets an analyst adjustment on one entity. Requires the `data.write.risk` permission.

```json
{
  "adjustment": -20,
  "reason": "Shared mailbox; the name matches a classifier but the account has no sensitive access"
}
```

| Field | Rules |
|---|---|
| `adjustment` | Whole number from −50 to +50 |
| `reason` | Required, 3 to 500 characters |

The API adds the four stored layer scores to the adjustment, clamps the result to 0–100, and stores it as the new `riskScore` and `riskTier`.

```json
{
  "success": true,
  "adjustment": -20,
  "reason": "Shared mailbox; the name matches a classifier but the account has no sensitive access",
  "riskScore": 48,
  "riskTier": "Medium",
  "assignedBy": "analyst@contoso.com"
}
```

`assignedBy` is the signed-in user. It is returned, not stored.

### DELETE /api/risk-scores/:type/:id/override

Removes the adjustment. Requires the `data.write.risk` permission. The score is recomputed the same way with an adjustment of 0; `riskOverride` becomes `0` and `riskOverrideReason` becomes `null`.

```json
{ "success": true, "riskScore": 68, "riskTier": "Medium" }
```

---

## Org chart

These endpoints belong to the manager hierarchy, not to risk scoring. They carry no scores.

| Endpoint | Returns |
|---|---|
| `GET /api/org-chart` | `{ "available": true }` when the manager-hierarchy context plugin has built contexts, otherwise `false` |
| `GET /api/org-chart/user/:id/manager` | `{ "manager": { ... } }`, or `{ "manager": null }` |
| `GET /api/org-chart/user/:id/reports` | `{ "reports": [ ... ], "totalCount": 12 }`. `limit` defaults to 200, at most 1000. |

A manager or report row has `id`, `displayName`, `email`, `department`, `jobTitle`, `companyName`, `deleted` and `deletedAt`.

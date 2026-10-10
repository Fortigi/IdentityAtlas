---
type: task
prereq: admin/excel-powerquery-export.md
outcome: You can define an Analytics Profile and load its aggregate datasets into Power BI Desktop.
---

# Power BI analytics (experimental)

!!! info "Before this page"
    Assumes you have read **[Excel Power Query workbook export](excel-powerquery-export.md)** — it
    explains read-only API keys (`fgr_…`), which this page reuses.

!!! warning "Experimental, and not yet verified in Power BI"
    The **Analytics** feature is switched off by default. The Power Query sample on this page has
    **not** been run in Power BI Desktop or the Power BI Service by its author, and there is no
    `.pbit` template yet. A template is only shipped once it has been built and opened in Power BI
    Desktop; see [the design note](../architecture/analytics-profiles.md) (§7)
    for what is and is not known about refresh in the Service.

Instead of exporting every account and assignment, Identity Atlas computes **aggregates** — "how many
enabled accounts per department and worker type" — and Power BI imports only those. You decide
which attributes are reporting dimensions, and which combinations of them (datasets) are offered,
in an **Analytics Profile**.

## 1. Switch the feature on

An administrator with **Feature flags** permission sends:

```
POST /api/admin/features/toggle   { "feature": "analytics", "enabled": true }
```

or sets `FEATURE_ANALYTICS=true` on the web container. While off, every `/api/analytics/…` endpoint
answers 404.

## 2. See what you can report on

`GET /api/analytics/v1/catalog` lists:

- **fields** — core fields (`Principal.accountEnabled`, `Identity.department`, …) and every
  `extendedAttributes` key your crawlers wrote (`Principal.ext.<key>`), with whether each can be a
  dimension, and whether its history can be reconstructed;
- **metrics** — what each one counts, exactly (the *grain*), its measures, and which entities' fields
  may slice it.

| Metric | Counts | History |
|---|---|---|
| `principals.count` | live accounts, each once | current |
| `identities.count` | persons with a live account, each once | current |
| `assignments.governedShare` | (account, resource) access pairs: governed, ungoverned, share, holders | current |
| `principals.countAsOf` | accounts alive at the end of each month, with that month's attribute values | reconstructed from the audit log |

Names, e-mail addresses, IDs and free text can never be dimensions. A dimension with more than 200
distinct values is refused when you save the profile.

## 3. Create a profile

Needs the **Analytics profiles** permission (`admin.analytics`). Preview first — this measures each
dimension and estimates the size of each dataset without saving:

```
POST /api/analytics/v1/profiles/validate
{
  "name": "Workforce overview",
  "definition": {
    "dimensions": [
      { "field": "Principal.accountEnabled", "label": "Account status" },
      { "field": "Principal.ext.employeeCategory", "label": "Internal / external" },
      { "field": "Identity.department", "label": "Department" }
    ],
    "datasets": [
      { "id": "accounts", "metric": "principals.count",
        "dimensions": ["Principal.accountEnabled", "Principal.ext.employeeCategory", "Identity.department"] },
      { "id": "governance", "metric": "assignments.governedShare", "dimensions": ["Identity.department"] },
      { "id": "accounts-trend", "metric": "principals.countAsOf",
        "dimensions": ["Principal.accountEnabled"], "periods": 6 }
    ],
    "privacy": { "minGroupSize": 5 }
  }
}
```

Then `POST /api/analytics/v1/profiles` with the same body. Every change is a new **version**
(`PUT …/profiles/:id` with `"expectedVersion"`); `DELETE` retires a profile but keeps its history.
`GET …/profiles/:id/versions` shows who changed what.

**A dataset is a supported combination.** Each dataset is computed as one joint breakdown over all of
its dimensions, so Power BI can filter it by any mix of them. Two separate datasets (accounts by
status, accounts by department) can **not** be combined into "accounts by status *and* department" —
add a dataset with both dimensions instead.

## 4. Load it into Power BI Desktop

1. Mint a read-only API key (Admin → Data export, or `POST /api/admin/read-tokens`).
2. In Power BI Desktop: **Home → Transform data → Manage parameters → New** and create three text
   parameters: `AtlasUrl` (`https://<your-atlas>/api/analytics/v1/`, with the trailing slash),
   `ProfileId`, and `ReadToken`.
3. **New source → Blank query → Advanced editor**, paste
   [`IdentityAtlasAnalytics.pq`](power-bi/IdentityAtlasAnalytics.pq), and change `"accounts"` to
   the dataset id. Repeat per dataset.
4. When asked for credentials for the Identity Atlas URL, choose **Anonymous** — the key travels in
   the `Authorization` header, not as a Power BI credential.
5. Build visuals. Use the `suppressed` column as a filter or tooltip: a suppressed cell has its
   numbers withheld because fewer than `minGroupSize` accounts/persons are in it.
6. Before sharing the `.pbix` or saving a template, **clear the `ReadToken` parameter**.

## 5. Read the numbers honestly

Every dataset response carries what a report needs to label itself:

- `profile.version`, `dataset.metricVersion` — which definitions produced the numbers;
- `dataset.historyMethod` and, per row of a trend, `historyMethod` — `current` (live data) or
  `reconstructed` (from the audit log);
- `coverage.unavailablePeriods` — months that **cannot** be reconstructed (older than the audit log's
  retention, `HISTORY_RETENTION_DAYS`, default 180 days). They are omitted, not shown as zero;
- `excluded` — what a metric deliberately leaves out (e.g. business-role membership rows in the
  governed share);
- `freshness.lastSyncAt` — the most recent completed sync in scope.

`GET /api/analytics/v1/profiles/:id/metadata` returns the same definitions plus the known limitations,
for a "data notes" page in the report.

## Refreshing in the Power BI Service

Not yet verified. From Microsoft's documentation, refresh of this kind of query is expected to work
with the **Anonymous** credential when the base URL is static (it is: dataset ids go in
`RelativePath`), possibly with **Skip test connection** enabled. If Identity Atlas is only reachable
on an internal network, an on-premises data gateway is required. Test this on your tenant before
relying on scheduled refresh, and tell us what you find.

## Troubleshooting

| Response | Meaning |
|---|---|
| `404` on every analytics URL | The Analytics feature is switched off. |
| `400 invalid_profile` | `details.errors` lists each problem with its path (unknown field, not reportable, high cardinality, unsupported breakdown). |
| `409 version_conflict` | Someone saved the profile after you loaded it; reload and re-apply your change. |
| `422 dataset_too_large` | The breakdown has more cells than `limits.maxRows`; usually a dimension that is really free text. Remove it. |
| `403` with a read token | Read tokens can only `GET`; profiles are created by a signed-in user with `admin.analytics`. |

# Syncing from Omada IGA

Identity Atlas can pull business roles, identities, accounts, role assignments, and certification data directly from Omada's OData REST API — on-premise or Omada Cloud. The crawler maps Omada objects onto the Identity Atlas universal data model.

---

## What Gets Imported

| Omada object | Identity Atlas |
|---|---|
| `System` (connected systems) | **Systems** |
| `Orgunit` and other configured context entity sets | **Contexts** (Orgunit hierarchy via `PARENTOU`, others flat) |
| `Identity` (person-type only) | **Identities** |
| `User` (accounts) | **Principals** |
| Identity → User link | **IdentityMembers** |
| `Contextassignment` + direct Identity reference fields + `Employment` | **ContextMembers** |
| `Resource` | **Resources** (type mapped from `ROLECATEGORY` via `resourceCategoryMapping`) |
| `Resource.CHILDROLES` | **ResourceRelationships** (`Contains`) |
| `Resourceassignment` | **ResourceAssignments** (`assignmentType=Governed`) |
| `CalculatedAssignments` (Builtin OData) | **Principals** + **IdentityMembers** + **ResourceAssignments** (`Governed` or `Direct`, across all connected systems) |

> 📖 For the full phase-by-phase field mapping, shared state variables, and error-handling behavior, see **[Omada IGA Crawler — Data Model Reference](../architecture/omada-crawler-datamodel.md)**.

Omada has no native delta API — every sync (scheduled or manual) is a **full sync**, safely scoped so it only touches data it owns (matched by `systemId`). Data from other crawlers (Entra, midPoint, CSV) is never touched.

---

## Prerequisites

- An Omada Identity instance (on-premise v14/v15, or Omada Cloud) with OData enabled
- A user or service account with read access to the OData API
- Identity Atlas worker container (or standalone PowerShell 7)

---

## Running a Sync

### Via the UI (recommended)

1. Navigate to **Admin → Crawlers**
2. Click **Add Crawler** and select **Omada IGA**
3. Fill in the connection details (see [Configuration](#configuration) below)
4. Click **Save** and then **Run now**, or set a schedule

### Via the command line

```powershell
.\tools\crawlers\omada\Start-OmadaCrawler.ps1 `
    -ApiBaseUrl "http://localhost:3001/api" `
    -ApiKey "fgc_abc123..." `
    -JobId 0 `
    -ConfigPath ".\myconfig.json"
```

The `ApiKey` is the worker API key shown on the **Admin → Settings** page.

---

## Configuration

| Field | Required | Description |
|---|---|---|
| `baseUrl` | Yes | Omada OData base URL, e.g. `https://tenant.omada.cloud` or `.../odata/dataobjects` (auto-normalised) |
| `authMethod` | Yes | One of `FormCookie`, `OAuth2CC`, `OAuth2ROPC`, `ApiToken`, `CookieString`, `BasicAuth` |
| `apiVersion` | No (default `v14`) | `v14` / `v15` (on-premise) or `cloud` — informational, does not change request shape |
| `username` / `password` | FormCookie / BasicAuth / OAuth2ROPC | Omada credentials |
| `tokenEndpoint` / `clientId` / `clientSecret` | OAuth2CC / OAuth2ROPC | OAuth2 token endpoint and app registration |
| `apiToken` | ApiToken | Static bearer token |
| `cookieString` | CookieString | Pre-built session cookie — useful for Omada Cloud when only browser/PowerShell session cookies are available |
| `selectedObjects` | No | Object with boolean flags to enable/disable sync phases: `contexts`, `identities`, `accounts`, `contextMembers`, `resources`, `entitlements`, `assignments` |
| `contextObjectTypes` | No (default: `Orgunit` only) | Which Omada entity sets to sync as Contexts — see below |
| `resourceCategoryMapping` | No | Maps `ROLECATEGORY` to Identity Atlas `resourceType` — see below |

In the wizard, the **Sync Options** step calls `$metadata` live against the connected Omada server to validate that `contextObjectTypes` entries reference real entity sets and identity fields (case-sensitive).

### `contextObjectTypes`

```json
{
  "contextObjectTypes": [
    { "entitySet": "Orgunit", "contextType": "OrgUnit", "identityField": "OUREF" },
    { "entitySet": "Job_titles", "contextType": "JobTitle", "identityField": "JOBTITLE_REF" }
  ]
}
```

`identityField` links an Identity's reference field to that context type, used to build `ContextMembers` automatically. Entity set and field names must match `$metadata` exactly — Omada names are case-sensitive (e.g. `Job_titles`, not `job_titles`).

### `resourceCategoryMapping`

First matching entry wins; the row with a blank `category` is the catch-all and must be last.

```json
{
  "resourceCategoryMapping": [
    { "category": "Role", "resourceType": "BusinessRole" },
    { "category": "Permission", "resourceType": "Resource" },
    { "category": "", "resourceType": "Resource" }
  ]
}
```

`resourceType` is one of `BusinessRole`, `Resource`, `AppRole`, `DelegatedPermission`.

---

## Troubleshooting

**Omada not visible in "Add Crawler"**
The `CRAWLER_MANIFESTS_DIR` environment variable on the web container must point to the folder containing the crawler manifests. See [Docker setup](../architecture/docker-setup.md).

**`$metadata` returns HTTP 500 (Omada Cloud)**
Some cloud tenants return 500 on `$metadata`. This is non-fatal — the wizard shows a warning but the sync itself still runs all configured phases.

**Cookie session expires during a scheduled sync**
`FormCookie` and `CookieString` sessions typically expire after 20–60 minutes. Use `OAuth2CC` or `OAuth2ROPC` for unattended scheduled syncs.

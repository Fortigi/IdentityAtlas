# Syncing from midPoint (Evolveum)

Identity Atlas can pull authorization and IGA data from a **midPoint** instance via the midPoint REST API. The crawler maps midPoint objects onto the Identity Atlas universal data model — identities, principals, resources, assignments, org units, and certification decisions.

---

## What Gets Imported

| midPoint object | Identity Atlas |
|---|---|
| `ResourceType` (connected systems with accounts) | **Systems** |
| `OrgType` | **Contexts** (type `OrgUnit`, with hierarchy) |
| `RoleType` | **Resources** (type `BusinessRole`); role inducements → `ResourceRelationships` (`Contains`) |
| `ServiceType` | **Resources** (type `Service`) |
| `UserType` (persons/focuses) | **Identities** + a focus Principal + `IdentityMembers` |
| `ShadowType` `kind=account` | **Principals** (accounts on connected systems) |
| `ShadowType` `kind=entitlement` | **Resources** (type `Entitlement`, e.g. AD groups) |
| Account → entitlement membership | **ResourceAssignments** (type `Direct`) |
| `user.assignment[]` → Role/Service | **ResourceAssignments** (type `Governed`) |
| `user.parentOrgRef[]` | **ContextMembers** (org unit membership) |
| Access certification campaigns | **CertificationDecisions** |

midPoint OIDs (UUIDs) are reused directly as `id`/`externalId` in Identity Atlas, so every record is traceable back to the source object.

---

## Prerequisites

- midPoint 4.x or 4.9+ (4.9 is recommended; `referenceAttributes` for AD group memberships requires 4.9)
- A user or service account with REST API access
- Identity Atlas worker container (or standalone PowerShell 7)

---

## Running a Sync

### Via the UI (recommended)

1. Navigate to **Admin → Crawlers**
2. Click **Add Crawler** and select **midPoint (Evolveum)**
3. Fill in the connection details (see [Configuration](#configuration) below)
4. Click **Save** and then **Run now**, or set a schedule

### Via the command line

```powershell
.\tools\crawlers\midpoint\Start-MidpointCrawler.ps1 `
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
| `baseUrl` | Yes | midPoint base URL, e.g. `https://midpoint.example.com/midpoint` or `.../midpoint/ws/rest` |
| `authMethod` | Yes | One of `BasicAuth`, `ApiToken`, `OAuth2CC`, `OAuth2ROPC` |
| `username` | BasicAuth / OAuth2ROPC | midPoint username |
| `password` | BasicAuth / OAuth2ROPC | midPoint password |
| `apiToken` | ApiToken | Static bearer token |
| `clientId` | OAuth2CC / OAuth2ROPC | OAuth2 client ID |
| `clientSecret` | OAuth2CC / OAuth2ROPC | OAuth2 client secret |
| `tokenEndpoint` | OAuth2CC / OAuth2ROPC | OAuth2 token endpoint URL |
| `pageSize` | No (default 100) | Number of records per REST page |
| `syncShadows` | No (default true) | Set to `false` to skip account/entitlement shadow sync |
| `selectedObjects` | No | Object with boolean flags to enable/disable individual sync phases (see below) |

### Sync phase toggles (`selectedObjects`)

All phases are enabled by default. To disable individual phases:

```json
{
  "baseUrl": "https://midpoint.example.com/midpoint",
  "authMethod": "BasicAuth",
  "username": "administrator",
  "password": "...",
  "selectedObjects": {
    "reviews": false,
    "roleNesting": false
  }
}
```

Available phase flags: `systems`, `orgs`, `roles`, `services`, `users`, `shadows`, `orgMembership`, `assignments`, `roleNesting`, `reviews`.

### Role classification (`archetypeMapping`)

By default every `RoleType` becomes a `BusinessRole`. You can override this per **archetype** (matched first) or **subtype** (fallback) — useful when midPoint distinguishes business, application, and technical roles by archetype. A row with both `archetype` and `subtype` blank is the catch-all. (This classifier applies to roles only; `ServiceType` objects are always synced as `Service`.)

In the wizard, the archetype and subtype dropdowns are populated **live** from the connected midPoint server.

```json
{
  "archetypeMapping": [
    { "archetype": "Application Role", "subtype": "", "resourceType": "Application" },
    { "archetype": "", "subtype": "technical", "resourceType": "Resource" },
    { "archetype": "", "subtype": "", "resourceType": "BusinessRole" }
  ]
}
```

`resourceType` is one of `BusinessRole`, `Service`, `Resource`, `Application`, `AppRole`, `Entitlement`, `DelegatedPermission`.

### Org & user type overrides (`typeMappings`)

Map an `OrgType` subtype to a context type, or a `UserType` subtype/`employeeType` to a principal type. Blank key = catch-all. Defaults reproduce the historical behaviour (org → `OrgUnit`, user → `User`).

```json
{
  "typeMappings": {
    "orgContextTypeMapping": [
      { "orgSubtype": "department", "contextType": "Department" },
      { "orgSubtype": "", "contextType": "OrgUnit" }
    ],
    "identityTypeMapping": [
      { "userType": "contractor", "principalType": "ExternalUser" },
      { "userType": "", "principalType": "User" }
    ]
  }
}
```

`principalType` is one of `User`, `ServicePrincipal`, `ManagedIdentity`, `WorkloadIdentity`, `AIAgent`, `ExternalUser`, `SharedMailbox`.

> Leaving `archetypeMapping` and `typeMappings` at their defaults (or omitting them) produces exactly the same output as before these options existed.

---

## Data Scope

Each sync run is **safely scoped**: the crawler only deletes data it owns (matched by `systemId`). Data from other crawlers (Entra, Omada, CSV) is never touched.

---

## Troubleshooting

**midPoint not visible in "Add Crawler"**
The `CRAWLER_MANIFESTS_DIR` environment variable on the web container must point to the folder containing the crawler manifests. See [Docker setup](../architecture/docker-setup.md).

**Shadow search returns 500**
Shadow search requires `?options=raw`. This is handled automatically by the crawler; if you see 500 errors, check your midPoint version (4.x required).

**`buildContexts` post-sync hook returns 404**
The `refresh-contexts` endpoint was renamed in a recent version. This is a non-critical warning — the crawl succeeds and data is correct; org unit contexts are built on the next scheduled context refresh.

**AD group memberships not imported**
midPoint 4.9+ stores account→group relationships as `shadow.referenceAttributes.group[]`. Earlier versions use `association[]`. The crawler reads both forms, but `referenceAttributes` requires midPoint 4.9+.

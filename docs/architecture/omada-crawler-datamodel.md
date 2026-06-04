# Omada IGA Crawler — Data Model Reference

> **Last updated:** 2026-06-04  
> **Tested against:** Omada Identity v15.0 on-premise (OData 4.0) and Omada Cloud (rdw-stg.omada.cloud)

---

## Overview

The Omada IGA crawler pulls data directly from Omada's OData 4.0 REST API (`/odata/dataobjects` and `/odata/builtin`) and pushes it into Identity Atlas via the Ingest API.

**Key characteristics:**
- Always performs a **full sync** (Omada has no delta API; `SyncMode` is accepted for dispatcher compatibility but ignored)
- Registers every Omada connected system as a separate Identity Atlas **System**
- Uses configurable type mappings, context object types, and resource category mapping
- Supports on-premise and Omada Cloud deployments

---

## Authentication Methods

Configure `authMethod` in the crawler config. All methods work for both on-premise and cloud.

| Method | Required fields | Description |
|--------|----------------|-------------|
| `BasicAuth` | `username`, `password` | HTTP Basic Auth — most common for on-premise |
| `FormCookie` | `username`, `password` | POST to `/api/authenticate`, capture session cookie |
| `OAuth2CC` | `clientId`, `clientSecret`, `tokenEndpoint` | OAuth2 client credentials (app registration) |
| `OAuth2ROPC` | `username`, `password`, `clientId`, `clientSecret`, `tokenEndpoint` | OAuth2 resource owner password credentials |
| `ApiToken` | `apiToken` | Static Bearer token (no refresh) |
| `CookieString` | `cookieString` | Pre-built cookie string — use for Omada Cloud when only browser/PS session cookies are available |

**CookieString (cloud):** Paste the `oisauthtoken` value from your browser DevTools or from OmadaWeb.PS. A bare token value is automatically prefixed with `oisauthtoken=`. A valid `name=value` cookie string is sent as-is. Multi-cookie strings (`ASP.NET_SessionId=x; Auth=y`) are also supported unchanged.

---

## URL and Service Root

Configure `baseUrl` as either:
- The OData service root: `https://tenant.omada.cloud/odata/dataobjects` (explicit)
- The server root: `https://tenant.omada.cloud/` (auto-appended with `/odata/dataobjects`)

The crawler uses `System.Uri` to normalise the URL and derives the Builtin service URL automatically:

```
DataObjects: https://tenant.omada.cloud/odata/dataobjects
Builtin:     https://tenant.omada.cloud/odata/builtin
```

The `$metadata` endpoint (used for entity-set discovery) is fetched at startup as a non-blocking diagnostic. If it fails (e.g. HTTP 500 on some cloud instances), all phases still attempt to run.

---

## OData Endpoints Used

| Service | Base URL | Entity sets used |
|---------|----------|-----------------|
| DataObjects | `{baseUrl}` | System, Orgunit, Identity, User, Resource, Resourceassignment, Contextassignment, Employment, Usergroup, Country, Job_titles, + configured context types |
| Builtin | `{builtinBaseUrl}` (derived from DataObjects URL) | CalculatedAssignments |

**Pagination:** `$top=N&$skip=M` offset paging. Stops on **empty page** (not short page — Builtin returns variable-size pages). Default page size: 100 (Builtin CRA: 1000). CRA pages are streamed one-at-a-time to avoid OOM on large datasets.

---

## Configurable Settings

### `contextObjectTypes` (array)

Which Omada entity sets to sync as Identity Atlas Contexts. Each entry:

| Field | Required | Description |
|-------|----------|-------------|
| `entitySet` | Yes | Omada entity set name (case-sensitive, from `$metadata`) |
| `contextType` | No | Identity Atlas contextType label (defaults to entitySet) |
| `identityField` | No | Field on Identity entity that references this context type, used to create ContextMembers automatically |

**Default:**
```json
[{ "entitySet": "Orgunit", "contextType": "OrgUnit", "identityField": "OUREF" }]
```

**Well-known identity→context field mappings** (implicit fallback):

| Identity field | Context entity set |
|----------------|--------------------|
| OUREF | Orgunit |
| COUNTRY | Country |
| BUILDING | Building |
| BUSINESSUNIT | Businessunit |
| COSTCENTER | Costcenter |
| DIVISION | Division |
| JOBTITLE_REF | Job_titles |
| LOCATION | Location |
| SUBAREA | Subarea |

### `resourceCategoryMapping` (array)

Maps Omada `ROLECATEGORY` to Identity Atlas `resourceType`. First matching entry wins; leave `category` blank for the default/catch-all (must be last).

**Default:**

| ROLECATEGORY | Identity Atlas resourceType |
|---|---|
| Role | BusinessRole |
| Permission | Resource |
| *(blank = default)* | Resource |

### `typeMappings` (object, overrides defaults)

| Key | Maps | Default examples |
|-----|------|-----------------|
| `identityTypeToIdentityAtlas` | IDENTITYTYPE.Value → principalType | Employee→User, Contractor→ExternalUser, Machine→ServicePrincipal |
| `contextTypeToIdentityAtlas` | OUTYPE.Value → contextType | OrgUnit→OrgUnit, Department→Department |
| `identityTypesForIdentityTable` | Which IDENTITYTYPE values go into Identities table | [Employee, Primary, Person] |

---

## Sync Phases

### Phase 0: Systems

Every `System` entity in Omada is registered as a separate Identity Atlas System. This drives per-system scoping of resources and assignments.

| | |
|--|--|
| **OData source** | `/System?$filter=Deleted eq false` |
| **IA destination** | `ingest/systems` (full sync) |

**Mapping:**

| Omada field | Identity Atlas field |
|-------------|---------------------|
| UId | tenantId |
| DisplayName | displayName |
| *(constant)* | systemType = `'Omada'` |

`Omada Identity` system (main IGA platform) → used as `systemId` for Contexts, Identities, Principals.

---

### Phase 1: Contexts

Syncs every configured `contextObjectType`. Orgunit uses topological sort (parents before children via `PARENTOU`); all other types are flat.

| | |
|--|--|
| **OData source** | `/{entitySet}?$filter=Deleted eq false` (per configured type) |
| **IA destination** | `ingest/contexts` (full sync, scoped by `{ variant:'synced', contextType }`) |

**Mapping:**

| Omada field | Identity Atlas field |
|-------------|---------------------|
| UId | id, externalId |
| NAME or DisplayName | displayName |
| OUTYPE.Value (mapped) | contextType (Orgunit only; others use config value) |
| PARENTOU.UId | parentContextId (Orgunit only) |
| *(constant)* | variant = `'synced'`, targetType = `'Identity'` |

---

### Phase 2: Identities

Only **person-type** identities (IDENTITYTYPE in `identityTypesForIdentityTable`) are stored in the Identities table.

| | |
|--|--|
| **OData source** | `/Identity?$filter=Deleted eq false` |
| **IA destination** | `ingest/identities` (full sync) |

**Column mapping:**

| Omada field | Identities column |
|-------------|-------------------|
| UId | id, externalId |
| FIRSTNAME + LASTNAME | displayName, givenName, surname |
| EMAIL | email |
| EMPLOYEEID | employeeId |
| JOBTITLE | jobTitle |
| COMPANY.DisplayName | companyName |
| CITY | city |
| COUNTRY.DisplayName | country |

**`extendedAttributes` JSON:**

| Key | Source |
|-----|--------|
| identityType | IDENTITYTYPE.Value |
| identityCategory | IDENTITYCATEGORY.Value |
| identityStatus | IDENTITYSTATUS.Value |
| identityId | IDENTITYID |
| oisId | OISID |
| email2 | EMAIL2 |
| zipCode | ZIPCODE |
| validFrom / validTo | VALIDFROM / VALIDTO |
| riskScore | RISKSCORE |
| riskLevel | RISKLEVEL.DisplayName |
| manager | MANAGER[].DisplayName (joined `'; '`) |
| identityOwner | IDENTITYOWNER.DisplayName |
| explicitOwners | EXPLICITOWNER[].DisplayName (joined `'; '`) |
| ouRefId / ouRefName | OUREF.UId / .DisplayName |
| countryId / countryName | COUNTRY.UId / .DisplayName |
| locationId | LOCATION.UId |
| buildingId | BUILDING.UId |
| businessUnitId | BUSINESSUNIT.UId |
| costCenterId | COSTCENTER.UId |
| divisionId | DIVISION.UId |
| subAreaId | SUBAREA.UId |
| jobTitleRefId / jobTitleRef | JOBTITLE_REF.UId / .DisplayName |
| company | COMPANY.DisplayName |

---

### Phase 3: Accounts (Principals)

Omada `User` entities (accounts) become Identity Atlas Principals. `principalType` is resolved from the linked Identity's IDENTITYTYPE.

| | |
|--|--|
| **OData source** | `/User?$filter=Deleted eq false` |
| **Join key** | User.IDENTITYREF.IDENTITYID = Identity.IDENTITYID |
| **IA destination** | `ingest/principals` (full sync, batched per principalType) |

**Mapping:**

| Omada field | Principals column / extendedAttributes |
|-------------|----------------------------------------|
| UId | id, externalId |
| FIRSTNAME + LASTNAME | displayName |
| EMAIL | email |
| JOBTITLE | jobTitle |
| *(from linked Identity)* | principalType (mapped via typeMappings) |
| *(constant)* | accountEnabled = true |
| UserName | extendedAttributes.userName |

---

### Phase 4: IdentityMembers

Links each Omada User account to its Identity. Only person-type identities (FK guard).

| | |
|--|--|
| **IA destination** | `ingest/identity-members` (full sync) |

| Source | Target field |
|--------|-------------|
| Identity.UId | identityId |
| User.UId | principalId |
| *(constant)* | accountType = `'Primary'` |

---

### Phase 5: Context Members

Three sources combined, deduplicated on `(contextId, memberId)`. Stored with `memberType='Identity'` and `memberId=Identity.UId` so the context detail page query (`WHERE memberType = context.targetType`) finds members correctly.

| | |
|--|--|
| **IA destination** | `ingest/context-members` (full sync, deduped) |

**Source 1 — Contextassignment entity:**
```
CA_IDENTITY.UId → memberId
CA_CONTEXT.UId  → contextId
```

**Source 2 — Direct Identity reference fields** (OUREF, COUNTRY, JOBTITLE_REF, …):
```
Identity.UId                  → memberId
identity.{identityField}.UId  → contextId  (only if UId in $SyncedContextIds)
```

**Source 3 — Employment entity** (IDENTITYREF → OUREF, if entity set available):
```
IDENTITYREF.UId → memberId
OUREF.UId       → contextId
```

All records: `memberType='Identity'`, `addedBy='sync'`. FK guard: memberId must be in Identities table.

---

### Phase 6: Resources

Resources grouped by their connected system (`SYSTEMREF`) for correct per-system scoped-delete.

| | |
|--|--|
| **OData source** | `/Resource?$filter=Deleted eq false` |
| **Pre-fetch** | `/Usergroup` (for USERGROUPREF name lookup) |
| **IA destination** | `ingest/resources` (full sync, per-system batches) |
| **Type mapping** | ROLECATEGORY.Value → resourceType via `resourceCategoryMapping` |

**Column mapping:**

| Omada field | Resources column |
|-------------|-----------------|
| UId | id, externalId |
| NAME or DisplayName | displayName |
| DESCRIPTION | description |
| ROLECATEGORY (mapped) | resourceType |
| RESOURCESTATUS | enabled (false if Inactive/Disabled/Deleted) |

**`extendedAttributes` JSON:**

| Key | Source |
|-----|--------|
| resourceCategory | ROLECATEGORY.Value |
| resourceType | ROLETYPEREF.DisplayName |
| roleFolder | ROLEFOLDER.DisplayName |
| skipProvisioning | SKIPPROVISIONING (bool) |
| userGroupName | USERGROUPREF → Usergroup.DisplayName lookup |
| explicitOwner | EXPLICITOWNER[].DisplayName (joined `'; '`) |
| manualOwner | MANUALOWNER[].DisplayName (joined `'; '`) |
| omadaSystem | SYSTEMREF.DisplayName |

---

### Phase 7: Entitlements

Role nesting extracted from `Resource.CHILDROLES` — no separate endpoint exists.

| | |
|--|--|
| **Source** | `$AllResources` (pre-fetched in Phase 6), `Resource.CHILDROLES` collection |
| **IA destination** | `ingest/resource-relationships` (full sync, scope `{relationshipType:'Contains'}`) |

| Field | Value |
|-------|-------|
| parentResourceId | Resource.UId |
| childResourceId | CHILDROLES[n].UId |
| relationshipType | `'Contains'` |

---

### Phase 8: Assignments

Two sources combined for comprehensive coverage:

#### Source A — Resourceassignment (role/permission assignments, IGA-governed)

| | |
|--|--|
| **OData source** | `/Resourceassignment?$filter=Deleted eq false` |
| **Filter** | ROLEASSNSTATUS.Value in `['Active', 'Pending']` |
| **Fan-out** | Each identity assignment → one record per linked User account (via `$IdentityUidToUserUids`) |
| **IA destination** | `ingest/resource-assignments` (full sync, per-system, `assignmentType='Governed'`) |
| **Deduplication** | YES — on `principalId|resourceId` per system |

| Omada field | ResourceAssignments column / extendedAttributes |
|-------------|------------------------------------------------|
| ROLEREF.UId | resourceId |
| *(fanned via Identity.UId)* | principalId (User.UId) |
| *(constant)* | assignmentType = `'Governed'` |
| VALIDFROM / VALIDTO | extendedAttributes.validFrom / validTo |

#### Source B — CalculatedAssignments (account provisioning, all systems)

| | |
|--|--|
| **OData source** | `/odata/builtin/CalculatedAssignments?$filter=Status eq true&$expand=Identity,Resource,System,ResourceType` |
| **Page size** | 1000 (server default; stops on empty page) |
| **IA destination** | `ingest/principals` (delta) + `ingest/identity-members` (delta) + `ingest/resource-assignments` (full sync, per-system) |

Two sub-tracks based on which Omada system the account belongs to:

**Omada Identity accounts** (AccountName → `$UserNameToUid` lookup):
```
principalId  = existing User.UId
assignmentType = Governed (IsManaged=true) or Direct (IsManaged=false)
```

**Connected-system accounts** (Salesforce, AD, etc. — AccountKey as new Principal id):
```
New Principal:
  AccountKey       → id
  AccountName      → externalId
  FIRSTNAME/LASTNAME → displayName
  EMAIL            → email
  (constant)       → principalType = 'User'
  Status           → accountEnabled

New IdentityMember:
  Identity.UId     → identityId  (FK guard: person types only)
  AccountKey       → principalId
  ResourceType.DisplayName → accountType

ResourceAssignment:
  Resource.UId     → resourceId
  AccountKey       → principalId
  IsManaged=true   → assignmentType = 'Governed'
  IsManaged=false  → assignmentType = 'Direct'
```

**`extendedAttributes` on CRA assignments:**

| Key | Source |
|-----|--------|
| validFrom / validTo | ValidFrom / ValidTo |
| status | `'Enabled'` (Status=true) or `'Disabled'` |
| reasons | Reasons[].Description (joined `'; '`) |
| accountType | ResourceType.DisplayName |
| accountName | AccountName |

---

## Entity Relationship Summary

```
Systems (58 connected systems, 1 per Omada System entity)
  └─ Resources       (grouped by systemId)
  └─ Principals      (grouped by systemId — Omada accounts + CRA-derived accounts)
  └─ ResourceAssignments (grouped by systemId)

Identities (person-type identities only: Employee, Primary, Person)
  └─ IdentityMembers → Principals (Omada User accounts)
  └─ IdentityMembers → Principals (connected-system accounts, from CRA)
  └─ ContextMembers  → Contexts (memberType='Identity')

Contexts (OrgUnit hierarchy + configured flat types e.g. JOB_TITLES)
  └─ ContextMembers  (from Contextassignment + direct refs + Employment)

Resources → ResourceRelationships (Contains, from CHILDROLES)
Principals → ResourceAssignments → Resources
```

---

## Shared State Variables (inter-phase dependencies)

| Variable | Built in phase | Used in phases |
|----------|---------------|----------------|
| `$AllOmadaSystems` | Systems | Contexts, Resources, Assignments (label lookups) |
| `$OmadaSystemMap` (UId→systemId) | Systems | Resources, Assignments |
| `$OmadaIdentitySystemUId` | Systems | Assignments (distinguishes Omada vs connected-system accounts) |
| `$SyncedContextIds` | Contexts | ContextMembers (filter out unknown CA_CONTEXT refs) |
| `$AllIdentities` | Identities | Accounts (principalType lookup), ContextMembers (direct refs) |
| `$IdentityLookup` (IDENTITYID→{uid,type}) | Identities | Accounts |
| `$IdentityUidInIdentitiesTable` | Identities | ContextMembers, Assignments (FK guard) |
| `$AllAccounts` | Accounts | IdentityMembers, ContextMembers, Assignments |
| `$UserNameToUid` (UserName→UId) | Accounts | Assignments (CRA Omada-account lookup) |
| `$IdentityUidToUserUids` (IdentityUId→[UserUIds]) | Accounts | ContextMembers, Assignments (fan-out) |
| `$UserGroupMap` (UId→DisplayName) | Resources (pre-fetch) | Resources |
| `$AllResources` | Resources | Entitlements |

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Ingest HTTP 429 / 5xx | Retry with exponential backoff: 2s, 4s, 8s, 16s, 32s (max 5 retries) |
| Ingest HTTP 409 (job cancelled) | Throw immediately — aborts crawl |
| Ingest HTTP 4xx (non-429) | Throw immediately |
| OData entity set not in `$metadata` | Skip with yellow warning; continue |
| CRA endpoint HTTP 404/400/501 | Skip gracefully (module not installed) |
| Build-FGContexts 404 | Not called for Omada (Omada syncs its own contexts directly) |
| `JOBTITLE_REF` contextId not in `$SyncedContextIds` | Skip ContextMember silently |
| Identity not in `$IdentityUidInIdentitiesTable` | Skip IdentityMember / ContextMember (FK guard) |

---

## Post-Sync Hooks

After all phases complete:

1. **Phase results** → `POST /api/crawlers/jobs/:id/phases` (per-phase timing + status)
2. **View refresh** → `POST /api/ingest/refresh-views` — refreshes `vw_ResourceUserPermissionAssignments` materialized view, recalculates `directMemberCount`/`totalMemberCount` on all Contexts, updates `lastSyncDateTime` on all Systems that have synced data

---

## Test Environments

### On-Premise (masterdemo)

| Property | Value |
|----------|-------|
| Hostname | `enterpriseserver.corporate.com` (→ `masterdemo.corporate.com` → `172.16.0.28`) |
| Auth method | BasicAuth (`corporate\demoadm`) |
| API version | v15.0 |
| Entity sets | 25 (DataObjects) + CalculatedAssignments (Builtin) |
| Systems | 58 connected systems |
| Identities | 332 (321 person-type) |
| Contexts | 322 OrgUnits + 28 Job Titles |
| Resources | 13,220 across all systems |
| CRA records | ~37,961 active (Status=true) |

DNS: AD DNS at `172.16.0.25`/`172.16.0.28` resolves `corporate.com` zone. Persisted via `extra_hosts` in `docker-compose.yml`.

### Cloud (rdw-stg.omada.cloud)

| Property | Value |
|----------|-------|
| Base URL | `https://rdw-stg.omada.cloud/` (auto-normalised to `/odata/dataobjects`) |
| Auth method | CookieString (`oisauthtoken=<token>`) |
| Entity sets | 18 available (subset of on-premise; `$metadata` may return 500 — gracefully skipped) |
| Systems | 41 connected systems |
| Identities | 4,279 |
| Contexts | 403 OrgUnits + 277 Job Titles |
| Resources | 30,355+ across all systems |
| CRA records | 12,421+ active |

**Cloud notes:** The `$metadata` endpoint on cloud may return HTTP 500 — this is handled gracefully (all phases still run). CookieString auth sends the cookie in a `Cookie` request header (not via WebSession), which is required for cloud HTTPS URLs where WebSession cookie-domain matching is unreliable.

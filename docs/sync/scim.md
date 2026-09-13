# Syncing from a SCIM 2.0 endpoint

Identity Atlas can pull accounts and group memberships from **any SCIM 2.0 service
provider** — SAP Cloud Identity Services, Okta, a home-grown SCIM façade, anything
that speaks [RFC 7643/7644](https://datatracker.ietf.org/doc/html/rfc7644). There is
no vendor-specific code: the crawler asks the endpoint what it serves
(`/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`) and reads the standard
`/Users` and `/Groups` collections.

!!! warning "This crawler is experimental"
    It is built and covered by automated tests, but it has had only limited
    opportunity to prove itself against real SCIM providers. It therefore does not
    appear in **Add Crawler** until you switch on **Admin → Experimental →
    Experimental crawlers**. Turning that switch back off later leaves a SCIM
    crawler you already configured running — it only stops new ones being added.
    See [Experimental features](../reference/experimental-features.md).

---

## What Gets Imported

| SCIM object | Identity Atlas |
|---|---|
| `User` | **Principals** (`principalType` from your user-type mapping, default `User`) |
| `Group` | **Resources** (`resourceType = Group`) |
| Group member that is a user | **ResourceAssignments** (`assignmentType = Direct`) |
| Group member that is another group | **ResourceRelationships** (`Contains`) **and** a per-user `Indirect` ResourceAssignment on the outer group |

The SCIM `id` is preserved as `externalId` on every record, and the Identity Atlas
primary key is derived from it deterministically — so re-running a sync updates the
same rows instead of creating new ones.

### Always-synced core mapping

| SCIM attribute | Identity Atlas field |
|---|---|
| `id` | `externalId` |
| `displayName` (falls back to `userName`, then `id`) | `displayName` |
| `userName` | stored in `extendedAttributes` |
| `active` | `accountEnabled` (`active: false` → disabled) |
| `emails` — the entry flagged `primary`, else the first with a value | `email` |
| `name.givenName` / `name.familyName` | `givenName` / `surname` |
| `title` | `jobTitle` |
| `userType` | drives the principal-type mapping (see below) |

Group: `id` → `externalId`, `displayName` → `displayName`, `resourceType = Group`.

### Extra attributes are opt-in

Nothing beyond the core mapping is synced unless you pick it. The wizard's
**Attributes** step lists every *simple* attribute the endpoint declares in
`/Schemas` (complex attributes contribute their simple sub-attributes as
`name.middleName`; multi-valued attributes are not offered in v1), starting with
nothing selected and a **Select all** action per object type. Selected attributes
land in the record's `extendedAttributes` JSON.

---

## Prerequisites

- A SCIM 2.0 endpoint that serves `/Users` and `/Groups` with `startIndex`/`count` paging
- Credentials for one of the supported auth methods (below)
- The endpoint must be reachable from the Identity Atlas worker container

---

## Running a Sync

### Via the UI (recommended)

1. Navigate to **Admin → Crawlers**
2. Click **Add Crawler** and select **SCIM 2.0**
3. Work through the six steps: connection → credentials → objects → attributes →
   type mapping → schedule
4. Click **Add Crawler**, then **Run now**

Steps 3 and 4 run live discovery against the endpoint, which doubles as a
credential check: a failure is reported inline with the reason.

### Via the command line

```powershell
.\tools\crawlers\scim\Start-ScimCrawler.ps1 `
    -ApiBaseUrl "http://localhost:3001/api" `
    -ApiKey "fgc_abc123..." `
    -JobId 0 `
    -ConfigPath ".\myconfig.json"
```

---

## Configuration

| Field | Required | Description |
|---|---|---|
| `baseUrl` | Yes | The URL that serves `/Users` and `/Groups`, e.g. `https://api.example.com/scim/v2` |
| `authMethod` | Yes | One of `BasicAuth`, `ApiToken`, `OAuth2CC` |
| `username` / `password` | BasicAuth | HTTP Basic credentials |
| `apiToken` | ApiToken | Static bearer token |
| `tokenEndpoint` / `clientId` / `clientSecret` | OAuth2CC | OAuth2 client-credentials grant |
| `scope` | No | Optional OAuth2 scope requested with the client-credentials grant |
| `systemName` | No (default `SCIM`) | How this source is labelled in Identity Atlas |
| `pageSize` | No (default 100) | The SCIM `count` parameter |
| `selectedObjects` | No | `{ users, groups, groupMembers }` booleans — all default to `true` |
| `selectedAttributes` | No | `{ user: [...], group: [...] }` — the opt-in extras, empty by default |
| `userTypeMapping` | No | Rows of `{ userType, principalType }`; a blank `userType` is the catch-all |

Secrets (`password`, `apiToken`, `clientSecret`) are never stored in the config blob
— they go to the secrets vault and are injected into the job at dispatch time.

### Example

```json
{
  "baseUrl": "https://cis.example.com/scim/v2",
  "authMethod": "OAuth2CC",
  "tokenEndpoint": "https://cis.example.com/oauth/token",
  "clientId": "identity-atlas",
  "systemName": "SAP CIS",
  "pageSize": 100,
  "selectedObjects": { "users": true, "groups": true, "groupMembers": true },
  "selectedAttributes": { "user": ["department", "costCenter"], "group": ["description"] },
  "userTypeMapping": [
    { "userType": "technical", "principalType": "ServicePrincipal" },
    { "userType": "", "principalType": "User" }
  ]
}
```

### Mapping user types to principal types

SCIM's `userType` is a free-form string, so the crawler maps it onto the Identity
Atlas principal-type vocabulary. Matching is case-insensitive and exact; a row with
a blank `userType` is the catch-all; with no match and no catch-all an account is a
plain `User`. Valid principal types are `User`, `ServicePrincipal`,
`ManagedIdentity`, `WorkloadIdentity`, `AIAgent`, `ExternalUser` and `SharedMailbox`.

---

## Scheduling and sync mode

Schedules work exactly as they do for every pull crawler. **SCIM 2.0 defines no
standard change feed or watermark**, so there is no real delta sync: if a schedule
(or a manual run) asks for a delta, the crawler executes a full sync and says so in
the job log. Full syncs are idempotent, so this is safe to run on any cadence your
endpoint can serve.

---

## What a full sync deletes

A full sync reconciles: rows this crawler previously wrote that the endpoint no
longer serves are deleted. The delete is scoped to this crawler's own system — and,
for principals, additionally partitioned by mapped `principalType` — so it can never
touch another connector's data, and a `ServicePrincipal` batch can never delete the
`User` rows.

---

## Limitations (v1)

- **Read-only.** No SCIM write-back, no `/Bulk`, no `PATCH`.
- **Users and groups only.** Other resource types the endpoint serves are listed in
  the wizard as *visible but not yet syncable*.
- **No delta sync** (see above).
- **No mTLS / X.509 client-certificate auth**, and no OAuth2 resource-owner
  password grant.
- **Simple attributes only** in the opt-in picker — multi-valued attributes other
  than `emails` (which is part of the core mapping) are not stored.
- **No Identities.** SCIM supplies accounts; the scheduled Account Linking engine
  correlates them into identities afterwards, exactly as for every other account
  source.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Discovery says *Could not reach the SCIM endpoint: /ResourceTypes returned HTTP 401* | Wrong credentials, or the endpoint expects a different auth scheme than the one selected. |
| Discovery says *baseUrl rejected* | The base URL resolves to a private, loopback or cloud-metadata address. The API refuses to fetch those with a stored credential. |
| The attribute picker is empty | The endpoint does not serve `/Schemas`, or its schemas declare no simple attributes beyond the core mapping. The sync still works — only the opt-in extras are unavailable. |
| Group members are missing | Members whose id matches neither a synced user nor a synced group are skipped and counted; the job log reports how many. That usually means the group contains a resource type this crawler does not sync yet. |
| Users appear but no memberships | Check that **Group members** is enabled in the wizard's Objects step, and that the endpoint returns `members` on `/Groups` (some providers require an explicit attribute request). |

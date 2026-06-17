# midPoint Crawler — Configuration Reference

This page documents every configuration field of the **midPoint (Evolveum)** crawler, its
default value, and when you need to change it.

> **In short:** the only thing you *must* provide is the **connection** — the base URL,
> authentication method, and credentials. **Every other field ships with a sensible default**
> that reproduces midPoint's standard mapping, so you can leave the rest untouched and a sync
> will "just work". Change the mapping fields only when you want to override how midPoint objects
> are classified in Identity Atlas.

You configure the crawler in the UI under **Admin → Crawlers → Add Crawler → midPoint (Evolveum)**.
The four wizard steps map 1:1 to the sections below.

---

## 1. Connection & authentication *(required — no usable default)*

This is the only part you always have to fill in.

| Field | Default | Description |
|---|---|---|
| **Crawler Name** (`displayName`) | `midPoint (Evolveum)` | A label for this crawler in the UI. Pre-filled; change it if you run more than one midPoint connection. |
| **Base URL** (`baseUrl`) | — *(required)* | Your midPoint URL, e.g. `https://midpoint.example.com/midpoint` or `…/midpoint/ws/rest`. A bare host also works (the crawler appends `/midpoint/ws/rest`). |
| **Authentication Method** (`authMethod`) | `BasicAuth` | How the crawler authenticates to the midPoint REST API. One of `BasicAuth`, `ApiToken`, `OAuth2CC`, `OAuth2ROPC`. |

### Credentials per authentication method

Which credential fields appear depends on the method you pick. None have defaults — you supply them.

| Method | Required fields | Use when |
|---|---|---|
| **BasicAuth** | `username`, `password` | Standard midPoint user/service account (most common). |
| **ApiToken** | `apiToken` | A static bearer token is issued for the crawler. |
| **OAuth2CC** (client credentials) | `tokenEndpoint`, `clientId`, `clientSecret` | Service-to-service OAuth2, no user context. |
| **OAuth2ROPC** (resource owner password) | `tokenEndpoint`, `clientId`, `clientSecret`, `username`, `password` | OAuth2 on behalf of a specific user. |

> **Editing later:** secret fields (`password`, `apiToken`, `clientSecret`) show as `••••••••` and can
> be left **blank to keep the stored value**. Secrets are stored encrypted; the `clientSecret` lives
> in the secrets vault and is never written to the config in plain text.

---

## 2. Sync scope — which object types to import *(all default ON)*

`selectedObjects` is a set of toggles, **all enabled by default**. Turn one off only to skip that
phase (e.g. to do a quick roles-only run, or to skip the heavy shadows phase).

| Toggle (`selectedObjects.*`) | Default | What it imports |
|---|---|---|
| `systems` | ✅ on | Connected resources (`ResourceType`) that hold accounts → **Systems** |
| `orgs` | ✅ on | `OrgType` → **Contexts** (org hierarchy) |
| `roles` | ✅ on | `RoleType` → **Resources** (classified via §4) |
| `services` | ✅ on | `ServiceType` → **Resources** (always type `Service`) |
| `users` | ✅ on | `UserType` → **Identities** + a focus **Principal** |
| `shadows` | ✅ on | Accounts + entitlements on connected systems (the slowest phase) |
| `orgMembership` | ✅ on | `user.parentOrgRef` → **Context members** |
| `assignments` | ✅ on | `user.assignment` → **ResourceAssignments** (`Governed`) |
| `roleNesting` | ✅ on | `role.inducement` → **ResourceRelationships** (`Contains`) |
| `reviews` | ✅ on | Certification campaigns → **CertificationDecisions** |

> **Recommendation:** leave all on for a complete picture. Disabling `shadows` makes runs much
> faster but you lose account/entitlement (e.g. AD group membership) data.

---

## 3. Performance

| Field | Default | Description |
|---|---|---|
| **Page size** (`pageSize`) | `100` | Objects fetched per REST request. Leave at 100 unless you are tuning for very large datasets; smaller pages reduce worker memory, larger pages reduce round-trips. |

---

## 4. Role classification (`archetypeMapping`) *(default = every role → BusinessRole)*

By default every `RoleType` becomes a `BusinessRole`. This table lets you override that **per role**,
based on midPoint's own role classification. **It applies to roles only — `ServiceType` is always
imported as `Service`.**

**How a role is matched (in order):**
1. **Archetype** — if the role has an archetype whose name matches a rule, that rule wins.
2. **Subtype** — otherwise, if the role's subtype matches a rule, that rule applies.
3. **Catch-all** — otherwise the rule with a blank archetype *and* blank subtype applies.
4. **Default** — if nothing matches at all, the role becomes `BusinessRole`.

**Default value:** a single catch-all row → `BusinessRole`, i.e. identical to the old behaviour.

| Column | Description |
|---|---|
| **Archetype** | The midPoint archetype name (e.g. *Business role*, *Application role*). The dropdown is populated **live** from your midPoint server. Leave blank for a subtype-only or catch-all rule. |
| **Subtype** | The role's `subtype` value — a free-text label set on the role in midPoint. Used as a fallback when no archetype matches. The dropdown suggests subtype values **found on your objects** (so it is empty if your midPoint doesn't use subtypes); you can also type a value. |
| **Identity Atlas type** | The resulting `resourceType`. One of `BusinessRole`, `Service`, `Resource`, `Application`, `AppRole`, `Entitlement`, `DelegatedPermission`. |

> **Archetype vs. subtype.** An *archetype* is a first-class object in midPoint (a catalog entry like
> "Application role" with its own policies/icon) — modern and structured. A *subtype* is just a free-text
> label on the object — older and lighter. The matching tries archetype first, then subtype, so the
> mapping works whether your environment classifies roles by archetypes, by subtypes, or by neither.

**Example** — treat application roles as `Application`, fall back to business roles:

```json
"archetypeMapping": [
  { "archetype": "Application role", "subtype": "", "resourceType": "Application" },
  { "archetype": "", "subtype": "technical", "resourceType": "Resource" },
  { "archetype": "", "subtype": "", "resourceType": "BusinessRole" }
]
```

---

## 5. Org & user type overrides (`typeMappings`) *(advanced — defaults preserve current behaviour)*

Under **Advanced type mappings**. Two optional tables, each defaulting to a single catch-all that
reproduces the standard behaviour.

### Reading a mapping row: left side vs. right side

Every row in these tables (and in the role classification of §4) has the same shape — a **left
side** that is matched against your midPoint data, and a **right side** that is the resulting
Identity Atlas type:

- **Left = the value as it exists in midPoint.** It is matched against the object's `subtype`
  (for users also `employeeType`). The input is a **live dropdown**: it suggests the subtype values
  that actually occur in *your* midPoint (fetched from the server when you open the step), and you
  can also type a value that isn't there yet. The dropdown is empty only when your midPoint uses no
  subtypes — then you simply rely on the catch-all (a blank left side).
- **Right = an Identity Atlas type that you assign.** This is *not* read from midPoint — these target
  types are Identity Atlas concepts. midPoint has no notion of an Identity Atlas "context type" or
  "principal type". You may give the right side the same name as the midPoint value (e.g. subtype
  `department` → context type `Department`), but that is your choice, not an automatic copy.

> **No automatic pass-through.** There is no mode that "uses each org's own subtype as its context
> type". You map each subtype explicitly (one row per value), plus one catch-all row (blank left
> side) for everything else. To turn five distinct subtypes into five different context types, add
> five rows.

The two tables differ in how *free* the right side is:

| Mapping | Left side (from midPoint) | Right side (Identity Atlas type) |
|---|---|---|
| Org → context type | Org `subtype` — live dropdown, free-typeable | **Free text** — any label you choose (≤50 chars) |
| User → principal type | User `subtype`/`employeeType` — live dropdown, free-typeable | **Fixed list** — must be a valid principal type (validated) |

The right side of the **user** mapping is a closed dropdown because `principalType` is validated
against Identity Atlas's known set; an arbitrary value would be rejected on import. The right side of
the **org** mapping (`contextType`) has no such constraint, so it is a free text field and Identity
Atlas stores whatever you type verbatim.

### Org → context type (`typeMappings.orgContextTypeMapping`)

Maps an `OrgType`'s subtype to a context type. **Default:** catch-all → `OrgUnit`.

| Column | Description |
|---|---|
| **Org subtype** | *Left.* The org's `subtype` value — live dropdown from your midPoint, free-typeable. Blank = catch-all. |
| **Context type** | *Right.* The resulting `contextType` — a free-text Identity Atlas label you choose (e.g. `OrgUnit`, `Department`, `Country`), stored verbatim. |

### User → principal type (`typeMappings.identityTypeMapping`)

Maps a `UserType`'s subtype/`employeeType` to a principal type. **Default:** catch-all → `User`.

| Column | Description |
|---|---|
| **User subtype** | *Left.* The user's `subtype`/`employeeType` value — live dropdown from your midPoint, free-typeable. Blank = catch-all. |
| **Principal type** | *Right.* The resulting `principalType`, chosen from a fixed dropdown: `User`, `ServicePrincipal`, `ManagedIdentity`, `WorkloadIdentity`, `AIAgent`, `ExternalUser`, `SharedMailbox`. |

> **Note:** the same "left = midPoint subtype dropdown" applies to the **Subtype** column of the role
> classification in §4; only the *archetype* column there is filled from midPoint's archetype catalog
> rather than from observed subtype values.

---

## 6. Scheduling *(default = none / on-demand only)*

`schedules` is empty by default — the crawler runs only when you click **Run Now**. Add one or more
schedules to run it automatically.

| Field | Default | Description |
|---|---|---|
| `syncMode` | `full` | `full` re-fetches everything and removes data this crawler owns that no longer exists in midPoint (reconcile). `delta` only adds/updates (upsert-only, no deletions) — faster, but stale rows are not cleaned up. |
| `frequency` | `daily` | `hourly`, `daily`, or `weekly`. |
| `hour` / `minute` | `2` / `0` | Time of day (UTC) for daily/weekly runs. |
| `day` | — | Day of week for `weekly` (0 = Sunday … 6 = Saturday). |

> Use a daily/weekly **full** sync for correctness; add an optional more-frequent **delta** if you want
> fresher data between full runs.

---

## 7. Complete field reference

| Field | Default | Required? | Section |
|---|---|---|---|
| `displayName` | `midPoint (Evolveum)` | recommended | 1 |
| `baseUrl` | — | **yes** | 1 |
| `authMethod` | `BasicAuth` | **yes** | 1 |
| `username` | — | for BasicAuth / OAuth2ROPC | 1 |
| `password` | — | for BasicAuth / OAuth2ROPC | 1 |
| `apiToken` | — | for ApiToken | 1 |
| `clientId` | — | for OAuth2CC / OAuth2ROPC | 1 |
| `clientSecret` | — | for OAuth2CC / OAuth2ROPC | 1 |
| `tokenEndpoint` | — | for OAuth2CC / OAuth2ROPC | 1 |
| `selectedObjects.*` (10 toggles) | all `true` | no | 2 |
| `pageSize` | `100` | no | 3 |
| `archetypeMapping` | `[{ "": "" → BusinessRole }]` | no | 4 |
| `typeMappings.orgContextTypeMapping` | `[{ "" → OrgUnit }]` | no | 5 |
| `typeMappings.identityTypeMapping` | `[{ "" → User }]` | no | 5 |
| `schedules` | `[]` (on-demand) | no | 6 |

---

## 8. Example configurations

**Minimal** — connect and import everything with default mappings (the recommended starting point):

```json
{
  "baseUrl": "https://midpoint.example.com/midpoint",
  "authMethod": "BasicAuth",
  "username": "svc-identityatlas",
  "password": "••••••"
}
```

**Advanced** — custom role classification, a daily full sync, and shadows disabled:

```json
{
  "baseUrl": "https://midpoint.example.com/midpoint",
  "authMethod": "BasicAuth",
  "username": "svc-identityatlas",
  "password": "••••••",
  "pageSize": 100,
  "selectedObjects": { "shadows": false },
  "archetypeMapping": [
    { "archetype": "Application role", "subtype": "", "resourceType": "Application" },
    { "archetype": "", "subtype": "", "resourceType": "BusinessRole" }
  ],
  "typeMappings": {
    "identityTypeMapping": [
      { "userType": "contractor", "principalType": "ExternalUser" },
      { "userType": "", "principalType": "User" }
    ]
  },
  "schedules": [
    { "syncMode": "full", "frequency": "daily", "hour": 2, "minute": 0 }
  ]
}
```

---

See also: [Syncing from midPoint (Evolveum)](midpoint.md) for what gets imported and the overall data model.

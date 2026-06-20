# Azure Resource Manager crawler

Syncs **Azure RBAC** — the management-group → subscription → resource-group (→ resource)
hierarchy and the role assignments on it — into Identity Atlas, so Azure scope access shows up
in the Matrix alongside Entra ID, Omada, and everything else.

Inheritance is **not** materialised. The crawler stores only *declared* role assignments plus
the scope hierarchy; the [effective-access engine](../architecture/effective-access-engine.md)
computes inheritance on demand — a role at a parent scope appears as **Indirect** on every
descendant, with nothing stored for the descendants.

---

## What you need

A **service principal** (app registration) with a **client secret**, granted the built-in
**Reader** role at the scope you want crawled:

| Scope of the Reader assignment | What gets crawled |
|---|---|
| **Management group** | The whole MG → subscription → resource-group hierarchy beneath it, and all RBAC |
| A single **subscription** | That subscription, its resource groups, and their RBAC |

`Reader` is sufficient and safe — it grants `*/read`, which covers
`Microsoft.Authorization/roleAssignments/read` + `roleDefinitions/read` and the scope hierarchy.
**No write access is required.**

> **Tip:** if the same service principal also has Microsoft Graph directory-read permission and
> you run the **Entra ID** crawler with it, Azure role assignments resolve to **named** users and
> groups automatically (same tenant, same object IDs) — and group-held Azure roles fan out to
> their members.

---

## Configuration

| Field | Required | Description |
|---|---|---|
| `tenantId` | ✅ | Azure AD tenant (directory) ID |
| `clientId` | ✅ | Service principal application (client) ID |
| `clientSecret` | ✅ | Service principal client secret |
| `managementGroupId` | — | Crawl only the hierarchy beneath this management group |
| `subscriptionIds` | — | Limit the crawl to these subscription IDs (otherwise all accessible) |
| `includeResourceLevel` | — | Also enumerate individual resources (high volume; default `false`) |
| `includeCustomRoles` | — | Resolve tenant custom role definitions too (default `true`) |

Add it from **Admin → Crawlers → Add Crawler → Azure Resource Manager**, or via the API.

---

## What it produces

| Emitted | As |
|---|---|
| Management groups, subscriptions, resource groups (and resources) | `Resources` (`AzureManagementGroup` / `AzureSubscription` / `AzureResourceGroup` / `AzureResource`) linked by `Contains` |
| Each declared role assignment | one `Role @ Scope` capability-resource (`resourceType='AzureRoleAssignment'`) + a `Direct` `allow` assignment to the principal |
| Built-in + custom role definitions | resolved to friendly role names on the capability-resources |
| Users / service principals referenced by assignments | thin `Principals` stubs (named once the Entra crawler runs) |
| Management groups + subscriptions | also emitted as **Contexts** for matrix filtering |

**Worked example:** a `Contributor` assignment at *Subscription Foo* becomes one
`Contributor @ Subscription Foo` resource with one assignment. Querying effective access on a
resource group *under* Foo returns `Contributor` with badge **Indirect** — inherited down the
`Contains` tree, never stored.

---

## Notes

- Azure RM is a JSON REST API (not OData), so this crawler does **not** depend on the `odata`
  base layer. Auth reuses `Get-FGAccessToken` against `https://management.azure.com/`.
- Reads honour Azure's throttling (`429` + `Retry-After`) and token refresh on long crawls.
- `atScope()` is used when reading role assignments, so only assignments *declared* at each
  scope are stored — inheritance is the engine's job.

## See also

- [`docs/architecture/effective-access-engine.md`](../architecture/effective-access-engine.md) — how inherited access is computed
- [`docs/sync/building-a-crawler.md`](building-a-crawler.md) — "Feeding the Effective-Access Engine"

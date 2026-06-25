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
- **Reads via Azure Resource Graph.** Resource groups, resources, role definitions and role
  assignments are read from [Azure Resource Graph](https://learn.microsoft.com/azure/governance/resource-graph/)
  in a few paged queries across every subscription at once, rather than one list call per
  subscription — so the crawl scales to hundreds of subscriptions with far fewer round-trips.
  (Subscriptions and the management-group hierarchy are still enumerated over the ARM REST API; those
  are single calls, not per-subscription fan-out.) Two Resource Graph details: the role-assignments
  query uses `authorizationScopeFilter=AtScopeAboveAndBelow` so management-group and tenant-root
  declared assignments are returned (the principal still only sees what it has Reader on); and the
  built-in role-definition catalog is fetched with `AtScopeAndAbove`, since a plain at-or-below query
  does not surface it.
- Only assignments *declared* at each scope are stored (at the assignment's own `properties.scope`);
  inheritance down the `Contains` hierarchy is the effective-access engine's job, computed on demand.

## See also

- [`docs/architecture/effective-access-engine.md`](../architecture/effective-access-engine.md) — how inherited access is computed
- [`docs/sync/building-a-crawler.md`](building-a-crawler.md) — "Feeding the Effective-Access Engine"

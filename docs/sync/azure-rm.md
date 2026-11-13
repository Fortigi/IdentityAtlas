# Connect Azure Resource Manager

The Azure Resource Manager crawler reads **Azure RBAC**: your management groups, subscriptions and resource groups, and the role assignments made on them. Azure access then shows up in Identity Atlas next to the access from Entra ID and your other sources. It only reads; nothing is changed in Azure.

**Use this when** you want to see who holds which Azure role — Owner, Contributor, Reader, a custom role — and on which management group, subscription or resource group.

---

## What you get

| In Azure | In Identity Atlas |
|---|---|
| Management groups, subscriptions, resource groups, and optionally individual resources | Resources of type `AzureManagementGroup`, `AzureSubscription`, `AzureResourceGroup` and `AzureResource`, linked parent to child |
| Each role assignment | One resource per role and place, of type `AzureRoleAssignment`, named after both — for example `Contributor @ Sub: Contoso-Prod` — with a **Direct** assignment to the account that holds it |
| Built-in and custom role definitions | The role names used in those resource names |
| The accounts that hold roles | The accounts the Entra ID crawler already loaded. This crawler refers to them and does not change them |

The Azure hierarchy can also be turned into contexts by the `scope-hierarchy` and `resource-type-tree` context plugins, which build them from the resources above.

**One role, one place.** A role assignment is stored once, at the place where it was made in Azure. A `Contributor` role given on a subscription is one resource with one assignment. It is not repeated on every resource group inside that subscription, even though Azure lets the role work there too. How inherited access is worked out when you ask for it is described in [Effective access](../architecture/effective-access-engine.md).

---

## Before you start

- **Run the Entra ID crawler first**, for the same tenant. Azure role assignments point at accounts in Entra ID, and this crawler uses the accounts that crawler loaded. See [Connect Entra ID](entra-id.md).
- **A service principal** (app registration) with a **client secret**. You need its tenant ID, client ID and secret.
- **The built-in Reader role** for that service principal, at the level you want read:

| Reader is given on… | The crawler reads… |
|---|---|
| A **management group** | Everything below it: management groups, subscriptions, resource groups, and their role assignments |
| A single **subscription** | That subscription, its resource groups, and their role assignments |

Reader is enough. No write access is needed.

---

## Add the crawler

1. Go to **Admin → Crawlers** and click **Add Crawler**.
2. Pick **Azure Resource Manager**.
3. **Service Principal.** Enter a **Crawler Name**, the **Tenant ID**, **Client ID** and **Client Secret**.
4. **Scope & Options.** Under **What should this crawler cover?** choose **Specific subscriptions** or **A management group**. The wizard signs in and lists what the service principal can see. Then set the three options described below.
5. **Schedule.** Add a schedule, or leave it empty to run by hand.
6. Click **Add Crawler**. The crawler appears as a card. Click **Run Full** to load the data now.

---

## Settings

| Wizard label | Meaning | Default |
|---|---|---|
| **Crawler Name** | The name on the crawler's card. The system in Identity Atlas gets the same name. | Azure Resource Manager |
| **Tenant ID** | The directory (tenant) ID. | Empty |
| **Client ID** | The application (client) ID of the service principal. | Empty |
| **Client Secret** | The service principal's secret. When you edit a crawler, leave it blank to keep the stored one. | Empty |
| **Specific subscriptions** | Tick the subscriptions to read. Leave all unticked to read every subscription the service principal can see. | All |
| **A management group** | Read one management group and everything below it. | — |
| **Only load assignments for principals in Entra ID** | On: a role assignment whose account is not in Entra ID is skipped. Off: it is loaded, and the account is marked as orphaned. | On |
| **Include custom role definitions** | Also read your tenant's custom roles, not only the built-in ones. Off: assignments of custom roles are left out. | On |
| **Include individual resources** | Also load every single resource. This is a lot of data. | Off |

If the wizard cannot list subscriptions or management groups, it says *Live discovery unavailable* and lets you type the subscription IDs or the management group ID yourself.

---

## Schedule and refresh

Schedules and the run buttons work as for every crawler: see [Schedule and run crawlers](scheduling.md).

Every run reads everything. The difference between the two modes is only what gets removed: a **Full** run removes what Azure no longer has, a **Delta** run does not. A daily full run is a good default.

---

## What a refresh removes

A full run removes the Azure resources and role assignments that are no longer in Azure, within this crawler's own system. It never removes or changes the accounts that Entra ID owns. See [What a full run removes](scheduling.md#what-a-full-run-removes).

With **Only load assignments for principals in Entra ID** on, a full run also removes role assignments loaded earlier for accounts that are not in Entra ID.

---

## Limitations

- **Inherited access is not stored.** See *One role, one place* above.
- **The service principal only sees what Reader lets it see.** Subscriptions it has no Reader role on are not read.
- **Client secret only.** The crawler signs in with a service principal and a client secret.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The Scope & Options step says *Live discovery unavailable (Could not authenticate to Azure: …)* | The tenant ID, client ID or client secret is wrong. Go back one step and correct them, then click **↻ Refresh**. |
| The job log says *No directory data loaded by the crawler for this tenant yet* | The Entra ID crawler has not run for this tenant. Run it, then run this crawler again. |
| Role assignments you expect are missing | Their account is not in Entra ID (for example a deleted service principal) and **Only load assignments for principals in Entra ID** is on. Turn it off to load them, marked as orphaned. |
| Assignments of a custom role are missing | **Include custom role definitions** is off. |

---

## Deep dive

- [Effective access](../architecture/effective-access-engine.md) — how inherited access is worked out
- [Building a crawler](building-a-crawler.md) — how a crawler feeds effective access
- [Schedule and run crawlers](scheduling.md)

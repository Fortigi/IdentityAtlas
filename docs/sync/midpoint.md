# Connect midPoint

The midPoint crawler reads roles, services, users, org structure, the accounts and groups on connected systems, and certification decisions from a **midPoint** (Evolveum) installation through its REST API. It only reads; nothing is changed in midPoint.

**Use this when** midPoint is your identity governance platform and you want its roles, role assignments and connected systems in Identity Atlas.

Only the connection — address, sign-in method and credentials — has to be filled in. Every other setting has a default that gives a complete import.

---

## What you get

| In midPoint | In Identity Atlas |
|---|---|
| Resources (connected systems) that hold accounts or groups | Systems |
| Orgs | Contexts, with their hierarchy. Type `OrgUnit` unless you map it otherwise |
| Roles | Resources. Business roles by default; you can classify them by archetype or subtype |
| Role inducements | What each role contains: other roles and services, and the groups a role grants on a connected system |
| Services | Resources of type `Service` |
| Users | Identities, each with one account for the midPoint user itself |
| Account shadows | Accounts on the connected systems, linked to the identity that owns them |
| Entitlement shadows (for example AD groups) | Resources of type `Entitlement` |
| An account's membership of an entitlement | **Direct** assignments |
| A user's assignments to roles and services | **Direct** assignments, marked **governed** |
| A user's complete role membership as midPoint computed it | **Direct**, **governed** assignments for the roles the user holds without a direct assignment — through role nesting, an archetype or an org |
| A user's orgs | Context members |
| Access certification campaigns | Review decisions |

Every record keeps its midPoint OID, so it can be traced back to the source object. The words used here are explained in the [glossary](../start/glossary.md).

---

## Before you start

- **A midPoint installation** whose REST API the Identity Atlas worker can reach.
- **A user or service account** that may read through the REST API.
- **Group memberships** are read in both forms midPoint uses: the reference attributes introduced in midPoint 4.9, and the associations of earlier versions.

midPoint usually runs on your own network. Read [Network access](#network-access) before you start, or the address will be refused.

---

## Add the crawler

1. Go to **Admin → Crawlers** and click **Add Crawler**.
2. Pick **midPoint (Evolveum)**.
3. **Connection.** Enter a **Crawler Name** and the **midPoint Base URL**, tick the **Network access** options you need, and pick the **Authentication Method**.
4. **Credentials.** Fill in the fields for the method you picked.
5. **Objects & Mapping.** Leave every object type ticked for a complete picture. Optionally classify roles and map org and user types — the lists are filled from your midPoint server.
6. **Schedule.** Add a schedule, or leave it empty to run by hand.
7. Click **Add Crawler**. The crawler appears as a card. Click **Run Full** to load the data now.

---

## Settings

### Connection

| Wizard label | Meaning | Default |
|---|---|---|
| **Crawler Name** | The name on the crawler's card. Change it when you connect more than one midPoint. | midPoint (Evolveum) |
| **midPoint Base URL** | For example `https://midpoint.example.com/midpoint` or `…/midpoint/ws/rest`. A bare host also works. | Empty |
| **Network access** | **Allow private network** and **Allow insecure HTTP** — see [Network access](#network-access). | Both off |
| **Authentication Method** | How the crawler signs in — see the next table. | HTTP Basic Auth |

### Credentials

| Authentication Method | Fields |
|---|---|
| **HTTP Basic Auth** | **Username**, **Password** |
| **API Token** | **API Token** |
| **OAuth2 Client Credentials** | **Token Endpoint URL**, **Client ID**, **Client Secret** |
| **OAuth2 ROPC** | **Username**, **Password**, **Token Endpoint URL**, **Client ID**, **Client Secret** |

When you edit a crawler, leave a secret field blank to keep the stored value.

### Network access

An address such as `http://midpoint:8080/midpoint` is refused until you tick **Allow private network** (the host is on your own network) and **Allow insecure HTTP** (plain `http`) on the Connection step. A midPoint reachable over public https needs neither. The same applies to an OAuth2 token endpoint. What is checked, and what stays blocked whatever you tick: [Crawler URL rejected](../reference/troubleshooting.md#crawler-url-rejected).

### Objects & Mapping: what to read

All are on by default. Turn one off only to skip that part of the import.

| Wizard label | What it reads |
|---|---|
| **Systems** | Connected resources, as systems |
| **Orgs** | Orgs, as contexts |
| **Roles** | Roles, as resources |
| **Services** | Services, as resources |
| **Users** | Users, as identities with an account |
| **Shadows** | Accounts and entitlements on the connected systems, and who is a member of what. The slowest part |
| **Org membership** | Which user belongs to which org |
| **Assignments** | Role and service assignments |
| **Role nesting** | What each role contains |
| **Reviews** | Certification campaigns and their decisions |
| **Page size** | Objects per request to midPoint. Default 100 |

Turning **Shadows** off makes a run much shorter, but you lose the accounts and group memberships on the connected systems. The groups a role grants are found among those entitlements, so **Role nesting** needs **Shadows** to link a role to its groups.

### Objects & Mapping: role classification

**Role classification (archetype → resource type)** decides what kind of resource each midPoint role becomes. By default every role becomes a business role.

| Column | Meaning |
|---|---|
| **Archetype** | The name of a midPoint archetype. The list shows the archetypes on your server that apply to roles. Leave it at *(any / catch-all)* for a rule on subtype only. |
| **Subtype (fallback)** | The role's subtype in midPoint, used when no archetype rule matches. The list shows the subtypes found on your roles; you can also type one. |
| **Identity Atlas type** | `BusinessRole`, `Service`, `Resource`, `Application`, `AppRole`, `Entitlement` or `DelegatedPermission`. |

A role is matched in this order:

1. a rule whose **Archetype** is the role's archetype;
2. otherwise a rule whose **Subtype** is the role's subtype;
3. otherwise the rule with both left blank — the catch-all;
4. otherwise it becomes a business role.

This applies to roles only. midPoint services always become resources of type `Service`.

### Objects & Mapping: advanced type mappings

Click **Advanced type mappings (orgs, users)** to open two more tables. Each row has a value from midPoint on the left and the Identity Atlas type it becomes on the right. A row with the left side blank is the catch-all. There is no automatic copy: add one row per value you want to treat differently.

| Table | Left: from midPoint | Right: in Identity Atlas | Default |
|---|---|---|---|
| **Org → context type** | **Org subtype** — pick from the subtypes on your server, or type one | **Context type** — any name you choose, such as `Department` or `Country` | Every org → `OrgUnit` |
| **User → principal type** | **User subtype** — the user's subtype or employee type | **Principal type** — `User`, `ServicePrincipal`, `ManagedIdentity`, `WorkloadIdentity`, `AIAgent`, `ExternalUser` or `SharedMailbox` | Every user → `User` |

---

## Schedule and refresh

Schedules and the run buttons work as for every crawler: see [Schedule and run crawlers](scheduling.md).

midPoint is read completely on every run. The difference between the two modes is only what gets removed: a **Full** run removes what midPoint no longer has, a **Delta** run only adds and updates. Schedule a full run daily or weekly.

---

## What a refresh removes

A full run removes the accounts, resources, assignments, role contents and contexts that are no longer in midPoint, limited to the systems this crawler loaded. Data from other crawlers is never touched. See [What a full run removes](scheduling.md#what-a-full-run-removes).

Systems, identities, the links between identities and accounts, context members and review decisions are only added and updated, in both modes.

---

## Limitations

- **Read-only.** Nothing is written back to midPoint.
- **Every run reads everything.** midPoint is not asked for changes only.
- **Services cannot be reclassified.** They are always type `Service`.
- **Other shadows are skipped.** Only account and entitlement shadows are read.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Saving, the Objects & Mapping step or the job says *baseUrl rejected* or *tokenEndpoint rejected* | The address uses `http` or is a private address. Tick **Allow private network**, and **Allow insecure HTTP** only if midPoint has no https — see [Network access](#network-access). |
| The Objects & Mapping step says *Could not reach midPoint — enter values manually* | The wizard could not sign in to midPoint to fill the lists. Check the address and credentials. You can still type archetype and subtype names yourself. |
| A role does not show the groups it grants | **Shadows** is off, so the groups were not loaded. Turn it on and run a full run. |
| Accounts and group memberships on connected systems are missing | **Shadows** is off. |
| **midPoint (Evolveum)** is not in the **Add Crawler** list | See [A crawler type is missing](scheduling.md#a-crawler-type-is-missing-from-add-crawler). |

---

## Deep dive

### The settings as a file

You do not type JSON in the wizard. The **Export** button on a crawler's card downloads its settings as a JSON file without its secrets, and **Import** on the Crawlers page loads such a file — handy for copying a crawler to another installation. Its `config` part looks like this for a crawler with custom role classification, shadows turned off and a daily full run:

```json
{
  "baseUrl": "https://midpoint.example.com/midpoint",
  "authMethod": "BasicAuth",
  "username": "svc-identityatlas",
  "pageSize": 100,
  "selectedObjects": { "shadows": false },
  "archetypeMapping": [
    { "archetype": "Application role", "subtype": "", "resourceType": "Application" },
    { "archetype": "", "subtype": "", "resourceType": "BusinessRole" }
  ],
  "typeMappings": {
    "orgContextTypeMapping": [
      { "orgSubtype": "department", "contextType": "Department" },
      { "orgSubtype": "", "contextType": "OrgUnit" }
    ],
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

### Further reading

- [Schedule and run crawlers](scheduling.md)
- [Crawler architecture](../architecture/crawler-architecture.md)

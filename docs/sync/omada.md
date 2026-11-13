# Connect Omada

The Omada crawler reads business roles, identities, accounts, role assignments and the organisation structure straight from Omada Identity's OData API — on-premises or Omada Cloud. No manual export is needed. It only reads; nothing is changed in Omada.

**Use this when** Omada is where your organisation requests and approves access, and you want to compare what Omada says people should have with what the connected systems really grant.

---

## What you get

| In Omada | In Identity Atlas |
|---|---|
| `System` (connected systems) | Systems |
| `Orgunit`, and any other entity set you configure | Contexts. `Orgunit` contexts keep their hierarchy (`PARENTOU`); other types are flat lists |
| `Identity` (persons) | Identities |
| `User` | Accounts |
| The link from an identity to its users | The accounts that belong to each identity |
| `Contextassignment`, the reference fields on an identity, and `Employment` | Context members |
| `Resource` | Resources. The type comes from `ROLECATEGORY` through the mapping you set; by default a `Role` becomes a business role |
| `Resource.CHILDROLES` | What each business role contains |
| `Resourceassignment` | **Direct** assignments, marked **governed** |
| `CalculatedAssignments` | Accounts in the connected systems and their **Direct**, **governed** assignments |

The words used here are explained in the [glossary](../start/glossary.md). The field-by-field mapping is in the [Omada data model reference](../architecture/omada-crawler-datamodel.md).

---

## Before you start

- **An Omada Identity installation** — on-premises or Omada Cloud — with the OData API reachable from the Identity Atlas worker.
- **A user or service account** that can read the OData API.
- **A way to sign in.** The crawler supports six methods; see [Settings](#settings). For scheduled runs do not use *Cookie String*: its session expires.

---

## Add the crawler

1. Go to **Admin → Crawlers** and click **Add Crawler**.
2. Pick **Omada IGA**.
3. **Connection.** Enter a **Crawler Name** and the **Omada Base URL**, pick the **Omada Version** and the **Authentication Method**. For an on-premises server, see [Network access](#network-access).
4. **Credentials.** Enter what the chosen method asks for — see [Credentials](#credentials) for the fields per method.
5. **Sync Options.** Leave everything ticked for a complete picture. Check the **Context Object Types** and the **Resource Category Mapping**. The wizard reads `$metadata` from your Omada server and warns when an entity set or field name does not exist.
6. **Schedule.** Optional — see [Schedule and run crawlers](scheduling.md). Without a schedule, the crawler only runs when you start it.
7. Save with **Add Crawler**, then start the first load with **Run Full** on the new card.

---

## Settings

### Connection

| Wizard label | Meaning | Default |
|---|---|---|
| **Crawler Name** | The name on the crawler's card. | Omada IGA |
| **Omada Base URL** | The address of your Omada server, for example `https://omada.example.com`. You may also give the full `…/odata/dataobjects` address. | Empty |
| **Network access** | **Allow private network** and **Allow insecure HTTP** — see [Network access](#network-access). | Both off |
| **Omada Version** | **On-premise v14**, **On-premise v15** or **Omada Cloud**. | On-premise v14 |
| **Authentication Method** | How the crawler signs in — see the next table. | Form / Cookie |

### Credentials

| Authentication Method | Fields | Use it for |
|---|---|---|
| **Form / Cookie** | **Username**, **Password** | On-premises: signs in with a user name and password |
| **OAuth2 Client Credentials** | **Token Endpoint URL**, **Client ID**, **Client Secret** | Omada Cloud and newer on-premises versions |
| **OAuth2 ROPC** | **Username**, **Password**, **Token Endpoint URL**, **Client ID**, **Client Secret** | On-premises with OAuth2 |
| **API Token** | **API Token** | A fixed bearer token |
| **Cookie String** | **Cookie String** | Testing, or when only a browser session is available. The wizard explains how to copy it |
| **HTTP Basic Auth** | **Username**, **Password** | On-premises |

When you edit a crawler, leave a secret field blank to keep the stored value.

### Sync Options

| Wizard label | Meaning | Default |
|---|---|---|
| **Contexts** | The context types listed under *Context Object Types* | On |
| **Identities** | Persons and their attributes | On |
| **Accounts** | User and service accounts | On |
| **Context Members** | Which identity belongs to which context | On |
| **Resources** | Business roles and other permissions, per connected system | On |
| **Entitlements** | What each business role contains | On |
| **Assignments** | Role assignments and calculated assignments | On |
| **Context Object Types** | One row per Omada entity set to load as contexts: the **entity set**, the **context type** it becomes, and the **identity field** that links an identity to it. | `Orgunit` → `OrgUnit`, linked by `OUREF` |
| **Resource Category Mapping** | One row per **ROLECATEGORY value** and the **Identity Atlas type** it becomes: `BusinessRole`, `Resource`, `AppRole` or `DelegatedPermission`. A row with a blank value catches everything else and must be last. | `Role` → `BusinessRole`, `Permission` → `Resource`, everything else → `Resource` |

Names of entity sets and fields are **case-sensitive**: `Job_titles` is not `job_titles`. Use the exact spelling from your server's `$metadata`.

### Network access

Omada Cloud (`https://<tenant>.omada.cloud`) needs no extra setting. For an **on-premises** Omada server whose address is private (`10.x`, `172.16–31.x`, `192.168.x`, or a name that resolves to one) tick **Allow private network** on the Connection step. If it is only served over plain `http`, also tick **Allow insecure HTTP**. The same applies to an OAuth2 token endpoint on your own network. What is checked, and what stays blocked whatever you tick: [Crawler URL rejected](../reference/troubleshooting.md#crawler-url-rejected).

---

## Schedule and refresh

Schedules and the run buttons work as for every crawler: see [Schedule and run crawlers](scheduling.md).

Omada cannot report what changed since the last run. Every run — scheduled or by hand, whichever mode you pick — is a **full run**.

---

## What a refresh removes

Each run removes what Omada no longer has, limited to the systems this crawler loaded. Data from other crawlers is never touched. See [What a full run removes](scheduling.md#what-a-full-run-removes).

---

## Limitations

- **No delta runs.** Every run reads everything.
- **Read-only.** Nothing is written back to Omada.
- **Windows authentication is not supported.** Use *Form / Cookie*, *HTTP Basic Auth* or *OAuth2 ROPC* for an on-premises server.
- **Cookie String sessions expire**, typically after 20 to 60 minutes.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Saving, the Sync Options step or the job says *baseUrl rejected* or *tokenEndpoint rejected* | The address uses `http` or is a private address. For an on-premises server tick **Allow private network**, and **Allow insecure HTTP** only if it has no https — see [Network access](#network-access). |
| The Sync Options step says *Could not reach Omada server — validation unavailable* | The wizard could not read `$metadata`. You can still save; the names you typed are then not checked. Check the address and credentials if you did not expect this. |
| A context type row shows *not found — names are case-sensitive* | The entity set or identity field is spelled differently on your server. The message suggests the right spelling when it finds one. |
| **Omada IGA** is not in the **Add Crawler** list | See [A crawler type is missing](scheduling.md#a-crawler-type-is-missing-from-add-crawler). |
| A scheduled run fails to sign in after working by hand | A **Cookie String** session has expired. Switch to **Form / Cookie** or one of the OAuth2 methods. |

---

## Deep dive

- [Omada data model reference](../architecture/omada-crawler-datamodel.md) — every field, per phase
- [Schedule and run crawlers](scheduling.md)
- [Crawler architecture](../architecture/crawler-architecture.md)

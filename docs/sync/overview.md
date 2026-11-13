# Connect your systems: overview

Identity Atlas reads who has access to what from your systems through
**crawlers**. Each crawler knows one kind of source, turns what it finds into
accounts, resources and assignments, and hands that to the same ingest API. This
page helps you pick the right one. Each has its own page with the settings.

You add a crawler in **Admin → Crawlers → Add Crawler**.

## Which method for which system

| My system is… | Use | Page |
|---|---|---|
| Microsoft Entra ID | **Microsoft Entra ID** (shown as *Microsoft Graph* in the picker) | [Entra ID](entra-id.md) |
| Azure subscriptions and their role assignments | **Azure Resource Manager**, after the Entra ID crawler | [Azure Resource Manager](azure-rm.md) |
| Omada Identity | **Omada IGA** | [Omada IGA](omada.md) |
| midPoint | **midPoint (Evolveum)** | [midPoint](midpoint.md) |
| An application or IGA platform whose data sits in a Microsoft SQL Server database you may query | **SQL Database** | [SQL Server](mssql.md) |
| Anything that offers a SCIM 2.0 endpoint | **SCIM 2.0** | [SCIM 2.0](scim.md) |
| Anything that can export files, or that you can only reach by hand | **CSV Import** | [CSV Import](csv-import.md) |
| A system with its own export job, or one you would rather write code for | **Custom Connector** (push API) | [Custom Connector](custom-connector.md) |
| Nothing yet: you want to look around first | **Demo Dataset** (shown as *Demo Data* in the picker) | [Quick Start](../quickstart.md) |

Rules of thumb when more than one fits:

- **A dedicated crawler beats a generic one.** Entra ID, Azure, Omada and midPoint
  crawlers know their source's model, including its governance data. Use them
  when they exist for your system.
- **SQL before CSV.** If you can get a read-only login on the source's database,
  the SQL Database crawler runs on a schedule and needs no export step. CSV
  means someone, or some job, has to produce new files for every refresh.
- **Push when the source should be in charge.** The Custom Connector is the same
  ingest API the crawlers use. Choose it when your own process decides when to
  send data.

## What each one brings in

| Crawler | Accounts and identities | Resources | Assignments | Governance data | Contexts |
|---|---|---|---|---|---|
| **Microsoft Entra ID** | Users, service principals, managed identities, AI agents | Groups, directory roles, applications, app roles, delegated and application permissions, ownerships | Direct, Indirect and Eligible | Access packages as business roles, access reviews | No |
| **Azure Resource Manager** | Uses the accounts the Entra ID crawler loaded | Management groups, subscriptions, resource groups; individual resources on request | Role assignments | No | No |
| **Omada IGA** | Identities and their accounts | Business roles and the resources they grant | Yes | Business roles, governed assignments, certification reviews | Yes |
| **midPoint (Evolveum)** | Users, and accounts on connected resources | Roles and services | Yes, including role nesting | Business roles, certification reviews | Organisations |
| **SQL Database** | What your queries return | What your queries return | What your queries return | Business roles and what they contain | From a catalogue in the source |
| **SCIM 2.0** | Users | Groups | Group memberships | No | No |
| **CSV Import** | Users, identities | Any resource type | Yes | Business roles, certifications | Yes |
| **Custom Connector** | Whatever you push | Whatever you push | Whatever you push | Whatever you push | Whatever you push |
| **Demo Dataset** | A synthetic company | Synthetic | Synthetic | Synthetic | Synthetic |

Two crawlers lean on another one:

- **Azure Resource Manager** grants access to accounts that live in Entra ID. By
  default it only loads role assignments for accounts the Entra ID crawler has
  already brought in, so run that one first.
- **Omada IGA** uses the generic OData crawler described [below](#two-crawlers-without-a-page).

## Pull or push

| Crawler | Direction | Refreshes |
|---|---|---|
| Microsoft Entra ID, Azure Resource Manager, Omada IGA, midPoint, SQL Database, SCIM 2.0 | **Pull**: Identity Atlas connects to the source | On a schedule you set, or when you start a run |
| CSV Import | **Pull from files** you upload | When you upload a new export and run it |
| Custom Connector | **Push**: your process calls the ingest API | When your process sends data |
| Demo Dataset | Loaded once | When you load it again |

A pull crawler needs a network path from the Identity Atlas worker to the source
and a credential that can read it. Credentials are stored encrypted. The Omada,
midPoint, SCIM and OData crawlers refuse private network addresses and plain
`http` unless you allow them in the crawler's settings, which you do for a
server on your own network.

## Scheduling

The pull crawlers end their setup with a schedule step. A crawler can have
several schedules, and each one has:

- a **frequency**: every few minutes (5, 10, 15, 20 or 30), hourly, daily or
  weekly. Daily and weekly times are in UTC.
- a **mode**: *Delta (fast)* reads only what changed since the previous run.
  *Full (authoritative)* reads everything again.

A common pattern is frequent delta runs plus a full run at least once a day.
What a delta covers differs per source, and some sources cannot report changes
at all: Omada and SCIM runs are always full, whatever the schedule asks for.
The crawler's own page says what its delta leaves to the full run.

## What a refresh removes

A full run is the source's complete answer, so Identity Atlas treats it as the
truth for that system:

- **What the source no longer has is removed.** An account, resource or
  assignment that was loaded earlier and is missing from a full run is marked as
  deleted. It leaves the matrix but stays in the history, and after a retention
  period (180 days unless changed) it is purged.
- **What comes back is restored.** If a later run sees the same object again, the
  deleted mark is cleared and its history continues.
- **A crawler only cleans up its own system.** A run for one system never removes
  what another system's crawler loaded.
- **An empty answer is not a mass deletion.** A run that returns nothing for a
  system as a whole removes nothing; removal happens only inside a part the
  crawler explicitly reported on.

Delta runs differ per crawler: some sources report removals in their change
feed and some do not. Read the crawler's page before relying on a delta-only
schedule to notice that access was taken away. The
[SQL Server](mssql.md) and [Entra ID](entra-id.md) pages cover this in detail.

## SailPoint

There is no crawler that talks to a SailPoint API. What is supported:

- **SailPoint IdentityIQ, through its database.** When IdentityIQ's database
  runs on Microsoft SQL Server and you can get a read-only login, use the
  **SQL Database** crawler. Its setup has a *Load example* choice with two
  ready-made query sets, *SailPoint IdentityIQ* and *SailPoint IdentityIQ with
  organisation extensions*, that you adjust to your installation. See
  [SQL Server](mssql.md).
- **Any SailPoint product, through files.** Export the data, shape it into the
  [CSV schema](../architecture/csv-import-schema.md) and load it with
  **CSV Import**. Identity Atlas does not ship a conversion script for SailPoint
  exports, so that shaping is yours to do. See [CSV Import](csv-import.md).
- **Any SailPoint product, through your own code.** Push the data with the
  [Custom Connector](custom-connector.md).

## Two crawlers without a page

Two shipped crawlers are not documented on a page of their own:

- **Generic OData** reads an OData endpoint. It is the foundation the Omada IGA
  crawler is built on. It is not offered in the *Add Crawler* picker and has no
  setup wizard.
- **Demo Dataset** loads the synthetic company used throughout this
  documentation. Choose **Demo Data** in the *Add Crawler* picker, then
  **Load Demo Data**. What the
  dataset contains is described in
  [Demo Dataset](../architecture/demo-dataset.md), which gives away the
  [Capture the Flag](../demo/before-you-play.md) answers.

## Something else

If none of the above fits and you want a scheduled crawler of your own rather
than a push integration, [Building a Crawler](building-a-crawler.md) explains
how the shipped ones are put together.

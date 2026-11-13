# Choose a deployment

There are four ways to get Identity Atlas in front of you. They run the same
application and the same data model; they differ in where it runs, who can
reach it, and how much you have to arrange first.

| You want to… | Use |
|---|---|
| Look around before installing anything | [The public demo](#the-public-demo) |
| Evaluate with your own data, or run it on a server you manage | [Docker](#docker) |
| Run it for a team, with sign-in, in your own Azure subscription | [Azure](#azure) |
| Run it on a Windows machine where Docker is not allowed | [Portable](#portable) |

## Side by side

| | Public demo | Docker | Azure | Portable |
|---|---|---|---|---|
| **Runs on** | Hosted for you | Any host with Docker | Your Azure subscription | One Windows 10/11 x64 machine |
| **Sign-in by default** | None | Off: anyone who can reach port 3001 has full access | On: Entra ID sign-in from the first deploy | Off, and reachable from that machine only |
| **Where the data lives** | Nowhere of yours: synthetic demo data | A PostgreSQL 16 container, in Docker volumes on your host | Azure Database for PostgreSQL, Key Vault and a storage account in your resource group | A data folder in your Windows user profile |
| **Your own data** | No | Yes | Yes | Yes |
| **How upgrades work** | Not your concern | Run the start command again with `--pull always` | Restart to follow the channel, or pin a version and redeploy | Download the newer ZIP and start it |
| **Sizing pointer** | n/a | From 4 GB RAM and 20 GB disk for a small tenant | Five size profiles, `xs` to `xl` | Built-in database up to 4 GB; a second ZIP carries a full PostgreSQL |
| **Cost of entry** | A browser | A machine with Docker | From about €45 a month (`xs`) | PowerShell 7; no administrator rights |

## The public demo

**Who it is for.** Anyone who wants to see the product before deciding anything.

**What you need.** A browser. Open [demo1.identityatlas.io](https://demo1.identityatlas.io).

**What you get.** The full application on the synthetic demo dataset, with no
sign-in. Every page under *Start here* works against it, including
[Your first 15 minutes](../start/first-15-minutes.md) and
[Capture the Flag](../demo/before-you-play.md).

**Limits.** It holds demo data only. You cannot connect your own systems to it.

## Docker

**Who it is for.** Evaluators who want their own data in it today, and operators
who run it on a server they manage. This is the default way to run Identity Atlas.

**What you need.** A Linux, macOS or Windows host with Docker and Docker Compose,
and one setting: a database password in a `.env` file. The
[Quick Start](../quickstart.md) commands generate it for you. No git clone is
needed; the images are pulled from `ghcr.io`.

**What you get.** Three containers: PostgreSQL 16, the web application on port
3001, and a worker that runs the crawlers. The same stack can load the demo
dataset or connect to your own systems.

**Limits.**

- Sign-in is off until you turn it on. Before real data goes in, or before anyone
  else can reach the host, [set up authentication](../admin/authentication.md).
- Everything runs on one host. Backups, TLS and network access are yours to arrange.
- Stored crawler credentials are encrypted with a master key that the web
  container generates on first start and keeps in the `web_keys` volume. Back that
  volume up, or set `IDENTITY_ATLAS_MASTER_KEY` yourself before the first start.

**Pages.** [Quick Start](../quickstart.md) to get it running,
[Docker Setup](../architecture/docker-setup.md) for every setting and the sizing table.

## Azure

**Who it is for.** Teams that want a shared, always-on installation in their own
tenant, with sign-in enforced and no server to patch.

**What you need.** An Azure subscription where you are `Owner`, and a role in
Entra ID that lets you register an application. The
[walkthrough](../architecture/azure-deployment-walkthrough.md) lists the exact
roles and the resource providers to register first.

**What you get.** One template deploys the web application on App Service, the
worker as a Container App, Azure Database for PostgreSQL, Key Vault, a storage
account and Log Analytics. Entra ID sign-in is on from the first deploy: until you
have registered the application, the site shows a setup page instead of the
product, so there is never an open installation. The worker gets a managed
identity that the Entra ID crawler can sign in with, so that crawler needs no
client secret.

**Limits.**

- It costs money from the first hour. The template's size profiles run from `xs`
  (about €45 a month, for a demo) through `s` (about €79, the default) to `xl`
  (about €469).
- The two largest profiles put PostgreSQL on a compute tier you cannot scale back
  down from. Start smaller unless you know you need them.
- The default shape uses public endpoints, with the database restricted to the web
  application's outbound addresses. A private network shape exists, and it has to
  be chosen when the deployment is created.

**Pages.** [Azure Deployment Walkthrough](../architecture/azure-deployment-walkthrough.md)
for the portal steps, [Azure Deployment Reference](../architecture/azure-deployment.md)
for sizing, network modes and upgrades, and
[Azure as Code](../architecture/azure-gitops.md) when the deployment lives in your
own repository.

## Portable

**Who it is for.** An analyst on a locked-down Windows laptop where Docker and WSL
are blocked, or anyone who has to keep the data on a single machine.

**What you need.** Windows 10 or 11 (x64) and PowerShell 7. No Docker, no WSL, no
installation and no administrator rights. Download a ZIP from the
[GitHub releases](https://github.com/Fortigi/IdentityAtlas/releases), unzip it and
run `Start-IdentityAtlas.ps1`.

**What you get.** The same application at `http://localhost:3001`, with the
database running inside it. Crawlers run through PowerShell on the same machine.
Your data stays in a folder in your Windows user profile; copying that folder,
with the application stopped, is the backup.

**Limits.**

- One machine, one user: it listens on that machine only and cannot be shared
  over the network.
- Sign-in is off by default.
- Each release ships two ZIPs. The default one keeps its data in a built-in
  database that cannot grow past 4 GB. The second one carries a full PostgreSQL 16
  server for large data sets; its PostgreSQL files are not code-signed, so a
  machine with application control needs an exception for them.

**Pages.** [Portable Windows Launcher](../architecture/desktop-portable.md).

## How large can it go?

Start from the table that belongs to your choice, then read the measurements if
your organisation is large:

- **Docker:** the [sizing table](../architecture/docker-setup.md#sizing) gives RAM
  and disk by number of accounts.
- **Azure:** the [size profiles](../architecture/azure-deployment.md#sizing-pick-at-deploy-time)
  map tenant size to a profile. You can move up a profile later by redeploying.
- **Portable:** [Real PostgreSQL mode](../architecture/desktop-portable.md#real-postgresql-mode)
  explains when the default ZIP is no longer enough.
- **Measurements:** [Scaling & Load Testing](../architecture/scaling.md) and the
  [scale rehearsal](../architecture/scale-rehearsal.md) show what was loaded, on
  what hardware, and how long it took.

## Moving from one to another

Start with the demo, then Docker: that path costs nothing and nothing is wasted.
The crawlers and the data model are the same everywhere, so what you learn about
connecting a system in Docker applies unchanged on Azure and on Portable. The
simplest way to move is to set the crawlers up again in the new place and run them.

## Release channels

Which build you run is a separate choice from where you run it. There are three
channels, and stable is the default everywhere.

| Channel | Image tag | What it is |
|---|---|---|
| **Stable** | `:latest` | The most recent release. Use this unless you have a reason not to. |
| **Beta** | `:beta` | The most recent pre-release. |
| **Edge** | `:edge` | The newest build of the main branch. It can contain changes that are not in any release yet. |

Every release and pre-release is also published under its exact version number, so
you can pin an installation to one build.

- **Docker:** set `IMAGE_TAG` to `beta`, `edge` or a version number; leave it unset
  for stable. See [Image channels](../quickstart.md#image-channels).
- **Azure:** the `imageChannel` parameter takes `stable` or `edge`; the `imageTag`
  parameter pins an exact release or pre-release. See
  [Azure Deployment Reference](../architecture/azure-deployment.md).
- **Portable:** each release on GitHub carries its own ZIPs; you pick a build by
  picking a release.

Identity Atlas can also check for newer versions on its channel and, if you allow
it, have them installed: see [Automatic Updates](../admin/auto-updates.md).

# Managing the Azure deployment as code

This page is for teams that run Identity Atlas on Azure and manage it through
a repository: pull requests, review, and a pipeline that deploys. It shows how
to stay on the latest stable release automatically, with little work per
release, while keeping every change reviewable and reversible.

It builds on the [Azure Deployment Reference](azure-deployment.md). Read that
first for what the template deploys.

## The idea: one version number

An Identity Atlas release is more than its container images. The Azure
template changes between releases too: a new setting, a new resource, a fix
to the deployment itself. The images and the template have to match.

So follow **the release**, not an image tag. Every release ships its template
as `IdentityAtlas-azure-<version>.zip` on the
[GitHub release](https://github.com/Fortigi/IdentityAtlas/releases). That is
the `azure/` folder as it is at that release, set to deploy exactly that
release's images. Keep that folder in your repository, and its version is the
only number you track:

```text
your-repo/
├── identity-atlas/            ← the release's template package, replaced whole on upgrade
│   ├── RELEASE                ← e.g. 6.1.0.0: the release it is
│   ├── main.json              ← compiled template (deployed as-is)
│   ├── main.bicep, modules/   ← the source, for reading the diff
│   └── gitops/                ← the workflows below, and an example parameters file
├── parameters/
│   └── production.json        ← YOUR settings; never touched by an upgrade
└── .github/workflows/
    ├── identity-atlas-update.yml   ← proposes the next release as a PR
    └── identity-atlas-deploy.yml   ← what-if on the PR, deploy on merge
```

An upgrade is then a pull request that replaces `identity-atlas/`. The diff
shows the template changes, the pipeline shows what they would do in Azure,
and merging deploys template and images together. A rollback is reverting
that pull request (with one caveat about the database, [below](#rolling-back)).

## The upgrade, step by step

1. **The update workflow notices a new release.** Once every working day it
   compares `identity-atlas/RELEASE` with the latest stable release. It only
   ever moves forward: a hotfix for an older line is never proposed as a
   downgrade.
2. **It opens a pull request.** The PR replaces `identity-atlas/` with the new
   release's package and carries the release notes.
3. **The deploy workflow runs a what-if on the PR.** It writes to the run
   summary exactly what the merge would create, change or delete in Azure.
   This is where an infrastructure change shows up: a new module, a changed
   setting, a new role assignment.
4. **You review and merge.** The deploy workflow then deploys in the
   `production` environment. Give that environment required reviewers if you
   want a final approval gate.
5. **Azure runs the new release.** The image references changed, so App Service
   and Container Apps start new revisions on their own. The database is
   migrated on start-up. A large migration can take a while; the release notes
   say when one does.

## One-time setup

### 1. Your own copy of the images (optional)

If the deployment may not pull from ghcr.io, or you want to keep exactly what
you ran, mirror the images into your Azure Container Registry with cache
rules, and set `containerRegistryResourceId` in your parameters file. See
[Pulling the images from your own registry](azure-deployment.md#pulling-the-images-from-your-own-registry).
Nothing else changes: the template pulls the same versions from your
registry, with a pull-only identity.

### 2. Adopt the latest release

Download `IdentityAtlas-azure-<version>.zip` from the latest release, unzip it,
and commit its `azure/` folder as `identity-atlas/`. Copy
`identity-atlas/gitops/parameters.production.example.json` to
`parameters/production.json` and fill it in.

Do **not** set `imageTag` in your parameters file. The package already pins its
own release. A value in the parameters file overrides that, and template and
images could drift apart again.

### 3. Sign-in that survives a redeploy

The template replaces the web app's settings on every deployment. Sign-in
configured afterwards with Step 2 (`main-auth`) is therefore cleared by the next
upgrade. For a deployment managed as code, put sign-in in the parameters file
instead:

1. Deploy once without `entraTenantId` / `entraClientId`. Note the app URL.
2. Register the Entra app with that URL as its SPA redirect URI, as described
   in the [walkthrough](azure-deployment-walkthrough.md).
3. Add `entraTenantId` and `entraClientId` to `parameters/production.json` and
   deploy again. From then on every upgrade keeps them.

### 4. Let the pipeline sign in to Azure

The deploy workflow signs in with OpenID Connect, so no secret is stored.

1. Create an app registration (or a user-assigned managed identity) with a
   federated credential for your repository: environment `production` for
   deployments, and pull requests for the what-if.
2. Give it **Contributor** on the resource group. If you use
   `containerRegistryResourceId`, it also needs the right to create role
   assignments on that registry, because the template grants the pull
   identity AcrPull there.
3. Set the repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_SUBSCRIPTION_ID` and `IDENTITY_ATLAS_RESOURCE_GROUP`.

### 5. Add the two workflows

Copy `identity-atlas/gitops/identity-atlas-update.yml` and
`identity-atlas-deploy.yml` to `.github/workflows/`.

A pull request opened with the default `GITHUB_TOKEN` does not start other
workflows, so the what-if would not run on the upgrade PR. Give the update
workflow a token that can: a GitHub App installation token, or a fine-grained
token with *contents* and *pull requests* write. Store it as the secret
`IDENTITY_ATLAS_UPDATE_TOKEN`.

The workflows are GitHub Actions. On Azure DevOps the same steps apply: a
scheduled pipeline that downloads the package and opens a PR, and a pipeline
that runs `az deployment group what-if` on the PR and
`az deployment group create` after the merge.

## When the infrastructure changes

Template changes reach you the same way as new images, in the same pull
request. Nothing about them is applied without you seeing it first:

- **The diff** of `identity-atlas/` shows what changed in the template.
- **The what-if** shows what that does to your resources.
- **The release notes** call out anything that needs a decision or a manual
  step: a new optional feature, a setting whose default changed, a migration
  that will take long on a large database.

A template change never needs edits to your copy of the template. Your choices
live in `parameters/production.json`. If a release adds a parameter you want to
use, set it there in the same PR.

## Rolling back

Reverting the upgrade PR redeploys the previous release's template and images.
That is enough as long as the newer release did not migrate the database yet.

Migrations only run forward. Once a newer release has started, the database
may have a newer schema than the older release expects. To go back across a
migration, restore the database to the moment before the upgrade. Azure
Database for PostgreSQL Flexible Server backs up continuously and supports
point-in-time restore. The deploy workflow writes that moment into its run
summary ("Restore point before Identity Atlas …").

## Why not Dependabot or Renovate?

Both are built to bump a version string. Here the unit of change is a folder
(the template) together with the images it names.

- **Dependabot** does not read Bicep parameters or GitHub release assets, so it
  cannot see this dependency at all.
- **Renovate** can watch GitHub releases and bump a version in a file. Replacing
  the template folder, though, needs post-upgrade tasks, which only work on a
  self-hosted Renovate.

The update workflow above does exactly this one job in about a hundred lines
you can read. If you already run Renovate, you can of course use it to watch
the releases and leave the folder replacement to the update workflow.

## Updates shown in the app

Identity Atlas can show in the app that a newer release exists. With this
setup that notice is informational only: the pipeline decides what runs.

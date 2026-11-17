# Release process

How a change travels from `main` to the image operators run, what is tested on the way, how a security fix reaches stable on its own, and what to do when that goes wrong. For the one-time Azure and GitHub setup the automation needs, see [One-time setup](#one-time-setup) at the end.

The branching and versioning rules themselves (main first, hotfix branches, version numbers) are in `CLAUDE.md` and [Release & Branching Strategy](../architecture/branching-strategy.md). This page is the operational side.

---

## The three channels

| Channel | Docker tag | Made by | When | Tested by |
|---|---|---|---|---|
| **Edge** | `:edge` + `Major.Minor.yyyyMMdd.HHmm` | `docker-publish.yml`, after `bump-version.yml` | Every merge to `main` | PR CI on the change; the nightly release test (Docker and portable parts) every night without a candidate |
| **Beta** | `:beta` + `X.Y.Z-beta.N` | Actions → **Cut Beta** (by hand), or the nightly security route | When someone decides `main` is ready, or when a security hotfix is on its way | The full nightly release test, Azure included, the night after it is cut |
| **Stable** | `:latest` + `X.Y.Z.0` | Actions → **Cut Release** / **Cut Hotfix** (by hand), or the nightly security route | When a beta has proven itself | Through its beta. A release cut from the beta's own commit ships exactly what was tested |

Nothing is released that is not on `main`: every Cut workflow and `docker-publish.yml` check this with `tools/release/Assert-ReleaseFromMain.ps1`.

### Edge → beta

Cut a beta when all of these hold:

- `main` is green: the last merges passed **CI Passed** and **Integration CI Passed**.
- The last nightly run against `:edge` is green (Actions → **Release nightly**). It runs the Docker and portable parts of the release test against `:edge` every night that has no beta to test.
- Nothing open is labelled as blocking the release, and the `changes/` fragments merged since the last release describe what users will see.

Then: Actions → **Cut Beta** → version `X.Y.Z-beta.N`, ref `main`.

### Beta → stable

Promote a beta when:

- Its release test passed. The night after a beta is cut, **Release nightly** tests it in full, Azure included, and leaves an artifact `release-tested-vX.Y.Z-beta.N` with the result. Find it under that run's artifacts.
- Nobody running the beta has reported a regression.

Then: Actions → **Cut Release** → version `X.Y.Z`, ref **the beta tag** (`vX.Y.Z-beta.N`), so stable is the commit that was tested and not whatever `main` has become since. See [Cutting a release by hand](#cutting-a-release-by-hand).

---

## The release test

`.github/workflows/release-test.yml`, logic in `tools/release/` (`Invoke-*ReleaseTest.ps1` and `ReleaseTest.*.ps1`, unit tests in `test/unit/ReleaseTest*.Tests.ps1`). It tests a **published** candidate (a beta or hotfix tag, or `:edge`): the images from ghcr.io and the ZIPs from the GitHub release, not a build of the PR. Every part runs on GitHub-hosted runners, never on a sidekick.

| Part | What it does | Where |
|---|---|---|
| Docker: upgrade | Starts the previous stable release with its own `docker-compose.prod.yml`, loads the demo data, pushes one record of each kind through the ingest API, backs up exactly as [Back up, restore and upgrade](../admin/backup-restore-upgrade.md) says, switches to the candidate, waits for the migrations, checks the running version, the read endpoints, and that the core row counts did not change. Then restores that backup onto an empty host running the candidate and checks the same again. | `ubuntu-latest` |
| Docker: fresh install | Runs the three [quickstart](../quickstart.md) commands with the candidate's tag, checks the containers, `/api/health`, `/api/admin/status` and the UI, loads the demo data. A unit test fails when the quickstart's commands change, so the two cannot drift apart. | `ubuntu-latest` |
| Both of the above, with the report generator | The same with `COMPOSE_PROFILES=report-generator`, and one question to the local model at the end. | `ubuntu-latest` |
| Docker: sign-in on | A fresh install with sign-in on, then real Entra ID access tokens: a caller with the `Servicedesk` role reads data and is kept out of admin, a caller without a role gets `403 NO_ROLE` (F-01), a missing, malformed or other-API token gets `401`. | `ubuntu-latest`, `azure-release-test` environment |
| Portable | Both ZIPs (`IdentityAtlas-portable.zip`, PGlite; `-postgres`, started with `-Database Postgres` and checked to really run PostgreSQL): a fresh start with demo data and one page of the matrix, and an upgrade from the previous stable release's ZIP on the same data directory. | `windows-latest` |
| Azure | `main.json` (sign-in off) and `main.json` + `main-auth.json` (sign-in on), each with `deployReportGenerator` false and true: a fresh deploy, version and health check, the read endpoints or the sign-in checks. For both defaults also an upgrade: the previous stable release's template first, demo data, then the candidate's template over it, same totals afterwards. | IIDemos subscription, one new `ia-reltest-*` resource group per variant per run, always deleted |

Azure only runs for a beta or hotfix candidate, never for `:edge`, so nights without a candidate cost nothing in Azure.

### What it does not cover

Know these before you read a green run as "safe":

- **Sign-in through a browser.** The tokens are app-only (client credentials through a federated credential). The MSAL redirect, the redirect URI, delegated user tokens, roles assigned through a group, Conditional Access and MFA are not exercised.
- **Real data.** Only the synthetic demo dataset and a handful of ingested records. No crawler talks to a real system, and nothing is large: volume is covered, partly, by the load and soak tests in PR CI.
- **Credentials surviving a restore.** The restore checks that the web container did not start without its master key; it does not decrypt a stored crawler credential.
- **Upgrades across more than one release**, downgrades, and rolling back by restoring onto the older version.
- **Azure beyond the defaults**: private network mode, your own container registry, `webAccessDefaultAction=Deny`, sizes other than `xs`. On Azure the report generator is checked to be deployed, not asked a question.
- **The portable report model** (`-WithLLM`), and external LLM providers anywhere.

### When it runs

`.github/workflows/release-nightly.yml`, every night at 02:07 UTC (03:07 in Amsterdam in winter, 04:07 in summer; not on the hour, because GitHub delays top-of-hour schedules), and by hand (Actions → Release nightly → Run workflow, with a `candidate` to test one in particular).

1. **Plan** (`tools/release/Get-NightlyPlan.ps1`): is there a pre-release ahead of the newest stable release without a `release-tested-<tag>` artifact? Then test it, Azure included. Otherwise test `:edge` without Azure.
2. **Release test** of that candidate.
3. **Record** it as tested (green or red), so a beta is tested once. To test it again, run the workflow by hand with that tag as `candidate`.

The security route runs alongside, independently.

---

## The security route

Dependabot raises security PRs against `main`, never against a release branch (a GitHub limitation). The route carries those fixes to `:latest` without anyone cutting anything.

**Step by step:**

1. Dependabot opens a PR for a security alert. `dependabot-security-label.yml` runs `fetch-metadata` with `alert-lookup`; when the PR fixes an alert and is a **patch or minor** update, it gets the label `security-fix`. A major update is not labelled: it needs a person.
2. A person reviews and merges it. `main` requires an approving review, so this is where the clock starts. (Dependabot auto-merge applies to `release/**` only.)
3. That night, `security-plan` (`tools/release/Get-SecurityHotfixPlan.ps1`) lists every merged `security-fix` PR by Dependabot that the newest stable release does not contain yet, directly or as a `cherry-pick -x`.
4. `security-branch` creates `bugfixes/security-hotfix-<yyyyMMdd>` from the newest stable tag and cherry-picks each merge commit with `-x`, oldest first, then runs `Assert-ReleaseFromMain.ps1 -Mode Hotfix` on the result and pushes the branch.
5. `security-beta` runs **Cut Beta** in hotfix mode: `vX.Y.(Z+1)-beta.N`. docker-publish builds and pushes `:beta`.
6. `security-images` waits until all three images of that beta are on ghcr.io (about 20 minutes).
7. `security-test` runs the **full release test** against that beta, Azure included.
8. Only when it is green, `security-hotfix` runs **Cut Hotfix**: `vX.Y.(Z+1)`, `:latest` updates.
9. `security-finish` deletes the branch; the tag keeps the commits.

All fixes found in one night go into one hotfix.

**How long:** from the merge to `:latest` is the wait for 02:07 UTC (up to a day) plus roughly three hours: the beta build, the release test (about 1.5 hours with Azure) and the hotfix build.

### When it fails

Any red stage publishes nothing after it, **keeps the branch**, and opens one issue, *Scheduled workflow failing: Release nightly: security hotfix*, with the reason and the run link. Later failures are added to that issue as comments. While a `bugfixes/security-hotfix-*` branch exists, the route starts nothing new: fix the cause first.

| Reason in the issue | What to do |
|---|---|
| Cherry-picking #N … conflicts | The fix does not apply to the stable line as it is. Make the hotfix by hand: branch from the stable tag, `git cherry-pick -x` the commits, and resolve nothing by hand — a resolved conflict is refused by Cut Hotfix. If the fix needs an earlier change from `main`, cherry-pick that first, or cut a normal release from `main` instead. |
| Assert-ReleaseFromMain refuses the branch | One of the commits is not a clean copy of a `main` commit. Look at the branch; this should not happen with Dependabot PRs. |
| Cut Beta failed | Open the Cut Beta run. Usually a missing secret or a build error in the ZIPs. |
| The images did not appear in time | Open the **Publish Docker Images** run for the beta tag. A CVE scan failure there is the common one. |
| The release test is red | Open the Release Test run. If the failure is real, the fix needs work on `main`. If it is the test, fix the test, then retry. |
| Cut Hotfix failed | Open the Cut Hotfix run. If the tag was pushed before it failed, docker-publish may already be building `:latest`: check before retrying. |

**To retry** once the cause is gone: delete the kept branch, then run Release nightly by hand with **dry_run unticked**, or wait for the next night.

**Dry run:** a manual run of Release nightly is a dry run by default. It does everything except push tags, open issues and delete branches: the branch is built and pushed, Cut Beta and Cut Hotfix check and build everything up to the tag. With no beta tag there are no images to test, so the image wait and the release test are skipped. Delete the branch it leaves.

---

## Cutting a release by hand

**A normal release** (from `main`, after its beta proved itself):

1. Actions → **Cut Release** → Run workflow (from `main`).
2. Version: `X.Y.Z`. Ref: the beta tag you are promoting, for example `v6.2.0-beta.2`.
3. The workflow checks the ref is on `main`, tags it, builds both portable ZIPs and the Azure template package, writes the release notes and creates the GitHub release. docker-publish pushes `:latest` and `X.Y.Z.0`.

**A beta:** Actions → **Cut Beta**, version `X.Y.Z-beta.N`, ref `main` (or a commit on it).

**A hotfix by hand** (a bug fix, not a Dependabot security fix): merge the fix to `main` through an approved PR first, then

```bash
git checkout -b bugfixes/<name>-hotfix vX.Y.Z
git cherry-pick -x <merged commit on main>
git push origin bugfixes/<name>-hotfix
```

and Actions → **Cut Hotfix** with the branch and `X.Y.(Z+1)`. Cut a beta of the branch first (Cut Beta, `hotfix` ticked) if you want the release test to see it.

---

## One-time setup

Everything below is done once, by someone with admin rights on the IIDemos Azure tenant and on the GitHub repository. Nothing in the workflows creates any of it.

### 1. The Azure login for GitHub (IIDemos tenant)

1. **Microsoft Entra admin center** (entra.microsoft.com), signed in to the IIDemos tenant → **Identity → Applications → App registrations → New registration**.
   - Name: `Identity Atlas release test (GitHub)`
   - Supported account types: **Accounts in this organizational directory only**
   - Redirect URI: leave empty. **Register**.
2. On its **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. **Certificates & secrets → Federated credentials → Add credential**.
   - Federated credential scenario: **GitHub Actions deploying Azure resources**
   - Organization: `Fortigi` · Repository: `IdentityAtlas`
   - Entity type: **Environment** · GitHub environment name: `azure-release-test`
   - Name: `github-azure-release-test`. **Add**. Do not create a client secret.
4. **Azure portal → Subscriptions → IIDemos → Access control (IAM) → Add → Add role assignment**:
   - Role **Contributor** → Members: **User, group, or service principal** → select `Identity Atlas release test (GitHub)` → **Review + assign**.
   - Again, role **Role Based Access Control Administrator** → same member → **Conditions: Allow user to only assign selected roles to selected principals (fewer privileges)** → roles **AcrPull**, **Website Contributor**, **Key Vault Secrets User** and **Key Vault Secrets Officer** → **Review + assign**. These are the only roles the templates assign (the two Key Vault roles since the vault moved to Azure RBAC, #1638).
5. Copy the **Subscription ID** of IIDemos.

Neither role can remove a resource lock, and the workflow only ever names resource groups starting with `ia-reltest-` (`tools/release/ReleaseTest.Azure.ps1`, proven by `test/unit/ReleaseTestAzure.Tests.ps1`). The locks on HRSystem stay as they are.

### 2. The sign-in apps (IIDemos tenant)

The sign-in checks need an app registration that plays Identity Atlas's own SSO app, and two callers: the release-test app above with a role, and a second app without one.

**SSO app**

1. **App registrations → New registration**: name `Identity Atlas release test SSO`, this directory only, **no redirect URI**. **Register**. Copy its **Application (client) ID**.
2. **Expose an API → Add** next to *Application ID URI* → accept the default `api://<client id>` → **Save**. Then **Add a scope**: name `access`, who can consent **Admins and users**, any display texts → **Add scope**.
3. **App roles → Create app role**: display name and value `Servicedesk`, Allowed member types **Applications**, any description, **Do you want to enable this app role?** ticked → **Apply**. This is the only role the test needs, and the only one that must be assignable to an app; in a customer's setup the roles are for *Users/Groups*, so no app can be given one.
4. **Enterprise applications** → `Identity Atlas release test SSO` → **Properties** → **Assignment required?** **No** → **Save**. This is deliberate: with *Yes*, Entra would refuse the no-role caller a token, and the test could not show that **Identity Atlas itself** refuses it, which is the F-01 finding.

**The release-test app gets the `Servicedesk` role**

5. **App registrations** → `Identity Atlas release test (GitHub)` → **API permissions → Add a permission → APIs my organization uses** → `Identity Atlas release test SSO` → **Application permissions** → tick **Servicedesk** → **Add permissions** → **Grant admin consent for IIDemos** → **Yes**.

**The no-role caller**

6. **App registrations → New registration**: `Identity Atlas release test no-role (GitHub)`, this directory only, no redirect URI. Copy its **Application (client) ID**.
7. **Certificates & secrets → Federated credentials → Add credential**, exactly as in step 1.3 (environment `azure-release-test`). Give it **no** API permissions and **no** roles.

**About the redirect URI.** A deployment's address is `idatlas-<hash>-web.azurewebsites.net`, where the hash comes from the resource group's id. A new resource group every run, which purge protection on the Key Vault requires, means a new address every run, and Entra does not accept wildcards in redirect URIs. The release test does not need one: it does not sign in through a browser (see [What it does not cover](#what-it-does-not-cover)), and a redirect URI plays no part in an access token. So register none. To click through a deployment by hand, deploy it yourself into a resource group you keep and add that one address as a **Single-page application** redirect URI on the SSO app. A stable address for the nightly deployments would need a custom domain or a fixed web-app name, which the templates do not offer; that is not worth adding for a test that does not use it.

### 3. The GitHub environment

1. GitHub → **Fortigi/IdentityAtlas → Settings → Environments → New environment** → name `azure-release-test` → **Configure environment**.
2. **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule**: type **Branch**, pattern `main` → **Add rule**. Again: type **Tag**, pattern `v*` → **Add rule**.
3. No required reviewers: the nightly run is unattended.
4. **Environment variables → Add variable**, five times:

   | Name | Value |
   |---|---|
   | `AZURE_CLIENT_ID` | client ID of `Identity Atlas release test (GitHub)` |
   | `AZURE_TENANT_ID` | the IIDemos tenant ID |
   | `AZURE_SUBSCRIPTION_ID` | the IIDemos subscription ID |
   | `RELEASE_TEST_SSO_CLIENT_ID` | client ID of `Identity Atlas release test SSO` |
   | `RELEASE_TEST_NOROLE_CLIENT_ID` | client ID of `Identity Atlas release test no-role (GitHub)` |

   They are not secrets: an ID alone grants nothing without a federated token from this environment.

### 4. The GitHub App for the alert lookup

`fetch-metadata`'s alert lookup reads Dependabot alerts, which `GITHUB_TOKEN` cannot. It gets its own App with nothing else, because the release App can push to `main` and must not be minted on a Dependabot event.

1. GitHub → **Fortigi organization → Settings → Developer settings → GitHub Apps → New GitHub App**.
   - Name: `Identity Atlas security lookup` · Homepage URL: the repository URL
   - **Webhook**: untick **Active**
   - **Repository permissions → Dependabot alerts: Read-only**. Nothing else (*Metadata: read* is added automatically).
   - Where can this app be installed: **Only on this account**. **Create GitHub App**.
2. Copy the **Client ID**. **Private keys → Generate a private key**; a `.pem` file downloads.
3. **Install App** → Fortigi → **Only select repositories** → `IdentityAtlas` → **Install**.
4. **Fortigi/IdentityAtlas → Settings → Secrets and variables → Actions → New repository secret**, twice:
   - `SECURITY_LOOKUP_APP_ID` = the Client ID
   - `SECURITY_LOOKUP_PRIVATE_KEY` = the whole contents of the `.pem` file
5. Delete the downloaded `.pem`.

Without these two secrets nothing breaks: Dependabot PRs are simply not labelled, and the route finds no security fixes.

### 5. Check what is already there

- The **release-automation** environment holds `BOT_PRIVATE_KEY` and admits `main`; Cut Beta and Cut Hotfix read it from there when the nightly run calls them.
- No ruleset may stop `github-actions[bot]` (the workflow's own token) from creating and deleting `bugfixes/security-hotfix-*` branches. If one does, the route fails at `security-branch` with that in the log.

### 6. First run

After the stack is merged: Actions → **Release nightly** → **Run workflow** with *dry_run* ticked (the default). Check the run summary, then delete the `bugfixes/security-hotfix-*` branch if it built one. To see the Azure part once, run **Release Test** by hand with a beta tag as candidate and *azure* ticked.

---

## Runtime and cost

Estimates: the Azure part has not run yet when this page was written.

| Night | Wall clock | Azure |
|---|---|---|
| No candidate (`:edge`, Docker and portable) | about 30 minutes | none |
| A beta to test | about 1.5 hours (the Azure upgrades are the longest jobs) | 6 resource groups, about €1–2 |
| A security hotfix | about 3 hours (beta build, full release test, hotfix build) | another 6 groups, about €1–2 |

Each resource group runs the `xs` profile for roughly half an hour to an hour: an App Service B1, a Burstable B1ms PostgreSQL server with 32 GB, the worker Container App, a Key Vault, a storage account and a Log Analytics workspace, plus a few minutes of deployment-script container. At about €0.10–0.20 per group-hour that is €1–2 a night with a candidate. GitHub-hosted runners cost nothing for this public repository.

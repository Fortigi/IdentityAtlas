# Release process

How a change travels from `main` to the image operators run, what is tested on the way, how dependency updates reach stable every week without anyone cutting anything, and what to do when that goes wrong. For the one-time Azure and GitHub setup the automation needs, see [One-time setup](#one-time-setup) at the end.

The branching rules themselves (main first, branch names, version numbers on `main`) are in `CLAUDE.md` and [Release & Branching Strategy](../architecture/branching-strategy.md). This page is the operational side.

---

## Release policy

These are decisions, agreed in November 2026. The automation below implements them; change them here first.

1. **Major.Minor says what the product can do. The last digit counts dependency updates.** 6.1 and 6.2 differ in functionality, which was built and tested as a whole. 6.1.2, 6.1.3, 6.1.4 … are the same 6.1 with newer libraries (and the odd cherry-picked bug fix). At most one new stable a week.
2. **Every Dependabot update ships, once a week.** There is no distinction between security updates and other updates: staying current is the point, and it means a security fix is never missed because nobody labelled it. Each week that something was updated, a new beta and, if its release test is green, a new stable are cut. One release a week is enough to keep the dependencies current, and it keeps the number of versions operators see, and the release tests we pay for, small. An update that cannot wait a week (an actively exploited vulnerability) is released by running **Release weekly** by hand.
3. **Only the newest stable minor is maintained.** When 6.2.0 is released, 6.1 gets nothing more; operators on 6.1 upgrade to 6.2, an in-place upgrade the release test proves for every candidate. The 5.x line has ended: `release/5.9` is no longer updated or released. There is no long-term-support line; one can be added if a customer needs it (release branches are permanent, so an older `release/X.Y` can be picked up again), but that is a deliberate change: the weekly plan, the Dependabot entries and Cut Release all assume one maintained line today.
4. **No major library upgrades on the stable line.** A major is the one update expected to change behaviour, so it reaches customers with the next minor, after `main` and a full release test. The consequence: a security fix that exists *only* in a new major version arrives with that minor, not with the next weekly release.
5. **Test what changed.** Every release gets the Docker, backup and restore, sign-in and portable tests. The Azure deployment is tested for the first beta of every new minor (the full end-to-end test) and whenever the Azure templates changed, and not for a release that only moves libraries: redeploying unchanged templates adds cost and false alarms when Azure itself misbehaves, and finds nothing new.
6. **Main first, with one narrow exception.** Nothing is released that is not on `main`, except Dependabot's own updates of the release line. Those cannot be cherry-picked from `main`: a week after v6.1.1, 10 of 12 of `main`'s Dependabot commits conflicted on the 6.1 lockfiles. The exception is checked strictly; see [The Dependabot exception](#the-dependabot-exception).

---

## The channels

| Channel | Docker tag | What it is | Made by | How often |
|---|---|---|---|---|
| **Edge** | `:edge` + `Major.Minor.yyyyMMdd.HHmm` | `main` as it is | `docker-publish.yml`, after every merge | Every merge to `main` |
| **Beta** | `:beta` + `X.Y.0-beta.N` | A preview of the next minor, cut from `main` | The weekly **beta route**, or Actions → Cut Beta by hand | Once a week, when a Dependabot update of shipped code landed on `main` |
| **Stable** | `:latest` + `X.Y.Z.0` | The newest stable minor with this week's libraries | The weekly **stable route** (patches); Actions → Cut Release by hand (a new minor) | Once a week, when the release line moved |

A patch beta (`X.Y.Z-beta.N` with Z > 0) is the stable route's test candidate. It gets only its own version tag, never `:beta`: moving `:beta` to it would put everyone on `:beta` back a whole minor, onto a database the newer version already migrated. `docker-publish.yml` enforces this.

### Release lines

```
                    Dependabot, weekly, patch and minor, production dependencies only
                                 │        │        │
v6.1.1 ──→ release/6.1 ──────────●────────●────────●──────→  what :latest runs
                │                │        │        │
              v6.1.1          v6.1.2   v6.1.3   v6.1.4         (one per week it moved)

main ───●────●────●────●────●────●────●────────────────────→  :edge, feature work
             │              │              │
       6.2.0-beta.1   6.2.0-beta.2   6.2.0-beta.3  →  Cut Release 6.2.0  →  release/6.2
                                                                            (6.1 stops)
```

- **`release/X.Y`** is created by **Cut Release** when it cuts `X.Y.0`, at that tag. Cut Release also opens a pull request into `main` that points the release-line entries of `.github/dependabot.yml` at the new branch. Until that PR is merged the new line gets no updates (the weekly plan warns), so merge it the same day.
- **Dependabot** checks the release line **weekly, on Monday at 05:00 UTC,** for production npm dependencies of `app/api` and `app/ui` and for the base images of `app/api` and `setup/docker`, patch and minor only. `dependabot-auto-merge.yml` merges each PR once CI (`CI Passed`, `Integration CI Passed`) is green; the *Protect release branches* ruleset requires no approving review.
- **`main`** keeps its own weekly Dependabot schedule, and security updates always go to `main` (GitHub raises them only against the default branch). The two lines are updated from upstream independently and never merge into each other. The release line catches a security fix through its weekly version check: a fixed version reaches `:latest` one to eight days after it is published, depending on where in the week it falls.

---

## What happens each week

`.github/workflows/release-weekly.yml`, every Tuesday at 02:07 UTC (03:07 in Amsterdam in winter, 04:07 in summer). Tuesday, so the release line's Monday Dependabot PRs have had a day to pass CI and merge; not on the hour, because GitHub delays top-of-hour schedules.

**1. Plan** (`tools/release/Get-WeeklyPlan.ps1`; every rule unit-tested in `test/unit/ReleaseWeekly.Tests.ps1`). It writes what it decided, and why, at the top of the run summary.

**2. The stable route**, when `release/X.Y` (for the newest stable `vX.Y.Z`) has commits that `vX.Y.Z` does not:

1. **Cut Beta** (release-line mode) tags `vX.Y.(Z+1)-beta.N` on the line's newest commit. That commit is fixed at planning time: Dependabot may merge more while the route runs, and those wait for the next week.
2. Wait until docker-publish has pushed all three images of that beta (about 20 minutes).
3. **The release test** of that beta. Azure only when the Azure templates differ between `vX.Y.Z` and the line.
4. Only when it is green, **Cut Hotfix** tags `vX.Y.(Z+1)` on the **same commit**: `:latest` moves, the GitHub release gets the ZIPs, and its notes list every dependency that moved.

**3. The beta route**, when `main` has Dependabot commits that change shipped code (anything but development-only dependencies) since the previous beta of the next minor:

1. **Cut Beta** tags `vX.(Y+1).0-beta.N` on `main`'s newest commit; `:beta` moves.
2. Wait for its images, then **the release test**. Azure for the first beta of a minor, and whenever the templates changed since the beta before it.

There is no promotion: a new minor becomes stable only when a person cuts it (see [A new minor](#a-new-minor)).

**4. Otherwise a test only.** In a week without a new beta of `main`: a pre-release nobody tested yet (one cut by hand) gets the full release test; failing that, `:edge` gets the Docker and portable parts, without Azure, as an early warning.

Each tested beta leaves an artifact `release-tested-<tag>` (90 days) with its result, so it is tested once. A route does not try the same commit twice: the stable route waits until the line moves again, the beta route until another Dependabot update lands. **A manual run** (Actions → Release weekly → Run workflow) is a **dry run** by default: it does everything except push tags and open issues, so there are no images to wait for and the release test is skipped. Untick *dry_run* to make it real; tick *retry_stable* to try the stable route again on a commit that was already tried; give a *candidate* to only test that tag and cut nothing.

**How long:** from a Dependabot merge on the release line to `:latest` is the wait for Tuesday 02:07 UTC (up to a week) plus about two hours: the beta build, the release test (about an hour without Azure) and the stable build.

---

## What each release is tested on

| Release | Docker: upgrade, backup and restore | Docker: fresh install | Sign-in | Portable ZIPs | Azure |
|---|---|---|---|---|---|
| First beta of a new minor (`X.Y.0-beta.1`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| A later beta of `main` whose Azure templates changed since the beta before it | ✅ | ✅ | ✅ | ✅ | ✅ |
| A later beta of `main`, templates unchanged | ✅ | ✅ | ✅ | ✅ | — |
| A stable patch (`X.Y.Z`, Z > 0), dependency updates only | ✅ | ✅ | ✅ | ✅ | — |
| A stable patch whose release line changed the Azure templates (a cherry-picked fix) | ✅ | ✅ | ✅ | ✅ | ✅ |
| A new minor going stable (`X.Y.0`, by hand) | Through the beta it is cut from, which must have had a full test: see [A new minor](#a-new-minor) |||||
| `:edge`, a week without a beta of `main` | ✅ | ✅ | ✅ | ✅ | — |

The backup and restore test runs for **every** release, dependency-only patches included: a library update can change how the database is written as much as a feature can.

### Release blockers

Besides the release test itself, a candidate is held back when either of these is red on its commit:

- **The authorization suites**: the **Security: authorization regression** job (`npm run test:security` in `app/api`), which includes the read-token and role-mapping contract tests in `app/api/contract-tests/`. A red one is a release blocker, never a flake to rerun past.
- **CI Passed** and **Integration CI Passed** for the merges it contains.

**Experimental features are not certified per release.** Risk scoring and everything else behind Admin → Experimental (see [Experimental features](../reference/experimental-features.md)) is checked for one thing only: off really is off, so an install that never switched it on is not affected. A release is not held back because an experimental feature misbehaves while switched on, and the release test does not exercise one.

---

## The release test

`.github/workflows/release-test.yml`, logic in `tools/release/` (`Invoke-*ReleaseTest.ps1` and `ReleaseTest.*.ps1`, unit tests in `test/unit/ReleaseTest*.Tests.ps1`). It tests a **published** candidate (a beta tag, or `:edge`): the images from ghcr.io and the ZIPs from the GitHub release, not a build of the PR. Every part runs on GitHub-hosted runners, never on a sidekick.

| Part | What it does | Where |
|---|---|---|
| Docker: upgrade, backup and restore | Starts the previous stable release with its own `docker-compose.prod.yml`, loads the demo data, pushes one record of each kind through the ingest API, makes [person-made data](#person-made-data) through the API the UI uses, backs up exactly as [Back up, restore and upgrade](../admin/backup-restore-upgrade.md) says, switches to the candidate, waits for the migrations, checks the running version, the read endpoints, that the core row counts did not change and that every person-made record reads back with exactly its values. Then **restores that backup onto an empty host** running the candidate and checks the same again: the backup procedure as documented must give back the same database. | `ubuntu-latest` |
| Docker: fresh install | Runs the three [quickstart](../quickstart.md) commands with the candidate's tag, checks the containers, `/api/health`, `/api/admin/status` and the UI, loads the demo data. A unit test fails when the quickstart's commands change, so the two cannot drift apart. | `ubuntu-latest` |
| Both of the above, with the report generator | The same with `COMPOSE_PROFILES=report-generator`, and one question to the local model at the end. | `ubuntu-latest` |
| Docker: sign-in on | A fresh install with sign-in on, then real Entra ID access tokens: a caller with the `Servicedesk` role reads data and is kept out of admin, a caller without a role gets `403 NO_ROLE` (F-01), a missing, malformed or other-API token gets `401`. | `ubuntu-latest`, `azure-release-test` environment |
| Portable | Both ZIPs (`IdentityAtlas-portable.zip`, PGlite; `-postgres`, started with `-Database Postgres` and checked to really run PostgreSQL): a fresh start with demo data and one page of the matrix, and an upgrade from the previous stable release's ZIP on the same data directory, with the same [person-made data](#person-made-data) check across it. | `windows-latest` |
| Azure | `main.json` (sign-in off) and `main.json` + `main-auth.json` (sign-in on), each with `deployReportGenerator` false and true: a fresh deploy, version and health check, the read endpoints or the sign-in checks. For both defaults also an upgrade: the previous stable release's template first, demo data, then the candidate's template over it, same totals afterwards. | IIDemos subscription, one new `ia-reltest-*` resource group per variant per run, always deleted. Starts in `westeurope`; when Azure answers `SkuNotAvailable` (no Burstable PostgreSQL capacity in that region right now) the group is deleted and the whole variant starts over in `swedencentral`, then `northeurope`, each in a group of its own (`<group>-<region>`). Any other failure fails the variant at once |

### Person-made data

Backup and restore is the way to move an instance, so it has to keep what people made in the app, which no crawl brings back. Row counts cannot show that, so the upgrade tests make one of each through the API with values no install has by default, and read each back afterwards, comparing the exact values (`tools/release/ReleaseTest.CuratedData.ps1`, unit-tested by `test/unit/ReleaseTestCuratedData.Tests.ps1`):

- a tag on two users, and a manual context holding the same two
- a CSV crawler configuration with a (switched-off) weekly schedule
- a governance category
- the account-linking threshold, changed from its default
- an extra role in the role → permission mapping
- one feature flag switched the other way
- a saved matrix with its filter
- a read API key: name, prefix and not revoked; on Docker also that its stored hash still matches the key, which is what sign-in checks (the Docker scenarios run with sign-in off, where no request would test it); with sign-in on, that the key still gets in and a changed key does not
- an analyst's confirmation of one identity link (skipped with a warning when the demo data has no identity with a linked account)

The previous stable release makes the records, so only endpoints it already has are used. Risk profiles and risk overrides are left out: risk scoring is experimental (see [Release blockers](#release-blockers)).

### What it does not cover

Know these before you read a green run as "safe":

- **Credentials surviving a restore.** The restore checks that the web container did not start without its master key; it does not decrypt a stored crawler credential.
- **Sign-in through a browser.** The tokens are app-only (client credentials through a federated credential). The MSAL redirect, the redirect URI, delegated user tokens, roles assigned through a group, Conditional Access and MFA are not exercised.
- **Real data.** Only the synthetic demo dataset and a handful of ingested records. No crawler talks to a real system, and nothing is large: volume is covered, partly, by the load and soak tests in PR CI.
- **Upgrades across more than one release**, downgrades, and rolling back by restoring onto the older version.
- **Azure beyond the defaults**: private network mode, your own container registry, `webAccessDefaultAction=Deny`, sizes other than `xs`. On Azure the report generator is checked to be deployed, not asked a question. And Azure is skipped for releases that did not change the templates (see [the policy](#release-policy)): an image that starts in Docker but not on App Service would be caught at the next minor.
- **The portable report model** (`-WithLLM`), and external LLM providers anywhere.

---

## When a route fails

A red stage publishes nothing after it and opens one issue per route, *Scheduled workflow failing: Release weekly: stable patch release* or *… beta*, with the reason and the run link. Later failures of the same route are added to that issue as comments. Nothing is cleaned up: a failed beta keeps its tag, and the next attempt gets the next number.

| Reason in the issue | What to do |
|---|---|
| Cut Beta failed | Open the Cut Beta run. `Assert-ReleaseFromMain` refusing a commit is the interesting case: see below. Otherwise usually a missing secret or a build error in the ZIPs. |
| `… is not on main, not a 'git cherry-pick -x' …` | A commit reached the release line that is neither a clean cherry-pick of `main` nor an accepted Dependabot update, for example something pushed by hand. Revert it on the line through a PR, or replace it with a clean `cherry-pick -x` of the `main` commit. |
| `… (Dependabot) changes …` | A Dependabot PR changed more than versions (a script in `package.json`, a package from outside the npm registry, a Dockerfile line other than `FROM`). Look at the PR before anything else. |
| The images did not appear in time | Open the **Publish Docker Images** run for the beta tag. A CVE scan failure there is the common one. |
| The release test is red | Open the Release Test run. If an update broke something, fix it on `main` (or pin the dependency there) and cherry-pick the fix onto the line; if the test itself is wrong, fix the test. |
| Cut Hotfix failed | Open the Cut Hotfix run. If the tag was pushed before it failed, docker-publish may already be building `:latest`: check before retrying. |

**To retry:** the stable route tries again by itself as soon as the release line moves. To try the same commit again, run Release weekly by hand with *dry_run* unticked and *retry_stable* ticked. The beta route tries again with the next Dependabot update on `main`, or cut a beta by hand.

---

## Cutting a release by hand

### A new minor

The only release a person cuts. Do it when `main` has the features you want in it and its betas have proven themselves.

1. Pick the beta you are promoting, `vX.Y.0-beta.N`, and make sure **it** passed a full release test, Azure included. The weekly run tests every beta of `main`, but includes Azure only for the first beta of a minor and when the templates changed; if the beta you are promoting skipped Azure, run **Release weekly** by hand with that tag as *candidate*: a candidate asked for by hand always gets Azure.
2. Nobody running the beta has reported a regression.
3. Actions → **Cut Release** → version `X.Y.0`, ref **the beta tag**, so stable is the commit that was tested and not whatever `main` has become since.
4. Cut Release tags it, builds both portable ZIPs and the Azure package, creates the GitHub release (`:latest` moves), creates `release/X.Y` from the tag, and opens the PR that moves Dependabot to it. **Approve and merge that PR the same day.**
5. The previous line (`release/X.(Y-1)`) now gets nothing more. Leave the branch in place; it is history.

### A bug fix on the stable line

Fix it on `main` first, through an approved PR. Then:

```bash
git fetch origin
git checkout -b bugfixes/<name>-on-X.Y origin/release/X.Y
git cherry-pick -x <the merged commit on main>     # -x is required; resolve no conflicts by hand
git push origin bugfixes/<name>-on-X.Y
gh pr create --base release/X.Y --title "fix: <what> (cherry-pick of #<PR>)"
```

**One cherry-pick per PR**: the squash merge must reproduce the main commit's exact lines, which a PR of two commits would not. The PR needs no approval but must pass CI; the next weekly run's stable route releases it with whatever Dependabot added. A fix that cannot wait for Tuesday: run **Release weekly** by hand with *dry_run* unticked once the PR has merged. If the cherry-pick conflicts, the fix needs an earlier change from `main`: cherry-pick that first, or ship the fix with the next minor.

### A beta by hand

Actions → **Cut Beta**, version `X.Y.0-beta.N` (the next free number), ref `main` or a commit on it. The next weekly run tests it in full, Azure included; run **Release weekly** by hand with that tag as *candidate* to test it sooner.

---

## The Dependabot exception

`tools/release/Assert-ReleaseFromMain.ps1` runs before every tag (Cut Beta, Cut Hotfix, Cut Release) and again in docker-publish, always loaded from the workflow's own commit on `main`, never from the ref being released. In `-Mode Hotfix` (the release line) every commit after the stable tag must be one of:

- on `main` itself;
- a `git cherry-pick -x` of a `main` commit that changes exactly the same lines (compared by `git patch-id`, so a hand-resolved conflict is refused);
- **a Dependabot update of the release line**, which means all of:
    - authored by Dependabot (`49699333+dependabot[bot]@users.noreply.github.com`),
    - committed by GitHub (`noreply@github.com`), that is, merged through a pull request and not pushed with a copied author,
    - on `release/X.Y`, the line of the stable tag the release starts from,
    - changing only `app/api` / `app/ui` `package.json` and `package-lock.json` and the Dockerfiles of `app/api`, `app/ui` and `setup/docker`,
    - and within those: in `package.json` only the versions inside the dependency lists, as plain versions (no git URLs, no added or removed packages, no scripts); in `package-lock.json` only packages resolved from `registry.npmjs.org`; in a Dockerfile only `FROM` lines.

Run against the real `release/5.9` line it accepts all 19 Dependabot merges and refuses the one commit a person pushed there (an `npm audit fix`). The cases are in `test/unit/AssertReleaseFromMain.Tests.ps1`, each one changing a single thing about an otherwise accepted update.

---

## One-time setup

Everything below is done once, by someone with admin rights on the IIDemos Azure tenant and on the GitHub repository. Nothing in the workflows creates any of it, except `release/X.Y` for every later minor.

### 1. The release line for 6.1

Create it once, from the current stable tag, **before** this setup's Dependabot entries are merged (Dependabot reports an error for a `target-branch` that does not exist):

```bash
git fetch origin --tags
git push origin "v6.1.1^{commit}:refs/heads/release/6.1"
```

From 6.2.0 on, Cut Release does this itself.

### 2. The Azure login for GitHub (IIDemos tenant)

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

### 3. The sign-in apps (IIDemos tenant)

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
7. **Certificates & secrets → Federated credentials → Add credential**, exactly as in step 2.3 (environment `azure-release-test`). Give it **no** API permissions and **no** roles.

**About the redirect URI.** A deployment's address is `idatlas-<hash>-web.azurewebsites.net`, where the hash comes from the resource group's id. A new resource group every run, which purge protection on the Key Vault requires, means a new address every run, and Entra does not accept wildcards in redirect URIs. The release test does not need one: it does not sign in through a browser (see [What it does not cover](#what-it-does-not-cover)), and a redirect URI plays no part in an access token. So register none. To click through a deployment by hand, deploy it yourself into a resource group you keep and add that one address as a **Single-page application** redirect URI on the SSO app.

### 4. The GitHub environment

1. GitHub → **Fortigi/IdentityAtlas → Settings → Environments → New environment** → name `azure-release-test` → **Configure environment**.
2. **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule**: type **Branch**, pattern `main` → **Add rule**. Again: type **Tag**, pattern `v*` → **Add rule**.
3. No required reviewers: the weekly run is unattended.
4. **Environment variables → Add variable**, five times:

   | Name | Value |
   |---|---|
   | `AZURE_CLIENT_ID` | client ID of `Identity Atlas release test (GitHub)` |
   | `AZURE_TENANT_ID` | the IIDemos tenant ID |
   | `AZURE_SUBSCRIPTION_ID` | the IIDemos subscription ID |
   | `RELEASE_TEST_SSO_CLIENT_ID` | client ID of `Identity Atlas release test SSO` |
   | `RELEASE_TEST_NOROLE_CLIENT_ID` | client ID of `Identity Atlas release test no-role (GitHub)` |

   They are not secrets: an ID alone grants nothing without a federated token from this environment.

### 5. Check what is already there

- The **release-automation** environment holds `BOT_PRIVATE_KEY` and admits `main`; Cut Beta, Cut Hotfix and Cut Release read it from there when the weekly run calls them.
- The *Protect release branches* ruleset (`release/**`) requires a pull request, **no** approving review, and the status checks `CI Passed` and `Integration CI Passed`. It must not require a review, or Dependabot's updates wait for a person; it must keep those checks, because they are all that stands between a Dependabot PR and `:latest`. It has no creation rule, so Cut Release's release App can create `release/X.Y`.

### 6. First run

After merging: Actions → **Release weekly** → **Run workflow** with *dry_run* ticked (the default). Read the plan at the top of the run summary. Expect, on the first real run, `6.2.0-beta.1` from `main` with the full test including Azure, and, once Dependabot has merged something into `release/6.1`, `6.1.2-beta.1` → `6.1.2`.

---

## Runtime and cost

Estimates: the Azure part has not run yet when this page was written.

| Run | Wall clock | Azure |
|---|---|---|
| Nothing to cut (`:edge`, Docker and portable) | about 30 minutes | none |
| A stable patch, dependency updates only | about 2 hours (beta build, release test without Azure, stable build) | none |
| A beta of `main`, templates unchanged | about 1.5 hours | none |
| The first beta of a minor, or templates changed | about 2 hours (the Azure upgrades are the longest jobs) | 6 resource groups, about €1–2 |

The two routes run side by side. Each resource group runs the `xs` profile for roughly half an hour to an hour: an App Service B1, a Burstable B1ms PostgreSQL server with 32 GB, the worker Container App, a Key Vault, a storage account and a Log Analytics workspace, plus a few minutes of deployment-script container. At about €0.10–0.20 per group-hour that is €1–2 a run with Azure. GitHub-hosted runners cost nothing for this public repository.

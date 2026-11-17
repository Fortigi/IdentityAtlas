# Branching and Versioning Strategy

This document covers branch naming, PR rules, version format, and the release workflow for contributors.

---

## Branch Model

| Branch | Purpose | PR required? | Approval required? |
|--------|---------|-------------|-------------------|
| `main` | Stable trunk. Never commit directly. | Yes | Yes (at least 1) |
| `feature/<name>` | All feature work. Created from `main`. Merged back to `main` via PR. | Yes | No |
| `bugfixes/<name>` | Bug fixes. Branch from `main`. To bring a merged fix to the stable line, branch from `release/X.Y` and cherry-pick it. | Yes (to `main`, or to `release/X.Y`) | No |
| `release/X.Y` | The one maintained stable line: the newest stable minor. Created by Cut Release at `vX.Y.0`; Dependabot updates it daily; the nightly stable route releases it. | Yes | No (CI must pass) |

**Rules:**

- `feature/` branches must be branched off `main`.
- `bugfixes/` branches branch from `main`. A fix that must reach the stable line too is merged to `main` first, then cherry-picked with `-x` in a PR into `release/X.Y`.
- **Main first — nothing is released that is not on `main`,** with one exception: Dependabot's own dependency updates of the release line. The cut workflows enforce both (`tools/release/Assert-ReleaseFromMain.ps1`); see [Release process](../contributing/release-process.md#the-dependabot-exception).
- **Only the newest stable minor is maintained.** When `X.Y.0` is released, the previous line gets nothing more.
- All merges to `main` go through a Pull Request — no direct pushes.
- Branch names: lowercase, hyphens. Examples: `feature/risk-score-export`, `bugfixes/fix-login-redirect`.
- **One issue per branch.** Each branch fixes exactly one issue or implements exactly one feature. Never combine unrelated fixes into a single branch or PR.

---

## Starting New Work

```bash
# Feature or pre-release bugfix — branch from main
git checkout main && git pull
git checkout -b feature/<name>
# or
git checkout -b bugfixes/<name>

# Bring a fix that is already merged to main onto the stable line
git checkout -b bugfixes/<name>-on-6.1 origin/release/6.1
git cherry-pick -x <merged commit on main>
```

---

## Version Number Format

| Context | Format | Example |
|---------|--------|---------|
| `main` dev builds (`:edge`) | `Major.Minor.yyyyMMdd.HHmm` | `6.3.20261023.1430` |
| Betas of the next minor (`:beta`) | `Major.Minor.0-beta.N` | `6.2.0-beta.3` |
| Patch betas of the release line (own tag only) | `Major.Minor.Patch-beta.N` | `6.1.4-beta.1` |
| Release tags (`:latest`) | `Major.Minor.Patch.0` | `6.1.4.0` |

`Major.Minor` of a release says what it can do: 6.1 and 6.2 differ in features. The last digit counts the dependency updates (and the odd cherry-picked fix) since `X.Y.0`.

**Who updates what:**

| Action | Who | When |
|--------|-----|------|
| `Minor` bump + timestamp | `bump-version.yml` GitHub Action | Automatically on every PR merge to `main` |
| Beta of the next minor | `cut-beta.yml`, called by the nightly beta route | Each night `main` got a Dependabot update of shipped code; or by hand |
| Patch release (`X.Y.1`, `X.Y.2` …) | `cut-beta.yml` then `cut-hotfix.yml`, called by the nightly stable route | Each night `release/X.Y` moved, once the beta passed the release test |
| New minor (`X.Y.0`) | `cut-release.yml` | When you run Actions → Cut Release |
| `Major` bump | `bump-version.yml` GitHub Action | On the first PR merge after a release (or beta) of a new major is tagged — `Major` follows the highest `vX.Y.Z` tag and `Minor` restarts at 1 |
| Branch work | Nobody | Never touch `setup/IdentityAtlas.psd1` on a branch |

---

## Changelog Fragments

Every `feature/` or `bugfixes/` branch must include a changelog fragment. **Never edit `CHANGES.md` directly** — the `bump-version.yml` CI action merges all fragments on PR merge.

**File:** `changes/<descriptive-name>.md` (e.g. `changes/fix-login-redirect.md`)

**Format:**

```markdown
- Fixed the login redirect when auth is enabled and no session exists
- Improved error message when tenant ID is missing
```

Write in user-facing language. One bullet per functional change. Add the file alongside the code change — don't batch at the end.

---

## Merging to Main (via PR)

1. Open a PR from `feature/<name>` or `bugfixes/<name>` into `main`.
2. Use the changelog fragment content as the PR description body.
3. Requires 1 approval and passing CI.
4. After merge, `bump-version.yml` automatically increments `Minor`, updates the timestamp, and merges all `changes/*.md` fragments into `CHANGES.md`. The `docker-publish.yml` action then builds and pushes Docker images tagged `:edge`.

---

## Cutting a Pre-Release (Beta / RC)

The nightly beta route cuts most betas. To publish one by hand without touching `:latest`:

1. Go to **Actions → Cut Beta → Run workflow**
2. Enter the version: `Major.Minor.Patch-beta.N` (e.g. `5.3.0-beta.1`, `5.3.0-rc.1`, `5.3.0-alpha.1`)
3. The workflow creates the tag on the current `main` HEAD (or on the optional **ref** input — any branch, tag or commit)
4. `docker-publish.yml` builds `:beta` + `:5.3.0-beta.1` (`:beta` moves only for an `X.Y.0` pre-release)

Users on `docker-compose.prod.yml` tracking `:latest` are **not** affected.

## Cutting a Release

> The body of the GitHub release — changelog, baseline comparison and the
> dependency-update list — is assembled by the workflow. See
> [How a release's notes are assembled](../process/release-notes.md).

A person cuts only a new minor, from a beta of it that passed a full release test (see [Release process → A new minor](../contributing/release-process.md#a-new-minor)):

1. Go to **Actions → Cut Release → Run workflow**
2. Enter the version: `Major.Minor.0` (e.g. `6.2.0`) and, as ref, the beta tag you are promoting
3. The workflow creates tag `v6.2.0` on that commit (it must be on `main`)
4. `docker-publish.yml` triggers automatically on the tag push and builds `:latest` + `:6.2.0.0`
5. The workflow creates `release/6.2` and opens a PR that moves Dependabot's release-line entries there. Merge it the same day; `release/6.1` then gets nothing more.

Customers who track `:latest` will receive the new version on their next `docker compose pull`.

---

## Patch Releases

Nobody cuts these by hand. Each night that `release/X.Y` moved, the nightly stable route (`release-nightly.yml`) cuts a beta of its newest commit, runs the release test, and cuts `X.Y.(Z+1)` on that same commit if it is green. The line moves in two ways:

- **Dependabot**, daily: patch and minor updates of production dependencies and base images, merged by `dependabot-auto-merge.yml` once CI is green.
- **A bug fix**, by hand: fix it on `main` first (PR, approval, merge), then open a PR into the line with one `-x` cherry-pick:

```bash
git checkout -b bugfixes/fix-login-crash-on-6.1 origin/release/6.1
git cherry-pick -x <merged commit on main>
git push origin bugfixes/fix-login-crash-on-6.1
gh pr create --base release/6.1 --title "fix: login crash (cherry-pick of #NNN)"
```

Before every tag, `tools/release/Assert-ReleaseFromMain.ps1` checks every commit after the stable tag: each must be on `main`, a `-x` cherry-pick of a commit on `main` that changes exactly the same lines, or a Dependabot update of the line that changes only dependency versions. Anything else (a fix written on the line, a pick without `-x`, a conflict resolved by hand, a squash of two cherry-picks) stops the run before a tag exists. If the cherry-pick conflicts, the resolution is code nobody reviewed: land a backport-specific fix on `main` that applies cleanly instead.

Cut Release, Cut Beta and Cut Hotfix must all be dispatched from `main`: they load the checker from their own commit, so a branch cannot ship an edited copy.

---

## Stacked PRs

For larger features, break the work into a stack of small focused PRs. Each PR targets the previous branch in the stack:

```bash
# Step 1 — targets main
git checkout -b feature/foo-step-1
gh pr create --base main --title "step 1: ..."

# Step 2 — stacked on step 1
git checkout -b feature/foo-step-2
gh pr create --base feature/foo-step-1 --title "step 2: ..."
```

When a bottom PR merges, retarget the next one: `gh pr edit <number> --base main`.

---

## Image Channels

| Tag | Published when | Who uses it |
|-----|---------------|-------------|
| `:latest` | A release tag: a new minor via Cut Release, or a patch release by the nightly stable route | Customers (default) |
| `:beta` | A pre-release of a new minor (`X.Y.0-*`): the nightly beta route, or Cut Beta by hand | Beta testers |
| `:edge` | Every PR merges to `main` | Developers and testers |
| `:5.2.0.0` | Same time as `:latest` — exact pinned version | Production deployments needing controlled upgrades |
| `:5.3.0-beta.1` | Every pre-release, including the release line's patch betas, which never move `:beta` | Testers who want a reproducible pre-release build |

See [Docker Setup](docker-setup.md) for how to select a channel via `IMAGE_TAG`.

---

## Repository Rulesets

Branch protection is configured via GitHub rulesets: the two below, plus *Protect release branches* for `release/**` (see [Maintaining a release line](../process/maintaining-a-release-line.md#why-the-ruleset-requires-the-checks-it-does)) and *Protect release tags*. If you ever need to recreate them (e.g. after transferring the repo), do so manually in **Settings → Rules → Rulesets**.

### Protect main

| Setting | Value |
|---------|-------|
| Target | `main` |
| Merge methods | Squash only |
| Required approvals | 1 + code owner review |
| Dismiss stale reviews | Yes |
| Required status checks | `PR Summary` (strict) |
| Code scanning | CodeQL — errors threshold, high/higher security alerts |
| Deletion | Blocked |
| Force push | Blocked |

**Bypass actors:**

| Actor | Type | Mode | Why |
|-------|------|------|-----|
| Fortigi CI bot | Integration | Always | Pushes automated version bump commits on PR merge |
| IdentityAtlas-Owners | Team | Pull request only | Allows team members to merge without a second approval |

### Protect gh-pages

| Setting | Value |
|---------|-------|
| Target | `gh-pages` |
| Deletion | Blocked |
| Force push | Blocked |

No bypass actors — `mike` (the docs versioning tool) only does regular fast-forward pushes and never needs to delete or force-push the branch.

# Branching and Versioning Strategy

This document covers branch naming, PR rules, version format, and the release workflow for contributors.

---

## Branch Model

| Branch | Purpose | PR required? | Approval required? |
|--------|---------|-------------|-------------------|
| `main` | Stable trunk. Never commit directly. | Yes | Yes (at least 1) |
| `feature/<name>` | All feature work. Created from `main`. Merged back to `main` via PR. | Yes | No |
| `bugfixes/<name>` | Bug fixes. Branch from `main` for pre-release fixes; branch from a **release tag** for hotfixes. | Yes (to `main`) | No |

**Rules:**

- `feature/` branches must be branched off `main`.
- `bugfixes/` branches branch from `main` for pre-release fixes. For hotfixes to an already-released version, branch from the release tag (e.g. `git checkout -b bugfixes/fix-foo v5.2.0`).
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

# Hotfix to a released version — branch from the release tag
git checkout -b bugfixes/<name> v5.2.0
```

---

## Version Number Format

Two version formats, both PowerShell-compatible (4-part):

| Context | Format | Example |
|---------|--------|---------|
| `main` dev builds | `Major.Minor.yyyyMMdd.HHmm` | `5.3.20260419.1430` |
| Release tags | `Major.Minor.Patch.0` | `5.2.1.0` |

**Who updates what:**

| Action | Who | When |
|--------|-----|------|
| `Minor` bump + timestamp | `bump-version.yml` GitHub Action | Automatically on every PR merge to `main` |
| Release version | `cut-release.yml` GitHub Action | When you run Actions → Cut Release |
| Hotfix version | `cut-hotfix.yml` GitHub Action | When you run Actions → Cut Hotfix |
| `Major` bump | Developer, via PR to `main` | Only for breaking changes |
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

## Cutting a Release

When `main` is stable and ready to ship to customers:

1. Go to **Actions → Cut Release → Run workflow**
2. Enter the version: `Major.Minor.Patch` (e.g. `5.2.0`)
3. The workflow creates tag `v5.2.0` on the current `main` HEAD
4. `docker-publish.yml` triggers automatically on the tag push and builds `:latest` + `:5.2.0.0`

Customers who track `:latest` will receive the new version automatically on their next `docker compose pull`.

---

## Hotfix Releases

To ship a bugfix without including features that are already on `main`:

```bash
# 1. Branch from the release tag, not from main
git checkout -b bugfixes/fix-login-crash v5.2.0

# 2. Fix the bug, commit
git add ...
git commit -m "fix: ..."

# 3. Push the branch
git push origin bugfixes/fix-login-crash
```

Then:

4. Go to **Actions → Cut Hotfix → Run workflow**
5. Enter the branch name (`bugfixes/fix-login-crash`) and new version (`5.2.1`)
6. The workflow creates tag `v5.2.1` on the HEAD of your branch
7. `docker-publish.yml` builds `:latest` + `:5.2.1.0`

After the hotfix ships, open a PR to cherry-pick the fix into `main`:

```bash
git checkout main && git pull
git cherry-pick <fix-commit-sha>
gh pr create --base main --title "fix: cherry-pick hotfix from v5.2.1"
```

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

| Tag | Content | Who uses it |
|-----|---------|-------------|
| `:latest` | Last stable release (from a `v*` tag) | End users (default) |
| `:edge` | Latest commit on `main` | Testers and developers |
| `:5.2.1.0` | Exact pinned version | Production deployments needing controlled upgrades |

See [Docker Setup](docker-setup.md) for how to select a channel via `IMAGE_TAG`.

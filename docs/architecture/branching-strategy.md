# Branching and Versioning Strategy

This document covers branch naming, PR rules, version format, and the changelog workflow for contributors.

---

## Branch Model

| Branch | Purpose | PR required? | Approval required? |
|--------|---------|-------------|-------------------|
| `main` | Stable trunk. Never commit directly. | Yes | Yes (at least 1) |
| `feature/<name>` | All feature work. Created from `main`. Merged back to `main` via PR. | Yes | No |
| `bugfixes/<name>` | Bug fixes. Created from `main`. Merged back to `main` via PR. | Yes | No |

**Rules:**

- `feature/` and `bugfixes/` branches must be branched off `main`.
- All merges to `main` go through a Pull Request — no direct pushes.
- Branch names: lowercase, hyphens. Examples: `feature/risk-score-export`, `bugfixes/fix-login-redirect`.
- **One issue per branch.** Each branch fixes exactly one issue or implements exactly one feature. Never combine unrelated fixes into a single branch or PR.

---

## Starting New Work

```bash
git checkout main && git pull
git checkout -b feature/<name>
# or
git checkout -b bugfixes/<name>
```

---

## Version Number Format

```
Major.Minor.yyyyMMdd.HHmm
```

Example: `5.2.20260420.1430`

| Part | Meaning |
|------|---------|
| `Major` | Incremented manually for breaking changes (via a PR to `main`) |
| `Minor` | Auto-incremented by CI on every PR merge to `main` |
| `yyyyMMdd.HHmm` | Timestamp of the merge, set by CI |

**Who updates what:**

| Action | Who | When |
|--------|-----|------|
| `Minor` bump + timestamp | `bump-version.yml` GitHub Action | Automatically on every PR merge to `main` |
| `Major` bump | Developer, via PR | Only for breaking changes |
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
4. After merge, `bump-version.yml` automatically increments `Minor`, updates the timestamp, and merges all `changes/*.md` fragments into `CHANGES.md`. The `docker-publish.yml` action then builds and pushes Docker images tagged with the new version.

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

The CI pipeline publishes Docker images on every merge to `main`:

| Tag | Content | Who uses it |
|-----|---------|-------------|
| `:latest` | Last stable release | End users (default) |
| `:edge` | Latest commit on `main` | Testers and developers |
| `:5.2.0.0` | Exact pinned version | Production deployments |

See [Docker Setup](docker-setup.md) for how to select a channel via `IMAGE_TAG`.

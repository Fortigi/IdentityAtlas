# Maintaining a release line

Customers on `:latest` run the newest stable minor, not `main`. Keeping their libraries current means updating the branch that minor's patch releases are cut from: its **release line**, `release/X.Y`.

There is **one** maintained line at a time, the newest stable minor's. Today that is **`release/6.1`**. When 6.2.0 is released, `release/6.2` takes over and 6.1 gets nothing more. The 5.x line (`release/5.9`) has ended.

The whole route, from Dependabot's PR to `:latest`, and the policy behind it are in [Release process](../contributing/release-process.md). This page covers the mechanics of the line itself.

```
v6.1.1 ──→ release/6.1 ──→ 6.1.2 ──→ 6.1.3 …     what customers run
                ↑
     Dependabot lands production updates here, daily; the nightly stable route releases them

main ─────────────────────────────────────────→  :edge, :beta, feature work
```

## What happens without anyone doing anything

1. **Dependabot** checks the manifests **on `release/6.1`** every day and opens one grouped PR per ecosystem for production dependencies that moved, patch and minor only.
2. **CI runs**: `pr.yml` and `pr-integration.yml` trigger on `release/**`.
3. **Auto-merge lands it** once the required checks are green (`.github/workflows/dependabot-auto-merge.yml`). The *Protect release branches* ruleset requires no approving review, so nothing waits on a person.
4. **The nightly stable route releases it**: a beta of the line's newest commit, the release test, and `6.1.(Z+1)` on `:latest` if it is green. The release notes name every dependency that moved, derived from the lockfiles.

These commits are not on `main`, and they are released anyway. That is the one exception to "main first", and `tools/release/Assert-ReleaseFromMain.ps1` checks it narrowly: Dependabot's, merged through a PR, only dependency versions. See [Release process → The Dependabot exception](../contributing/release-process.md#the-dependabot-exception).

## Two things about Dependabot that are easy to get wrong

**The config is read from the default branch.** `.github/dependabot.yml` on `main` is the only copy Dependabot ever reads. The release-line entries live there and *describe* work done on `release/6.1` via `target-branch`. Copying them onto the release branch does nothing.

**`target-branch` does not route security updates.** It is a version-updates-only option. Alert-driven security updates ignore it and are always raised against the default branch. GitHub's [Dependabot options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) says so under `target-branch`:

> Options defined for this `package-ecosystem` no longer apply to security
> updates because security updates always use the default branch for the
> repository.

This is why the release-line entries run **daily** instead of weekly. We cannot route security alerts to the branch, so we do not rely on them: a daily version check picks up the fixed release of a vulnerable package within a day by itself, with no cherry-pick and nobody watching an alert feed.

## What reaches the line, and what does not

| | On the release line |
|---|---|
| Production npm dependencies (`app/api`, `app/ui`), patch and minor | ✅ Daily, grouped |
| Container base images (`app/api`, `setup/docker`), patch and minor | ✅ Daily |
| Major versions of anything | ❌ Ignored: they arrive with the next minor |
| Dev dependencies: eslint, vitest, vite, playwright | ❌ Never |
| GitHub Actions versions | ❌ Never |
| Bug fixes from `main` | Only when cherry-picked, see below |

Dev dependencies are excluded by `allow: dependency-type: production`. This is not arbitrary noise-trimming: the API image is built with `npm ci --omit=dev` and the UI ships compiled `dist/`, so none of them is present in anything a customer runs. On `main` they are worth taking; on a stable line they are risk with no upside. Actions updates are excluded for the same reason: they change CI, not the product.

Majors are excluded with an `ignore` on `version-update:semver-major`, so Dependabot does not even open the PR. `dependabot-auto-merge.yml` would leave one for a person anyway, as a second line of defence.

## Getting a fix from `main` onto the line

Dependency updates arrive from upstream, so they need no porting. A *code* fix does, and it does not flow automatically. Fix it on `main` first, then open a PR into the line with a single `cherry-pick -x`:

```bash
git checkout -b bugfixes/fix-foo-on-6.1 origin/release/6.1
git cherry-pick -x <the merged commit on main>
gh pr create --base release/6.1 --title "fix: … (cherry-pick of #NNN)"
```

The PR needs no approval but must pass CI. Keep it to one cherry-pick: the squash merge must reproduce the main commit's exact lines, or the release check refuses it.

## Starting the next line

Cut Release does this when it cuts `X.Y.0`:

1. It creates `release/X.Y` from the `vX.Y.0` tag.
2. It opens a PR into `main` that moves every `target-branch` in `.github/dependabot.yml` to `release/X.Y` (`tools/release/Set-DependabotReleaseLine.ps1`). **Merge it the same day**: until then the new line gets no updates, and the nightly plan warns.
3. The previous line simply stops. Its branch stays as history; nothing deletes it.

The auto-merge workflow and the ruleset both match `release/**`, so nothing else is per-line.

## Why the ruleset requires the checks it does

The *Protect release branches* ruleset requires **no approving review**. That is what lets dependency updates land unattended, so its status checks are the only thing standing between a Dependabot PR and the branch `:latest` is cut from.

It must therefore require the real CI aggregates, `CI Passed` and `Integration CI Passed`. It must **not** rely on `PR Summary`, which is a stub job (`if: always()`, a bare `echo`) that exists only to overshadow a stuck check suite in the UI. It reports success even when CI has failed.

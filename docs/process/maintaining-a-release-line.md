# Maintaining a release line

Customers on `:latest` track a release tag, not `main`. Keeping their libraries
current therefore means updating the branch those tags are cut from — which is
what a *release line* is.

Today that line is **`release/5.9`**, branched from `v5.9.1`.

```
v5.9.1 ──→ release/5.9 ──→ 5.9.2 ──→ 5.9.3 …     what customers run
                ↑
     Dependabot lands production updates here, daily

main ─────────────────────────────────────────→  :edge, feature work
```

`main` is unaffected and keeps its own weekly Dependabot schedule. The two
never merge into one another; they are updated independently from upstream.

## What happens without anyone doing anything

1. **Dependabot** checks the manifests **on `release/5.9`** every day and opens
   one grouped PR per ecosystem for production dependencies that moved.
2. **CI runs** — `pr.yml` and `pr-integration.yml` already trigger on
   `release/**`.
3. **Auto-merge lands it** once the required checks are green
   (`.github/workflows/dependabot-auto-merge.yml`). The *Protect release
   branches* ruleset requires no approving review, so nothing waits on a person.
4. **You cut the patch release** when you want one: Actions → Cut Release, with
   `ref: release/5.9` and the next patch version. The release notes name every
   dependency that moved, derived from the lockfiles rather than the changelog.

Step 4 is the only manual step, and it is deliberate: publishing to `:latest`
puts a build in front of customers, which is a decision rather than a
consequence.

## Two things about Dependabot that are easy to get wrong

**The config is read from the default branch.** `.github/dependabot.yml` on
`main` is the only copy Dependabot ever reads. The release-line entries live
there and *describe* work done on `release/5.9` via `target-branch`. Copying
them onto the release branch does nothing.

**`target-branch` does not route security updates.** It is a version-updates-only
option. Alert-driven security updates ignore it and are always raised against
the default branch — GitHub's
[Dependabot options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
states it plainly under `target-branch`:

> Options defined for this `package-ecosystem` no longer apply to security
> updates because security updates always use the default branch for the
> repository.

This is why the release-line entries run **daily** instead of weekly. We cannot
route security alerts to the branch, so we do not rely on them: a daily version
check picks up the fixed release of a vulnerable package within a day by itself,
with no cherry-pick and nobody watching an alert feed.

## What reaches the line, and what does not

| | On the release line |
|---|---|
| Production npm dependencies (`app/api`, `app/ui`) | ✅ Daily, grouped |
| Container base images (`app/api`, `setup/docker`) | ✅ Daily |
| Dev dependencies — eslint, vitest, vite, playwright | ❌ Never |
| GitHub Actions versions | ❌ Never |
| Node major versions | ❌ Ignored, as on `main` |
| Features and fixes from `main` | ❌ Not automatically — see below |

Dev dependencies are excluded by `allow: dependency-type: production`. They are
not arbitrary noise-trimming: the API image is built with `npm ci --omit=dev`
and the UI ships compiled `dist/`, so none of them is present in anything a
customer runs. On `main` they are worth taking; on a stable line they are risk
with no upside.

Actions updates are excluded for the same reason — they change CI, not the
product.

## Patch and minor merge themselves; majors do not

A major version is the one update expected to break callers. On a line whose
purpose is not surprising anyone, taking one unattended is the wrong trade.
Majors still get a PR; it waits for a person, and the workflow comments on it
saying so. They are rare among production dependencies.

To change where that boundary sits, edit the `if:` on the auto-merge step in
`.github/workflows/dependabot-auto-merge.yml`.

## Getting a fix from `main` onto the line

Dependency updates arrive from upstream, so they need no porting. A *code* fix
does — and it does not flow automatically:

```bash
git checkout release/5.9 && git pull
git checkout -b bugfixes/fix-foo-on-5.9
git cherry-pick <sha-from-main>
gh pr create --base release/5.9 --title "fix: …"
```

The PR needs no approval but must pass CI. Fix on `main` first so the fix is not
lost when the next line is cut.

## Starting the next line

When you cut `5.10.0` and want to maintain it instead:

1. Create `release/5.10` from the `v5.10.0` tag.
2. Repoint the four `target-branch: "release/5.9"` entries in
   `.github/dependabot.yml` to `release/5.10`.
3. Decide what happens to `release/5.9` — supporting two lines doubles the
   surface. The current position is to support the latest line only.

Nothing else is per-line: the auto-merge workflow and the ruleset both match
`release/**`.

## Why the ruleset requires the checks it does

The *Protect release branches* ruleset requires **no approving review** — that
is what lets dependency updates land unattended — so its status checks are the
only thing standing between a Dependabot PR and the branch customers' releases
are cut from.

It must therefore require the real CI aggregates, `CI Passed` and
`Integration CI Passed`. It must **not** rely on `PR Summary`, which is a stub
job (`if: always()`, a bare `echo`) that exists only to overshadow a stuck check
suite in the UI — it reports success even when CI has failed.

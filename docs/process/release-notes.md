# How a release's notes are assembled

`cut-release.yml` and `cut-hotfix.yml` build the GitHub release body in five
steps. Knowing the order matters, because two of the steps can silently produce
nothing and two of them are deliberately placed where a model cannot touch them.

```
1. Pick the baseline          .github/scripts/release_prev_tag.sh
2. Collect the changelog      changes/*.md fragments, or a CHANGES.md slice
3. Polish the wording         Claude, via claude-code-action (best-effort)
4. Append the dependencies    tools/release-notes/dependency-delta.py
5. Append the download guide  tools/release-notes/portable-downloads.md
```

`cut-beta.yml` runs steps 2, 3 and 5 (its baseline is the latest tag of any
kind, and it has no dependency section).

Steps 1–3 describe what people changed. Step 4 describes what the *image*
changed, which is a different question and has a different source of truth.

---

## 1. The baseline

Everything else is relative to "the release this one follows", produced by
`.github/scripts/release_prev_tag.sh`:

> **The highest stable tag strictly below the version being cut.**

Pre-release tags (`beta`, `rc`, `alpha`) are never a baseline — a beta is a
snapshot on the way to the stable it precedes, so diffing against one would
report a subset of the work.

| Cutting | Tags that exist | Baseline | Why |
|---------|-----------------|----------|-----|
| `v5.10.1` | `v5.9.1 v5.10.0 v5.11.0` | `v5.10.0` | A patch on a maintained line follows its own line, not whatever main has since tagged |
| `v5.10.0` | `v5.9.0 v5.9.1` | `v5.9.1` | First of its series — falls back to the previous series |
| `v5.10.0` | `v5.9.1 v5.10.0-beta.2` | `v5.9.1` | The beta it supersedes is not a baseline |
| `v5.0.0` | *(none)* | *(empty)* | First release ever; notes ship without a comparison link |

Both cut workflows call the one script. They each used to compute this inline,
and disagreed — `cut-release` took the globally latest tag, which describes a
`5.10.1` patch as *removing* everything `5.11` added; `cut-hotfix` scoped to the
`v5.10.*` series, which finds nothing when the tag is first of its series and
silently drops the change list. Both failures are covered by
`test/ci-scripts/test-release-prev-tag.sh`, including wiring assertions that
fail if either workflow goes back to computing it inline.

## 2. The changelog

`cut-hotfix` reads the unmerged `changes/*.md` fragments on the branch, because
`bump-version.yml` has not folded them into `CHANGES.md` yet. `cut-release`
slices `CHANGES.md` down to the lines prepended since the baseline.

This is why [a changelog fragment is mandatory](../architecture/branching-strategy.md#changelog-fragments)
on every branch: a change with no fragment is invisible here.

## 3. Polishing

`claude-code-action` rewrites the bullets into user-facing language. The step is
`continue-on-error: true` on purpose — a rejected or unentitled model call must
never block a release, and the raw bullets are already valid notes. When it
fails the job logs a warning and ships the unpolished version.

The prompt is told to **drop CI, tooling and pure-implementation bullets with no
user-visible effect**. Keep that in mind when writing a fragment you want to
survive: describe the effect, not the mechanism.

## 4. Dependency updates

`tools/release-notes/dependency-delta.py` diffs the baseline against the tag
being cut and appends a **Dependency updates** section.

This exists because dependency changes cannot reach the notes any other way:

* The PR Hygiene gate's `CODE` pattern does not cover `package-lock.json`, so
  Dependabot PRs merge without a `changes/*.md` fragment — every one of them.
* Even a hand-written fragment about a library bump reads exactly like the
  "tooling with no user-visible effect" that step 3 is told to discard.

So a release made up only of library upgrades used to ship notes with nothing
under `## Changes` — the one release where an operator most needs to see which
version moved and which advisory it closes.

The section is appended **after** polishing. A model cannot drop or reword a
section it never sees, so the version list is exact.

### What it reports, and why the two apps differ

Only what reaches the published image. The API and the UI ship differently, so
they are filtered differently:

| Source | Scope | Reason |
|--------|-------|--------|
| `app/api/package-lock.json` | Full transitive production closure | `npm ci --omit=dev` installs all of it into the image, and a container scanner sees every package |
| `app/ui/package-lock.json` | Only packages declared in `app/ui/package.json` `dependencies` | The UI ships compiled `dist/`; its `node_modules` never reaches the image |
| `app/api/Dockerfile`, `setup/docker/Dockerfile.powershell` | Pinned base-image digests | The base image is most of what a scanner reports |

The UI rule is not cosmetic. `@tailwindcss/vite` sits in `dependencies`, so npm
marks the whole `@rolldown/binding-*` family production — around forty
per-platform bundler binaries that cannot appear in a browser bundle. Reporting
the raw closure buried `react` and `@azure/msal-browser` under them.

Each section caps at 30 bullets (`--max-per-section`, `0` disables) and defers
the tail to the SBOM. When nothing shipped changed the script prints nothing at
all, so an empty heading cannot appear.

### Running it by hand

```bash
python3 tools/release-notes/dependency-delta.py v5.9.1 main
python3 tools/release-notes/dependency-delta.py v5.9.1 main --max-per-section 0
```

Sample output:

```markdown
## Dependency updates

### API runtime

- `express-rate-limit` 8.5.2 → 8.7.0
- `multer` 2.2.0 → 2.4.0
- `pg` 8.22.0 → 8.23.0
- …and 19 more — see the SBOM attached to this release

### Frontend

- `@azure/msal-browser` 5.17.1 → 5.22.0
- `react` 19.2.7 → 19.3.0

### Container images

- `node:24-slim` (app/api) `unpinned` → `0e0ff40`
```

`unpinned` is not an error — it means that end of the range used a bare tag,
which is true of every base image before digest pinning landed.

## 5. The download guide

Every release attaches two portable Windows ZIPs, built by
`.github/scripts/build_portable_zips.sh`:

| Asset | What it is |
|-------|------------|
| `IdentityAtlas-portable.zip` | PGlite only; `node.exe` is its only executable and is code-signed |
| `IdentityAtlas-portable-postgres.zip` | Embeds PostgreSQL 16 for large data sets; run with `-Database Postgres`; the PostgreSQL binaries are not code-signed and need `VCRUNTIME140.dll` |

`tools/release-notes/portable-downloads.md` explains that choice to whoever
opens the release page. It is a static file appended **after** polishing, for
the same reason as the dependency section: the model is told to drop
packaging and tooling text, and this is the one piece of packaging text a
downloader needs. See
[Portable Windows Launcher](../architecture/desktop-portable.md#which-zip-to-download).

---

## Where releases can be cut from

Both `cut-release` and `cut-beta` take a **`ref` input** (branch, tag or commit;
default `main`), and `cut-hotfix` takes a **branch name**. Nothing in the
tooling requires a release to come from `main` HEAD — a release can be cut from
a branch whose content was fixed at an earlier point.

That capability is unused today. Whether to adopt it — a maintained
`release/5.N` line with its own dependency updates and patch releases, versus
releasing from `main` on a cadence — is an open policy question, not something
this tooling decides. The notes machinery is correct either way: the baseline
rule above was written specifically so a patch cut from a maintained line is
described against its own line.

## Testing

| Suite | Covers |
|-------|--------|
| `test/ci-scripts/test-release-prev-tag.sh` | Baseline selection, version ordering, pre-release exclusion, workflow wiring |
| `tools/release-notes/test_dependency_delta.py` | Lockfile parsing, dev/production filtering, the UI manifest restriction, Dockerfile digests, rendering, truncation |
| `app/desktop/portableReleaseAssets.guard.test.js` | All three cut workflows attach both portable ZIPs, the build order that keeps both, and the download guide's placement after polishing |

The first two run in the `ci-scripts` job of `pr.yml`; the guard runs in the
API Vitest suite. They are worth having precisely
because nothing else exercises this code until a release is already being cut,
and a release is a bad place to discover that the notes generator throws.

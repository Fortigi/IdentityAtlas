#!/usr/bin/env python3
"""Render the "Dependency updates" section of a release's notes.

Dependency changes never reach release-notes.md through the normal changelog
path, for two independent reasons:

  * The PR Hygiene gate's CODE pattern (.github/workflows/pr.yml) covers
    app/api/src/**.js, **.sql, app/**.mjs, app/ui/src/**.{js,jsx} and
    tools|setup/docker/**.ps1 — but NOT package-lock.json. A Dependabot PR is
    therefore free to merge without a changes/*.md fragment, and every one of
    them does.
  * The "Synthesize release notes with Claude" step is explicitly told to drop
    tooling bullets with no user-visible effect, which is exactly how a library
    bump reads.

So a library-only patch release would ship notes with nothing underneath
"## Changes" — precisely the release where an operator most needs to see which
version moved and which advisory it closed. This derives the section from the
lockfiles and Dockerfiles instead, so it depends on neither bot behaviour nor a
human remembering a fragment.

Only what actually ships is reported. app/api/Dockerfile installs the API with
`npm ci --omit=dev` and copies only app/ui/dist, so dev-only packages are
absent from the image and are filtered out here — that is the difference
between a section an operator reads and forty lines of eslint churn.

Run from the repo root:
    python3 tools/release-notes/dependency-delta.py <previous-ref> <current-ref>

Prints nothing (and exits 0) when nothing shipped changed, so the caller can
append the output unconditionally without risking an empty heading.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent

# What to diff, and how far down each tree to look.
#
# The API and the UI need different rules because they ship differently:
#
#   * The API is installed into the image with `npm ci --omit=dev`, so its
#     whole transitive production closure lands on disk and a container scanner
#     sees every package in it. `manifest: None` means report all of it.
#   * The UI ships as compiled `dist/` output — its node_modules never reaches
#     the image at all. Its transitive closure is therefore a bad proxy for
#     "what ships": `@tailwindcss/vite` sits in `dependencies`, so npm marks
#     the whole `@rolldown/binding-*` family production, and 40-odd per-platform
#     bundler binaries that cannot appear in a browser bundle drown out react
#     and msal-browser. Naming a manifest restricts the section to the packages
#     declared in its `dependencies` — the ones whose code can actually be
#     bundled.
LOCKFILES = [
    {
        "lock": "app/api/package-lock.json",
        "manifest": None,
        "heading": "API runtime",
    },
    {
        "lock": "app/ui/package-lock.json",
        "manifest": "app/ui/package.json",
        "heading": "Frontend",
    },
]

# Dockerfiles whose FROM lines pin a base image that ships.
DOCKERFILES = [
    ("app/api/Dockerfile", "app/api"),
    ("setup/docker/Dockerfile.powershell", "worker"),
]

# `FROM node:24-slim@sha256:0e0ff40... AS frontend-build`
FROM_RE = re.compile(
    r"^\s*FROM\s+(?P<image>[^\s@]+)"
    r"(?:@(?P<digest>sha256:[0-9a-f]{64}))?"
    r"(?:\s+AS\s+\S+)?\s*$",
    re.IGNORECASE | re.MULTILINE,
)

DEFAULT_MAX_PER_SECTION = 30


# ── git plumbing ─────────────────────────────────────────────────────────────

def git_show(ref, path):
    """Contents of `path` at `ref`, or None when it does not exist there.

    A file that is absent at one end of the range is normal (a lockfile added
    or removed between releases), so a failure here is data, not an error.
    """
    try:
        out = subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            cwd=REPO,
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.decode("utf-8", errors="replace")


# ── lockfile parsing ─────────────────────────────────────────────────────────

def package_name(path):
    """'node_modules/a/node_modules/@scope/b' -> '@scope/b'."""
    marker = "node_modules/"
    idx = path.rfind(marker)
    if idx < 0:
        return None
    name = path[idx + len(marker):]
    return name or None


def lock_packages(lock_text):
    """The lockfile's `packages` map, or {} for anything unusable.

    Every rejection here is a real shape seen in the wild rather than defensive
    padding: an absent file (`git show` on a ref that predates it), a valid JSON
    document that is not an object, and lockfileVersion 1, which has no
    `packages` map at all. The repo is on npm 11 (lockfileVersion 3); rather
    than guess at the v1 tree shape, report nothing and let the changelog carry
    that release.
    """
    if not lock_text:
        return {}
    try:
        data = json.loads(lock_text)
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    packages = data.get("packages")
    return packages if isinstance(packages, dict) else {}


def shipped_entry(path, meta):
    """(name, version, depth) for one lockfile entry, or None to skip it.

    Skipped: the project itself (the "" key), workspace links and anything
    without a version (neither carries a version that ships), and `dev: true`
    — npm sets that only when an entry is reachable *exclusively* through
    devDependencies, so dropping those leaves exactly the production closure.
    """
    if not path or not isinstance(meta, dict):
        return None
    if meta.get("dev") or meta.get("link"):
        return None
    version = meta.get("version")
    if not version:
        return None
    name = package_name(path)
    if not name:
        return None
    return name, version, path.count("node_modules/")


def production_versions(lock_text):
    """name -> resolved version, for packages that survive `npm ci --omit=dev`.

    A package resolved at several depths (npm's dedupe fallback) is reported at
    its shallowest path, which is the copy most consumers load.
    """
    best = {}
    for path, meta in lock_packages(lock_text).items():
        entry = shipped_entry(path, meta)
        if entry is None:
            continue
        name, version, depth = entry
        if name not in best or depth < best[name][1]:
            best[name] = (version, depth)
    return {name: version for name, (version, _) in best.items()}


def declared_dependencies(manifest_text):
    """Names in a package.json's `dependencies` — devDependencies excluded."""
    if not manifest_text:
        return set()
    try:
        data = json.loads(manifest_text)
    except (ValueError, TypeError):
        return set()
    if not isinstance(data, dict):
        return set()
    deps = data.get("dependencies")
    if not isinstance(deps, dict):
        return set()
    return set(deps)


def restrict(versions, names):
    """Keep only `names` — used where the transitive closure isn't what ships."""
    return {name: version for name, version in versions.items() if name in names}


def diff_versions(old, new):
    """(added, updated, removed) — updated holds (name, old, new) triples.

    A package present at both ends on the same version appears in none of the
    three: an unchanged dependency is not news.
    """
    added = sorted(name for name in new if name not in old)
    removed = sorted(name for name in old if name not in new)
    updated = sorted(
        (name, old[name], new[name])
        for name in new
        if name in old and old[name] != new[name]
    )
    return added, updated, removed


# ── Dockerfile parsing ───────────────────────────────────────────────────────

def base_images(dockerfile_text):
    """image reference -> pinned digest (or None when the tag is unpinned).

    A multi-stage build names the same image once per stage; they collapse to a
    single entry because they are the same pin.
    """
    if not dockerfile_text:
        return {}
    found = {}
    for match in FROM_RE.finditer(dockerfile_text):
        image = match.group("image")
        if image.lower() == "scratch":
            continue
        found[image] = match.group("digest")
    return found


def short_digest(digest):
    """sha256:0e0ff40c… -> 0e0ff40 — what the Dependabot PR titles show."""
    if not digest:
        return "unpinned"
    return digest.split(":", 1)[-1][:7]


# ── rendering ────────────────────────────────────────────────────────────────

def render_package_bullets(added, updated, removed, max_items):
    """Bullets for one lockfile, newest information first.

    Updated leads because a version move is what an advisory closes; added and
    removed follow. Returns [] when nothing changed, so the caller can drop the
    heading entirely.
    """
    bullets = []
    for name, old_version, new_version in updated:
        bullets.append(f"- `{name}` {old_version} → {new_version}")
    for name in added:
        bullets.append(f"- `{name}` added")
    for name in removed:
        bullets.append(f"- `{name}` removed")

    if max_items and len(bullets) > max_items:
        hidden = len(bullets) - max_items
        bullets = bullets[:max_items]
        bullets.append(
            f"- …and {hidden} more — see the SBOM attached to this release"
        )
    return bullets


def render(sections, image_bullets):
    """Assemble the whole section, or '' when there is nothing to report."""
    body = []
    for heading, bullets in sections:
        if bullets:
            body.append(f"### {heading}\n")
            body.extend(bullets)
            body.append("")
    if image_bullets:
        body.append("### Container images\n")
        body.extend(image_bullets)
        body.append("")

    if not body:
        return ""
    return "\n## Dependency updates\n\n" + "\n".join(body).rstrip() + "\n"


def collect(previous_ref, current_ref, max_items):
    """Diff every shipped dependency source between two refs."""
    sections = []
    for source in LOCKFILES:
        old = production_versions(git_show(previous_ref, source["lock"]))
        new = production_versions(git_show(current_ref, source["lock"]))

        if source["manifest"]:
            # Union of both ends, so a dependency added or dropped between the
            # two releases is still reported rather than silently filtered out.
            names = (
                declared_dependencies(git_show(previous_ref, source["manifest"]))
                | declared_dependencies(git_show(current_ref, source["manifest"]))
            )
            old, new = restrict(old, names), restrict(new, names)

        if not old and not new:
            continue
        added, updated, removed = diff_versions(old, new)
        sections.append(
            (source["heading"],
             render_package_bullets(added, updated, removed, max_items))
        )

    image_bullets = []
    for path, label in DOCKERFILES:
        old = base_images(git_show(previous_ref, path))
        new = base_images(git_show(current_ref, path))
        for image in sorted(new):
            if image in old and old[image] != new[image]:
                image_bullets.append(
                    f"- `{image}` ({label}) "
                    f"`{short_digest(old[image])}` → `{short_digest(new[image])}`"
                )
            elif image not in old:
                image_bullets.append(
                    f"- `{image}` ({label}) added, pinned to "
                    f"`{short_digest(new[image])}`"
                )

    return render(sections, image_bullets)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Render the dependency-update section of a release's notes."
    )
    parser.add_argument("previous_ref", help="Tag/commit the release follows")
    parser.add_argument("current_ref", help="Tag/commit being released")
    parser.add_argument(
        "--max-per-section",
        type=int,
        default=DEFAULT_MAX_PER_SECTION,
        help="Truncate each section to N bullets (0 = no limit). "
             f"Default {DEFAULT_MAX_PER_SECTION}.",
    )
    args = parser.parse_args(argv)

    # The bullets carry "→" and "…". CI runs on ubuntu-latest where stdout is
    # already UTF-8, but a maintainer previewing a release on Windows gets
    # cp1252 and a UnicodeEncodeError instead of notes. Force the encoding that
    # the markdown needs rather than degrading the output for everyone.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    # No previous tag means a first release in its series: there is nothing to
    # diff against, and an empty section is better than a fabricated one.
    if not args.previous_ref:
        return 0

    sys.stdout.write(
        collect(args.previous_ref, args.current_ref, args.max_per_section)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

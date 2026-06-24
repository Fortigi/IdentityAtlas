#!/usr/bin/env python3
"""Refresh the dependency versions in docs/reference/sbom.md.

The SBOM page is hand-curated: its sections, package selection, purpose text
and license columns are all maintained by humans. The only thing that goes
stale is the **Version** column, which must track the declared versions in the
npm manifests. This script rewrites just that column in place, leaving every
heading, row order, purpose and license untouched.

Scope: only the npm dependency tables under the "API Backend (Node.js)" and
"Frontend (React)" sections are touched. Infrastructure, Docker image, External
API and PowerShell sections are left fully curated.

Run from the repo root:  python3 tools/update-sbom-doc.py
Exits 0 whether or not anything changed.
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DOC = REPO / "docs" / "reference" / "sbom.md"
API_PKG = REPO / "app" / "api" / "package.json"
UI_PKG = REPO / "app" / "ui" / "package.json"


def load_versions(pkg_path):
    """name -> declared version string, merging deps + devDeps."""
    data = json.loads(pkg_path.read_text())
    versions = {}
    versions.update(data.get("dependencies", {}))
    versions.update(data.get("devDependencies", {}))
    return versions


def section_map(header, api, ui):
    """Pick the manifest that backs the current H2 section, or None."""
    if "API Backend" in header:
        return api
    if "Frontend" in header:
        return ui
    return None


def main():
    api = load_versions(API_PKG)
    ui = load_versions(UI_PKG)

    lines = DOC.read_text().splitlines()
    active = None
    changed = []
    missing = []

    for i, line in enumerate(lines):
        # H2 headers switch which manifest backs the tables below them.
        if line.startswith("## "):
            active = section_map(line, api, ui)
            continue

        # Only touch markdown table rows while inside a versioned section.
        if active is None or not line.startswith("|"):
            continue

        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue

        name = cells[0]
        # Skip header / separator rows and rows for packages we don't track.
        if name in ("Package", "") or set(cells[1]) <= {"-", " "}:
            continue
        if name not in active:
            missing.append(name)
            continue

        new_version = active[name]
        if cells[1] != new_version:
            changed.append(f"{name}: {cells[1]} -> {new_version}")
            cells[1] = new_version
            lines[i] = "| " + " | ".join(cells) + " |"

    if changed:
        DOC.write_text("\n".join(lines) + "\n")
        print(f"Updated {len(changed)} version(s) in {DOC.relative_to(REPO)}:")
        for c in changed:
            print(f"  {c}")
    else:
        print("SBOM doc already in sync — no version changes")

    if missing:
        # Not fatal: a listed package may be intentionally curated or renamed.
        print(f"Note: {len(missing)} table row(s) had no matching manifest "
              f"entry and were left as-is: {', '.join(sorted(set(missing)))}",
              file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())

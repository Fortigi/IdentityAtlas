#!/usr/bin/env python3
"""Refresh the dependency / infrastructure versions in docs/reference/sbom.md.

The SBOM page is hand-curated: its sections, package selection, purpose text
and license columns are all maintained by humans. What goes stale is version
data, which must track the real sources of truth. This script rewrites just the
version cells in place, leaving every heading, row order, purpose and license
untouched.

Sources of truth, by section:
  * "API Backend (Node.js)" / "Frontend (React)" — Version column from the npm
    manifests (app/api/package.json, app/ui/package.json).
  * "Documentation Toolchain (Python)" — Version column from the pinned pip
    manifest (docs/requirements.txt).
  * "Infrastructure Components" — Version column from the Docker base images and
    compose file (Postgres, PowerShell, Node).
  * "Docker Images" — Base column from the Dockerfiles.
External API and PowerShell-module sections are left fully curated.

Run from the repo root:  python3 tools/update-sbom-doc.py
Exits 0 whether or not anything changed.
"""
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DOC = REPO / "docs" / "reference" / "sbom.md"
API_PKG = REPO / "app" / "api" / "package.json"
UI_PKG = REPO / "app" / "ui" / "package.json"
DOCS_REQ = REPO / "docs" / "requirements.txt"
API_DOCKERFILE = REPO / "app" / "api" / "Dockerfile"
PWSH_DOCKERFILE = REPO / "setup" / "docker" / "Dockerfile.powershell"
COMPOSE = REPO / "docker-compose.yml"


def load_versions(pkg_path):
    """name -> declared version string, merging deps + devDeps."""
    data = json.loads(pkg_path.read_text())
    versions = {}
    versions.update(data.get("dependencies", {}))
    versions.update(data.get("devDependencies", {}))
    return versions


def load_pip_versions(req_path):
    """name -> pinned version from a pip requirements file (``name==version``)."""
    versions = {}
    if not req_path.exists():
        return versions
    for raw in req_path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if "==" not in line:
            continue
        name, _, ver = line.partition("==")
        versions[name.strip()] = ver.strip()
    return versions


def node_runtime_ref():
    """Final runtime node image, e.g. 'node:24-slim'."""
    text = API_DOCKERFILE.read_text()
    m = re.search(r"^FROM\s+(\S+)\s+AS\s+runtime", text, re.MULTILINE | re.IGNORECASE)
    if not m:
        m = re.search(r"^FROM\s+(node:\S+)", text, re.MULTILINE | re.IGNORECASE)
    return m.group(1) if m else None


def powershell_ref():
    """Worker base image, e.g. 'mcr.microsoft.com/powershell:7.5-ubuntu-24.04'."""
    m = re.search(r"^FROM\s+(\S+)", PWSH_DOCKERFILE.read_text(),
                  re.MULTILINE | re.IGNORECASE)
    return m.group(1) if m else None


def postgres_tag():
    """Postgres image tag from compose, e.g. '16-alpine'."""
    m = re.search(r"image:\s*postgres:(\S+)", COMPOSE.read_text())
    return m.group(1) if m else None


def build_infra():
    """Return (component_versions, image_bases) maps derived from Docker config."""
    node_ref = node_runtime_ref()          # node:24-slim
    pwsh_ref = powershell_ref()            # mcr.../powershell:7.5-ubuntu-24.04
    pg_tag = postgres_tag()                # 16-alpine

    components = {}                        # Infrastructure Components: Version cell
    if pg_tag:
        components["PostgreSQL"] = pg_tag
    if pwsh_ref:
        # tag '7.5-ubuntu-24.04' -> '7.5 (ubuntu-24.04)'
        tag = pwsh_ref.split(":", 1)[1]
        ver, _, os_ = tag.partition("-")
        components["PowerShell"] = f"{ver} ({os_})" if os_ else ver
    if node_ref:
        components["Node.js"] = node_ref.split(":", 1)[1]  # 24-slim

    images = {}                            # Docker Images: Base cell, keyed by substring
    if node_ref:
        images["web"] = node_ref
    if pwsh_ref:
        images["worker"] = pwsh_ref
    return components, images


def update_npm_row(cells, npm_map, missing):
    name = cells[0]
    if name not in npm_map:
        missing.append(name)
        return None
    return npm_map[name]


def update_infra_component(cells, components):
    return components.get(cells[0])


def update_docker_image(cells, images):
    # Image name lives in col0 (may be backtick-wrapped); Base lives in col1.
    name = cells[0]
    if "worker" in name:
        return images.get("worker")
    if "identity-atlas" in name:
        return images.get("web")
    return None


def parse_data_row(line):
    """Return trimmed cells for a data row, or None for non-rows/headers/separators."""
    if not line.startswith("|"):
        return None
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if len(cells) < 2:
        return None
    # Skip header / separator rows.
    if cells[0] in ("Package", "Component", "Image", "") or \
            set(cells[1]) <= {"-", " "}:
        return None
    return cells


def dispatch_new_value(section, cells, sources, missing):
    """Route a row to its source of truth; return the new col1 value or None."""
    api, ui, docs, components, images = sources
    if section and "API Backend" in section:
        return update_npm_row(cells, api, missing)
    if section and "Frontend" in section:
        return update_npm_row(cells, ui, missing)
    if section and "Documentation Toolchain" in section:
        return update_npm_row(cells, docs, missing)
    if section == "Infrastructure Components":
        return update_infra_component(cells, components)
    if section == "Docker Images":
        return update_docker_image(cells, images)
    return None


def apply_updates(lines, sources, missing):
    """Rewrite version/base cells in place; return the list of change descriptions."""
    section = None
    changed = []
    for i, line in enumerate(lines):
        if line.startswith("## "):
            section = line.lstrip("# ").strip()
            continue

        cells = parse_data_row(line)
        if cells is None:
            continue

        new_value = dispatch_new_value(section, cells, sources, missing)
        if new_value and cells[1] != new_value:
            changed.append(f"{cells[0]}: {cells[1]} -> {new_value}")
            cells[1] = new_value
            lines[i] = "| " + " | ".join(cells) + " |"
    return changed


def main():
    api = load_versions(API_PKG)
    ui = load_versions(UI_PKG)
    docs = load_pip_versions(DOCS_REQ)
    components, images = build_infra()
    sources = (api, ui, docs, components, images)

    lines = DOC.read_text().splitlines()
    missing = []
    changed = apply_updates(lines, sources, missing)

    if changed:
        DOC.write_text("\n".join(lines) + "\n")
        print(f"Updated {len(changed)} version(s) in {DOC.relative_to(REPO)}:")
        for c in changed:
            print(f"  {c}")
    else:
        print("SBOM doc already in sync — no version changes")

    if missing:
        # Not fatal: a listed package may be intentionally curated or renamed.
        print(f"Note: {len(missing)} dependency row(s) had no matching manifest "
              f"entry and were left as-is: {', '.join(sorted(set(missing)))}",
              file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())

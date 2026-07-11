#!/usr/bin/env python3
"""Node-version consistency gate — .nvmrc is the single source of truth.

The repo pins Node in several places that can drift independently: every
`node-version:` in .github/workflows/*, every `FROM node:<v>` in a Dockerfile,
and every `engines.node` in a package.json. Nothing kept them in sync, so one
file could silently revert to an older major (e.g. 22) undetected.

This gate reads the major version from `.nvmrc` and fails if ANY of those
references declares a different major. It does not require a file to mention
Node — only that, when it does, the major matches .nvmrc.

Usage:
  python tools/node-version/ratchet.py     # check (CI)

Mirrors the other ratchets (tools/filesize/ratchet.py, tools/complexity/ratchet.py):
pure logic in `evaluate()` is unit-tested in test_ratchet.py before it gates.
"""
import json
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NVMRC = os.path.join(REPO, ".nvmrc")
EXCLUDE = ("node_modules/", "/dist", "bundled-scripts/", "coverage/", "docs/coverage")

# `node-version: '24'` / `node-version: "24"` / `node-version: 24` — but NOT
# `node-version-file:` (which points AT .nvmrc and needs no literal check).
_WF_RE = re.compile(r"node-version:\s*['\"]?v?(\d+)")
# `FROM node:24-slim`, `FROM node:24.1.0 AS build`, `--from=node:24 …`
_DOCKER_RE = re.compile(r"\bnode:v?(\d+)")
# `const NODE_VERSION = '24.16.0'` — a build/launcher .mjs pins the exact Node
# runtime it bundles (e.g. app/desktop/scripts/build-node-launcher.mjs, which
# also carries a matching ABI + SHA). Only the major is gated against .nvmrc.
_MJS_RE = re.compile(r"NODE_VERSION\s*=\s*['\"]v?(\d+)")


def parse_expected(nvmrc_text):
    """Major version declared by .nvmrc (e.g. '24\\n' -> 24, 'v24.1' -> 24)."""
    m = re.search(r"v?(\d+)", nvmrc_text)
    if not m:
        raise ValueError(".nvmrc has no version number")
    return int(m.group(1))


def _first_major(spec):
    """Leading major from an engines-style spec ('>=24', '^24.1.0', '24.x') -> 24."""
    m = re.search(r"(\d+)", spec or "")
    return int(m.group(1)) if m else None


def scan_workflow(text):
    return [(m.start(), int(m.group(1))) for m in _WF_RE.finditer(text)]


def scan_dockerfile(text):
    return [(m.start(), int(m.group(1))) for m in _DOCKER_RE.finditer(text)]


def scan_mjs(text):
    return [(m.start(), int(m.group(1))) for m in _MJS_RE.finditer(text)]


def scan_package_json(text):
    try:
        node = json.loads(text).get("engines", {}).get("node")
    except (ValueError, AttributeError):
        return []
    major = _first_major(node)
    return [] if major is None else [(0, major)]


def _kind(path):
    base = os.path.basename(path)
    if path.startswith(".github/workflows/") and path.endswith((".yml", ".yaml")):
        return scan_workflow
    if base == "Dockerfile" or base.startswith("Dockerfile") or base.endswith(".Dockerfile"):
        return scan_dockerfile
    if base == "package.json":
        return scan_package_json
    if path.endswith(".ps1"):
        # CI/helper PowerShell scripts pin Node via `docker run ... node:<v>-slim`
        # (e.g. test/nightly/Run-NightlyLocal.ps1). Same image-ref pattern as a
        # Dockerfile, so reuse the Dockerfile scanner.
        return scan_dockerfile
    if path.endswith(".mjs"):
        # Build/launcher scripts pin the bundled Node via `const NODE_VERSION`.
        return scan_mjs
    return None


def evaluate(expected, findings):
    """Pure gate logic. `findings` = list of (path, major). Returns violations."""
    fails = []
    for path, major in findings:
        if major != expected:
            fails.append(f"{path}: declares Node {major}, but .nvmrc pins {expected}. "
                         f"Align it with .nvmrc (the single source of truth).")
    return fails


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=REPO,
                         capture_output=True, text=True, check=True).stdout
    for p in out.split("\0"):
        if p and not any(x in p for x in EXCLUDE):
            yield p


def collect_findings():
    findings = []
    for path in tracked_files():
        scan = _kind(path)
        if not scan:
            continue
        with open(os.path.join(REPO, path), encoding="utf-8") as f:
            text = f.read()
        for _pos, major in scan(text):
            findings.append((path, major))
    return findings


def main():
    with open(NVMRC, encoding="utf-8") as f:
        expected = parse_expected(f.read())

    findings = collect_findings()
    fails = evaluate(expected, findings)
    print(f"[node-version] .nvmrc pins Node {expected}; checked {len(findings)} reference(s).")
    if fails:
        print(f"Node-version gate FAILED: {len(fails)} reference(s) disagree with .nvmrc.")
        for msg in fails:
            print(f"::error::Node-version gate: {msg}")
        return 1
    print("Node-version gate OK - every reference matches .nvmrc.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

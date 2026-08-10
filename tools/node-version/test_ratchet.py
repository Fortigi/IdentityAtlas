"""Unit tests for the node-version gate's pure logic.

Run: python -m pytest tools/node-version/test_ratchet.py   (or: python tools/node-version/test_ratchet.py)
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ratchet import (  # noqa: E402
    REPO, parse_expected, scan_workflow, scan_dockerfile, scan_package_json, scan_mjs,
    evaluate, tracked_files,
)


def test_parse_expected_variants():
    assert parse_expected("24\n") == 24
    assert parse_expected("v24") == 24
    assert parse_expected("24.1.0\n") == 24


def test_scan_workflow_matches_quoted_and_bare():
    text = "      node-version: '24'\n      node-version: 24\n      node-version: \"24\"\n"
    assert [v for _, v in scan_workflow(text)] == [24, 24, 24]


def test_scan_workflow_ignores_node_version_file():
    # node-version-file points AT .nvmrc and must NOT be read as a literal.
    assert scan_workflow("      node-version-file: .nvmrc\n") == []


def test_scan_dockerfile_matches_tags_and_stages():
    text = "FROM node:24-slim AS build\nFROM node:24.1.0-slim AS runtime\n"
    assert [v for _, v in scan_dockerfile(text)] == [24, 24]


def test_scan_dockerfile_matches_docker_run_refs_in_scripts():
    # .ps1 CI/helper scripts pin Node via `docker run ... node:<v>-slim`; the same
    # scanner is applied to .ps1 files so a stale pin (node:20) is caught.
    text = '$null = & docker run --rm -w /work node:20-slim sh -c "npm ci"\n'
    assert [v for _, v in scan_dockerfile(text)] == [20]


def test_scan_package_json_extracts_engines_major():
    assert [v for _, v in scan_package_json('{"engines":{"node":">=24"}}')] == [24]
    assert [v for _, v in scan_package_json('{"engines":{"node":"24.x"}}')] == [24]


def test_scan_package_json_without_engines_is_empty():
    assert scan_package_json('{"name":"x"}') == []
    assert scan_package_json('not json') == []


def test_scan_mjs_extracts_node_version_major():
    # A launcher .mjs pins the bundled runtime as `const NODE_VERSION = '24.16.0'`;
    # only the major (24) is gated against .nvmrc.
    text = "const NODE_VERSION   = '24.16.0';\nconst NODE_ABI = '137';\n"
    assert [v for _, v in scan_mjs(text)] == [24]


def test_scan_mjs_matches_double_quotes_and_v_prefix():
    assert [v for _, v in scan_mjs('const NODE_VERSION = "v22.1.0"')] == [22]


def test_scan_mjs_without_pin_is_empty():
    # An .mjs that doesn't pin a Node version contributes no finding.
    assert scan_mjs("import { join } from 'node:path';\nconst X = 1;\n") == []


def test_evaluate_flags_mismatch_only():
    findings = [
        (".github/workflows/pr.yml", 24),
        ("app/api/Dockerfile", 22),        # wrong
        ("app/ui/package.json", 24),
        (".github/workflows/old.yml", 20), # wrong
    ]
    fails = evaluate(expected=24, findings=findings)
    assert len(fails) == 2
    assert any("Dockerfile" in f and "Node 22" in f for f in fails)
    assert any("old.yml" in f and "Node 20" in f for f in fails)


def test_evaluate_all_match_passes():
    findings = [("a", 24), ("b", 24)]
    assert evaluate(24, findings) == []


def _dependabot_text():
    """.github/dependabot.yml, as raw text.

    Parsed with regexes rather than PyYAML so these tests need no dependency
    beyond pytest (the gate workflow installs nothing else).
    """
    with open(os.path.join(REPO, ".github", "dependabot.yml"), encoding="utf-8") as f:
        return f.read()


def _node_ignore_entries():
    """Every `- dependency-name: "node"` ignore entry, as raw text blocks."""
    # An entry runs to the next list item at the same indent, a blank line, or EOF.
    entries = re.findall(
        r'-\s*dependency-name:\s*"node".*?(?=\n\s*-\s*dependency-name:|\n\s*\n|\Z)',
        _dependabot_text(), re.S)
    assert entries, 'no `dependency-name: "node"` ignore entry in .github/dependabot.yml'
    return entries


def _docker_directories():
    """The `directory:` of every docker-ecosystem update block."""
    blocks = re.findall(
        r'-\s*package-ecosystem:\s*"docker".*?(?=\n\s*-\s*package-ecosystem:|\Z)',
        _dependabot_text(), re.S)
    return {m.group(1) for b in blocks for m in [re.search(r'directory:\s*"([^"]+)"', b)] if m}


def test_dependabot_suppresses_node_major_bumps():
    # Dependabot bumps one Dockerfile at a time, so a Node MAJOR bump can never
    # satisfy this gate (it leaves .nvmrc, the other Dockerfile and the nightly
    # runner behind). Every node ignore must suppress those PRs by update TYPE.
    entries = _node_ignore_entries()
    assert all("version-update:semver-major" in e for e in entries), entries


def test_dependabot_does_not_enumerate_node_majors():
    # Enumerating majors (`versions: ["26.*", ">= 27"]`) is what let Node 25
    # through and produced PR #951 — every new major needs remembering. Keep
    # the ignores bounded by update-type so they cannot develop holes.
    entries = _node_ignore_entries()
    assert not any("versions:" in e for e in entries), entries


def test_dependabot_watches_every_node_pinning_dockerfile():
    # Suppressing majors must not mean ignoring a Dockerfile entirely: each one
    # that pins a Node base image needs a docker entry so it still receives
    # security/patch bumps. app/ui/Dockerfile had none and was invisible.
    watched = _docker_directories()
    for path in tracked_files():
        base = os.path.basename(path)
        if not (base == "Dockerfile" or base.startswith("Dockerfile")
                or base.endswith(".Dockerfile")):
            continue
        with open(os.path.join(REPO, path), encoding="utf-8") as f:
            if not scan_dockerfile(f.read()):
                continue                      # no `node:` pin — nothing to watch
        directory = "/" + os.path.dirname(path)
        assert directory in watched, (
            f"{path} pins a Node base image but no docker Dependabot entry watches "
            f"{directory}, so its base image would never get a security bump. "
            f"Add a docker update block for {directory} to .github/dependabot.yml.")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")

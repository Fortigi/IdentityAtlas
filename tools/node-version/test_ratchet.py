"""Unit tests for the node-version gate's pure logic.

Run: python -m pytest tools/node-version/test_ratchet.py   (or: python tools/node-version/test_ratchet.py)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ratchet import (  # noqa: E402
    parse_expected, scan_workflow, scan_dockerfile, scan_package_json, scan_mjs, evaluate,
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


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")

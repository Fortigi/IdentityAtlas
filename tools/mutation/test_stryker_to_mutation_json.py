"""Unit tests for tools/mutation/stryker_to_mutation_json.py.

The script publishes a number to the coverage docs page, so the tests here are
chosen to discriminate rather than to execute: every status fixture uses a
DIFFERENT count per bucket, so a mapping that swaps two statuses (or drops one
from the denominator) produces a different score and fails, instead of landing on
the same arithmetic by luck.

Run: python -m pytest tools/mutation/test_stryker_to_mutation_json.py -q
"""
import importlib.util
import json
import os

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "stryker_to_mutation_json", os.path.join(_HERE, "stryker_to_mutation_json.py")
)
conv = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(conv)


# ── fixtures ─────────────────────────────────────────────────────────────────

def mutant(status, line=1, mutator="ConditionalExpression"):
    """A mutant as STRYKER writes it (lowercase keys) — report-file input."""
    return {"status": status, "location": {"start": {"line": line}}, "mutatorName": mutator}


def flat(status):
    """A mutant as read_mutants HANDS ON (capitalised keys) — tally/score input.

    Two shapes, two helpers, on purpose: passing a raw Stryker mutant to tally()
    is a bug the tests should not be able to hide behind a permissive lookup."""
    return {"File": "src/a.js", "Line": 1, "Status": status, "Operator": "X"}


def write_report(path, files):
    """files: {name: [mutant, ...]} -> a minimal Stryker JSON report."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"files": {n: {"mutants": m} for n, m in files.items()}}, fh)


def write_config(package_dir, name, mutate, report_name):
    os.makedirs(package_dir, exist_ok=True)
    path = os.path.join(package_dir, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"mutate": mutate, "jsonReporter": {"fileName": report_name}}, fh)
    return path


# ── tally: which statuses count, and on which side ───────────────────────────

def test_tally_counts_timeout_as_detected_and_nocoverage_as_missed():
    # Deliberately unequal buckets: 3 Killed + 1 Timeout = 4 detected,
    # 2 Survived + 1 NoCoverage = 3 missed. Every plausible mis-mapping
    # (Timeout missed, NoCoverage excluded, NoCoverage detected) yields a
    # different pair, so this fixture can tell them apart.
    mutants = ([flat("Killed")] * 3 + [flat("Timeout")]
               + [flat("Survived")] * 2 + [flat("NoCoverage")])
    assert conv.tally(mutants) == (4, 3)


def test_tally_excludes_verdictless_statuses_from_both_sides():
    # Ignored/CompileError/RuntimeError are not evidence either way. Five of them
    # against one Killed and two Survived: if any leaked into a bucket the pair
    # would move, and the count differs per status so it says WHICH leaked.
    mutants = ([flat("Killed")] + [flat("Survived")] * 2
               + [flat("Ignored")] * 5 + [flat("CompileError")] * 3
               + [flat("RuntimeError")] * 4)
    assert conv.tally(mutants) == (1, 2)


def test_tally_of_nothing_is_zero_zero():
    assert conv.tally([]) == (0, 0)


# ── score ────────────────────────────────────────────────────────────────────

def test_score_is_the_detected_share_rounded_to_two_places():
    assert conv.score(1, 2) == 33.33   # 33.333... -> two places
    assert conv.score(2, 1) == 66.67   # and rounds up, not truncates
    assert conv.score(151, 10) == 93.79


def test_score_is_none_when_nothing_was_measured():
    # Not 0.0 and not 100.0 — both read as a verdict on the page. None makes the
    # Mutation cell fall back to "—", which is the true statement.
    assert conv.score(0, 0) is None
    assert conv.score(0, 1) == 0.0     # a real 0% is still a real number
    assert conv.score(1, 0) == 100.0


# ── read_mutants ─────────────────────────────────────────────────────────────

def test_read_mutants_flattens_every_file_with_line_and_operator(tmp_path):
    path = str(tmp_path / "r.json")
    write_report(path, {
        "src/b.js": [mutant("Killed", line=7, mutator="ArithmeticOperator")],
        "src/a.js": [mutant("Survived", line=3, mutator="BooleanLiteral")],
    })
    got = conv.read_mutants(path)
    # Sorted by file name, so output is stable across runs and diffs stay readable.
    assert [m["File"] for m in got] == ["src/a.js", "src/b.js"]
    assert got[0] == {"File": "src/a.js", "Line": 3,
                      "Status": "Survived", "Operator": "BooleanLiteral"}
    assert got[1]["Line"] == 7 and got[1]["Operator"] == "ArithmeticOperator"


def test_read_mutants_keeps_ignored_mutants_so_the_file_set_stays_complete(tmp_path):
    # The docstring's edge case, and the reason ignored mutants are emitted at all:
    # generate-coverage-doc.py derives the MEASURED file set from mutants[].File.
    # Drop the ignored ones and a file with no verdict-carrying mutant disappears
    # from that set, and the page reports scope the score supposedly does not cover.
    path = str(tmp_path / "r.json")
    write_report(path, {
        "src/catalog.js": [mutant("Ignored"), mutant("Ignored")],
        "src/real.js": [mutant("Killed")],
    })
    got = conv.read_mutants(path)
    assert {m["File"] for m in got} == {"src/catalog.js", "src/real.js"}
    assert conv.tally(got) == (1, 0)  # ...while contributing nothing to the score


def test_read_mutants_tolerates_a_report_with_no_files_or_no_location(tmp_path):
    path = str(tmp_path / "empty.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"files": {"src/a.js": {"mutants": [{"status": "Killed"}]}}}, fh)
    assert conv.read_mutants(path) == [
        {"File": "src/a.js", "Line": None, "Status": "Killed", "Operator": None}
    ]

    bare = str(tmp_path / "bare.json")
    with open(bare, "w", encoding="utf-8") as fh:
        json.dump({}, fh)
    assert conv.read_mutants(bare) == []


# ── report_path ──────────────────────────────────────────────────────────────

def test_report_path_reads_the_configs_own_reporter_filename(tmp_path):
    pkg = str(tmp_path / "app")
    cfg = write_config(pkg, "stryker.a.config.json", ["src/a.js"], "reports/out.json")
    assert conv.report_path(pkg, cfg) == os.path.join(pkg, "reports/out.json")


def test_report_path_refuses_a_config_that_names_no_report(tmp_path):
    pkg = str(tmp_path / "app")
    os.makedirs(pkg)
    cfg = os.path.join(pkg, "stryker.a.config.json")
    with open(cfg, "w", encoding="utf-8") as fh:
        json.dump({"mutate": ["src/a.js"]}, fh)
    with pytest.raises(SystemExit, match="jsonReporter.fileName"):
        conv.report_path(pkg, cfg)


# ── merge ────────────────────────────────────────────────────────────────────

def test_merge_combines_scopes_and_keeps_each_scopes_own_score(tmp_path):
    pkg = str(tmp_path / "app")
    write_config(pkg, "stryker.one.config.json", ["src/a.js"], "reports/one.json")
    write_config(pkg, "stryker.two.config.json", ["src/b.js"], "reports/two.json")
    # Deliberately different per-scope scores (100% and 50%) so a bug that reports
    # the blended figure per scope, or one scope's figure for the other, fails.
    write_report(os.path.join(pkg, "reports/one.json"),
                 {"src/a.js": [mutant("Killed"), mutant("Killed"), mutant("Killed")]})
    write_report(os.path.join(pkg, "reports/two.json"),
                 {"src/b.js": [mutant("Killed"), mutant("Survived")]})

    merged = conv.merge(pkg)
    assert merged["killed"] == 4 and merged["survived"] == 1 and merged["total"] == 5
    assert merged["mutationScore"] == 80.0     # 4/5 blended, not the mean of 100 and 50
    assert [(s["config"], s["score"]) for s in merged["scopes"]] == [
        ("stryker.one.config.json", 100.0),
        ("stryker.two.config.json", 50.0),
    ]
    assert {m["File"] for m in merged["mutants"]} == {"src/a.js", "src/b.js"}


def test_merge_refuses_to_publish_when_a_scopes_report_is_absent(tmp_path):
    pkg = str(tmp_path / "app")
    write_config(pkg, "stryker.one.config.json", ["src/a.js"], "reports/one.json")
    write_config(pkg, "stryker.two.config.json", ["src/b.js"], "reports/two.json")
    write_report(os.path.join(pkg, "reports/one.json"), {"src/a.js": [mutant("Killed")]})
    # two.json never written — publishing now would report 100% for a package whose
    # second scope was never measured.
    with pytest.raises(SystemExit, match="stryker.two.config.json"):
        conv.merge(pkg)


def test_merge_refuses_a_package_with_no_stryker_configs(tmp_path):
    pkg = str(tmp_path / "app")
    os.makedirs(pkg)
    with pytest.raises(SystemExit, match="nothing to merge"):
        conv.merge(pkg)


# ── main ─────────────────────────────────────────────────────────────────────

def test_main_writes_a_report_generate_coverage_doc_can_read(tmp_path, capsys):
    pkg = str(tmp_path / "app")
    write_config(pkg, "stryker.one.config.json", ["src/a.js"], "reports/one.json")
    write_report(os.path.join(pkg, "reports/one.json"),
                 {"src/a.js": [mutant("Killed"), mutant("Timeout"), mutant("NoCoverage")]})
    out = str(tmp_path / "docs" / "api" / "mutation.json")

    assert conv.main(["--package-dir", pkg, "--out", out]) == 0

    with open(out, encoding="utf-8") as f:
        written = json.load(f)
    # The four keys generate-coverage-doc.py actually consumes.
    assert written["mutationScore"] == 66.67   # 2 detected of 3, NoCoverage counting as missed
    assert written["killed"] == 2 and written["total"] == 3
    assert {m["File"] for m in written["mutants"]} == {"src/a.js"}
    assert "66.67%" in capsys.readouterr().out

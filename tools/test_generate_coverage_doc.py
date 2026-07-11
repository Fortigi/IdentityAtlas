"""Unit tests for tools/generate-coverage-doc.py.

The script name has a hyphen, so it can't be imported normally; load it by path.
These cover the complexity/mutation aggregation and the end-to-end table render
(the new Cyclomatic / Cognitive / Mutation columns), plus the pre-existing
formatting helpers, so the coverage page stays trustworthy.

Run: python -m pytest tools/test_generate_coverage_doc.py -q
"""
import importlib.util
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "generate_coverage_doc", os.path.join(_HERE, "generate-coverage-doc.py")
)
gcd = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(gcd)


# ── complexity_stats ──────────────────────────────────────────────────────────

def test_complexity_stats_aggregates_avg_and_max():
    units = [
        {"file": "a.ps1", "unit": "A", "cc": 2, "cog": 1},
        {"file": "a.ps1", "unit": "B", "cc": 4, "cog": 9},
        {"file": "b.ps1", "unit": "<script-body>", "cc": 33, "cog": 59},
    ]
    s = gcd.complexity_stats(units)
    assert s["units"] == 3
    assert s["cyclo_avg"] == (2 + 4 + 33) / 3
    assert s["cyclo_max"] == 33
    assert s["cog_avg"] == (1 + 9 + 59) / 3
    assert s["cog_max"] == 59


def test_complexity_stats_none_for_empty_or_missing():
    assert gcd.complexity_stats(None) is None
    assert gcd.complexity_stats([]) is None
    # Rows present but no numeric metrics → nothing to summarise.
    assert gcd.complexity_stats([{"file": "x", "cc": None, "cog": None}]) is None


# ── mutation_stats ────────────────────────────────────────────────────────────

def test_mutation_stats_reads_psmutant_report():
    s = gcd.mutation_stats({"mutationScore": 82.7, "killed": 167, "total": 202})
    assert s == {"score": 82.7, "killed": 167, "total": 202}


def test_mutation_stats_none_when_absent_or_scoreless():
    assert gcd.mutation_stats(None) is None
    assert gcd.mutation_stats({}) is None
    assert gcd.mutation_stats({"mutationScore": None}) is None


# ── formatting helpers ────────────────────────────────────────────────────────

def test_fmt_avg_max():
    assert gcd.fmt_avg_max(4.66, 165) == "4.7 / 165"
    assert gcd.fmt_avg_max(None, 5) == "—"
    assert gcd.fmt_avg_max(5, None) == "—"


def test_fmt_pct():
    assert gcd.fmt_pct(None) == "—"
    assert gcd.fmt_pct(82.7) == "82.7%"


# ── collect_rows / render_row ─────────────────────────────────────────────────

def test_collect_rows_totals_and_side_inputs(tmp_path):
    cov = tmp_path / "coverage"
    _write(str(cov / "powershell" / "Summary.json"), {"summary": {
        "linecoverage": 80.0, "coveredlines": 100, "coverablelines": 200,
    }})
    _write(str(cov / "powershell" / "complexity.json"), [{"cc": 4, "cog": 9}])
    _write(str(cov / "powershell" / "mutation.json"), {"mutationScore": 50.0})

    rows, covered, coverable = gcd.collect_rows(str(cov))
    assert (covered, coverable) == (100, 200)
    by_slug = {slug: data for slug, _, data in rows}
    # PowerShell suite carries parsed coverage + aggregated side-inputs.
    assert by_slug["powershell"]["line"] == 80.0
    assert by_slug["powershell"]["complexity"]["cyclo_max"] == 4
    assert by_slug["powershell"]["mutation"]["score"] == 50.0
    # Suites with no Summary.json collapse to None.
    assert by_slug["api"] is None and by_slug["ui"] is None


def test_render_row_missing_suite_is_all_dashes():
    assert gcd.render_row("ui", "UI", None, "../coverage") == \
        "| UI | — | — | — | — | — | — | _no report_ |"


def test_render_row_without_side_inputs_dashes_new_columns():
    data = {"line": 73.3, "branch": None, "method": 76.0,
            "covered": 10, "coverable": 20, "complexity": None, "mutation": None}
    row = gcd.render_row("api", "API", data, "../coverage")
    assert row.endswith("| — | — | — | 10 / 20 |")
    assert "[API](../coverage/api/index.html)" in row


# ── end-to-end render ─────────────────────────────────────────────────────────

def _write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


def test_main_renders_new_columns(tmp_path, monkeypatch):
    cov = tmp_path / "coverage"
    # PowerShell suite: full coverage + complexity + mutation side-inputs.
    _write(str(cov / "powershell" / "Summary.json"), {"summary": {
        "linecoverage": 81.6, "methodcoverage": 95.5,
        "coveredlines": 4604, "coverablelines": 5636,
    }})
    _write(str(cov / "powershell" / "complexity.json"), [
        {"cc": 2, "cog": 1}, {"cc": 4, "cog": 9}, {"cc": 33, "cog": 59},
    ])
    _write(str(cov / "powershell" / "mutation.json"),
           {"mutationScore": 82.7, "killed": 167, "total": 202})
    # API suite: coverage only, no complexity/mutation → dashes.
    _write(str(cov / "api" / "Summary.json"), {"summary": {
        "linecoverage": 73.3, "branchcoverage": 61.9, "methodcoverage": 76.0,
        "coveredlines": 6607, "coverablelines": 9004,
    }})

    out = tmp_path / "coverage.md"
    monkeypatch.setattr(
        "sys.argv",
        ["prog", "--coverage-dir", str(cov), "--out", str(out), "--commit", "deadbeefcafe"],
    )
    assert gcd.main() == 0
    text = out.read_text(encoding="utf-8")

    # Header carries the three new columns.
    assert "| Suite | Line | Branch | Method | Cyclomatic | Cognitive | Mutation | Lines covered |" in text
    # PowerShell row shows aggregated complexity + mutation.
    assert "13.0 / 33" in text  # cyclomatic avg (2+4+33)/3=13.0, max 33
    assert "23.0 / 59" in text  # cognitive avg (1+9+59)/3=23.0, max 59
    assert "82.7%" in text
    # API row (no side-inputs) leaves the three new columns blank. (The label
    # itself contains an em-dash, so match the trailing columns explicitly.)
    api_row = next(ln for ln in text.splitlines() if ln.startswith("| [API"))
    assert api_row.endswith("| — | — | — | 6,607 / 9,004 |")
    # UI suite has no report at all → all-dash row still has 8 columns.
    ui_row = next(ln for ln in text.splitlines() if "UI (React" in ln and "index.html" not in ln.split("]")[0])
    assert ui_row.count("|") == 9  # 8 columns → 9 pipes


def test_main_handles_no_reports(tmp_path, monkeypatch):
    out = tmp_path / "coverage.md"
    monkeypatch.setattr(
        "sys.argv",
        ["prog", "--coverage-dir", str(tmp_path / "empty"), "--out", str(out)],
    )
    assert gcd.main() == 0
    text = out.read_text(encoding="utf-8")
    assert "_no report_" in text
    # No cross-suite aggregate: no overall row and no top coverage badge.
    assert "**Overall**" not in text
    assert "img.shields.io" not in text

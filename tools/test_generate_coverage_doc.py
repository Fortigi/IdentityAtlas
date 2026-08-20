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


# ── per_file_coverage ─────────────────────────────────────────────────────────

def test_per_file_coverage_reads_every_assembly(tmp_path):
    # The PowerShell report splits its files across 11 assemblies; reading only
    # the first silently reports a fraction of the suite as if it were all of it.
    cov = tmp_path / "coverage"
    _write(str(cov / "powershell" / "Summary.json"), {"coverage": {"assemblies": [
        {"classesinassembly": [
            {"name": "a/One", "coverage": 90.0, "branchcoverage": 80.0, "coverablelines": 10},
        ]},
        {"classesinassembly": [
            {"name": "b/Two", "coverage": 50.0, "branchcoverage": None, "coverablelines": 40},
        ]},
    ]}})
    files = gcd.per_file_coverage(str(cov), "powershell")
    assert set(files) == {"a/One", "b/Two"}
    assert files["b/Two"]["coverable"] == 40
    assert files["b/Two"]["branch"] is None


def test_per_file_coverage_empty_when_summary_missing(tmp_path):
    assert gcd.per_file_coverage(str(tmp_path), "nope") == {}


# ── lookup_file / mutated_files ───────────────────────────────────────────────

def test_lookup_file_matches_exact_then_stem_then_path_tail():
    per_file = {
        "src/exact.js": {"branch": 1.0},
        "tools/a.Transform": {"branch": 2.0},   # JaCoCo drops the extension
        "src/components/Big.jsx": {"branch": 3.0},
    }
    assert gcd.lookup_file("src/exact.js", per_file)["branch"] == 1.0
    assert gcd.lookup_file("tools/a.Transform.ps1", per_file)["branch"] == 2.0
    # Complexity keys are repo-relative, coverage keys suite-relative.
    assert gcd.lookup_file("app/ui/src/components/Big.jsx", per_file)["branch"] == 3.0


def test_lookup_file_requires_a_path_boundary_for_the_tail_match():
    # 'other/mysrc/App.jsx' must NOT match the key 'src/App.jsx'.
    per_file = {"src/App.jsx": {"branch": 9.0}}
    assert gcd.lookup_file("other/mysrc/App.jsx", per_file) is None
    assert gcd.lookup_file("app/ui/src/App.jsx", per_file)["branch"] == 9.0


def test_lookup_file_none_for_empty_name_or_no_match():
    assert gcd.lookup_file("", {"a": {}}) is None
    assert gcd.lookup_file("nope.js", {}) is None


def test_mutated_files_reads_either_key_casing():
    assert gcd.mutated_files({"mutants": [{"File": "a.ps1"}, {"file": "b.ps1"}]}) == {"a.ps1", "b.ps1"}
    assert gcd.mutated_files({"mutants": [{"Id": 1}]}) == set()
    assert gcd.mutated_files(None) == set()


# ── mutation_scope ────────────────────────────────────────────────────────────

def _per_file(**kw):
    return {name: {"line": None, "branch": None, "coverable": n} for name, n in kw.items()}


def test_mutation_scope_measures_the_subset_the_score_describes():
    report = {"mutants": [
        {"File": "tools/a.Transform.ps1"}, {"File": "tools/a.Transform.ps1"},
        {"File": "tools/b.Transform.ps1"},
    ], "operators": ["BinaryOperator", "BooleanLiteral"]}
    # Coverage keys drop the extension; two of five files are mutated.
    per_file = {
        "tools/a.Transform": {"coverable": 100, "branch": None, "line": None},
        "tools/b.Transform": {"coverable": 100, "branch": None, "line": None},
        "tools/c.Phases": {"coverable": 800, "branch": None, "line": None},
    }
    s = gcd.mutation_scope(report, per_file)
    assert s["files"] == 2
    assert s["files_total"] == 3
    assert s["lines"] == 200 and s["lines_total"] == 1000
    assert s["line_pct"] == 20.0
    assert s["operators"] == 2
    assert s["unmatched"] == 0


def test_mutation_scope_counts_files_with_no_coverage_entry_as_unmatched():
    report = {"mutants": [{"File": "tools/ghost.ps1"}]}
    s = gcd.mutation_scope(report, _per_file(**{"tools/other": 50}))
    assert s["files"] == 1 and s["unmatched"] == 1 and s["lines"] == 0


def test_mutation_scope_none_without_per_mutant_detail():
    assert gcd.mutation_scope(None, {}) is None
    assert gcd.mutation_scope({"mutationScore": 90}, {}) is None
    assert gcd.mutation_scope({"mutants": [{}]}, {}) is None


# ── declared_mutation_files / scope-vs-score staleness ────────────────────────

def test_declared_mutation_files_reads_the_committed_scope(tmp_path):
    cfg = tmp_path / "psmutant.config.json"
    _write(str(cfg), {"mutate": ["a.ps1", "b.ps1"], "operators": ["X", "Y", "Z"]})
    d = gcd.declared_mutation_files(str(cfg))
    assert d["files"] == {"a.ps1", "b.ps1"}
    assert d["operators"] == 3


def test_declared_mutation_files_none_when_unusable(tmp_path):
    assert gcd.declared_mutation_files(None) is None
    assert gcd.declared_mutation_files(str(tmp_path / "missing.json")) is None
    bad = tmp_path / "bad.json"
    bad.write_text("{ not json", encoding="utf-8")
    assert gcd.declared_mutation_files(str(bad)) is None
    empty = tmp_path / "empty.json"
    _write(str(empty), {"mutate": []})
    assert gcd.declared_mutation_files(str(empty)) is None


# ── declared_stryker_files / declared_scope_for ───────────────────────────────
# The JS suites declare their mutation scope across SEVERAL Stryker configs in a
# package root, where PowerShell declares its in one PSMutant config. These cover
# the union, and the routing that keeps one suite's declaration out of another's
# row — the page previously applied the PowerShell `mutate` list to every suite.

def _stryker(dirpath, name, mutate):
    _write(os.path.join(dirpath, name), {"mutate": mutate,
                                         "jsonReporter": {"fileName": "reports/r.json"}})


def test_declared_stryker_files_unions_every_config_in_the_package(tmp_path):
    pkg = str(tmp_path / "app")
    _stryker(pkg, "stryker.auth.config.json", ["src/a.js", "src/shared.js"])
    _stryker(pkg, "stryker.other.config.json", ["src/b.js", "src/shared.js"])
    d = gcd.declared_stryker_files(pkg)
    # Union, de-duplicated — three distinct files across two configs, not four.
    assert d["files"] == {"src/a.js", "src/b.js", "src/shared.js"}
    # Stryker declares which mutators to EXCLUDE, not a fixed operator list, so
    # there is no honest count and scope_note must omit the clause.
    assert d["operators"] is None


def test_declared_stryker_files_ignores_a_broken_config_but_keeps_the_rest(tmp_path):
    pkg = str(tmp_path / "app")
    _stryker(pkg, "stryker.good.config.json", ["src/a.js"])
    with open(os.path.join(pkg, "stryker.bad.config.json"), "w", encoding="utf-8") as fh:
        fh.write("{ not json")
    # One unparseable config must not blank out the whole declaration — that would
    # silently fall back to the report and hide the real scope.
    assert gcd.declared_stryker_files(pkg)["files"] == {"src/a.js"}


def test_declared_stryker_files_none_when_there_is_nothing_to_read(tmp_path):
    assert gcd.declared_stryker_files(None) is None
    assert gcd.declared_stryker_files(str(tmp_path / "missing")) is None
    empty = str(tmp_path / "empty")
    os.makedirs(empty)
    assert gcd.declared_stryker_files(empty) is None          # no configs at all
    _stryker(empty, "stryker.a.config.json", [])
    assert gcd.declared_stryker_files(empty) is None          # configs, empty mutate
    # A non-Stryker JSON file in the package root is not a declaration.
    _write(os.path.join(empty, "package.json"), {"mutate": ["src/nope.js"]})
    assert gcd.declared_stryker_files(empty) is None


def test_declared_scope_for_routes_each_suite_to_its_own_declaration(tmp_path):
    root = str(tmp_path)
    _stryker(os.path.join(root, "app", "api"), "stryker.a.config.json", ["src/api.js"])
    _stryker(os.path.join(root, "app", "ui"), "stryker.b.config.json", ["src/ui.js"])
    ps_cfg = str(tmp_path / "psmutant.config.json")
    _write(ps_cfg, {"mutate": ["crawler.ps1"], "operators": ["X"]})

    # Each suite gets ITS OWN file list. The bug this guards: the PowerShell
    # declaration was read once and handed to every row, so the API and UI rows
    # reported PowerShell's 112 files as the scope of a JS score.
    assert gcd.declared_scope_for("api", ps_cfg, root)["files"] == {"src/api.js"}
    assert gcd.declared_scope_for("ui", ps_cfg, root)["files"] == {"src/ui.js"}
    assert gcd.declared_scope_for("powershell", ps_cfg, root)["files"] == {"crawler.ps1"}
    # A suite with neither kind of declaration falls back to the report.
    assert gcd.declared_scope_for("unknown-suite", ps_cfg, root) is None


def test_collect_rows_scopes_a_js_suite_by_its_own_stryker_configs(tmp_path):
    root = tmp_path / "repo"
    cov = root / "coverage"
    _write(str(cov / "api" / "Summary.json"), {
        "summary": {"linecoverage": 90.0, "coveredlines": 90, "coverablelines": 100},
        "coverage": {"assemblies": [{"classesinassembly": [
            {"name": "src/a.js", "coverage": 90.0, "coverablelines": 40},
            {"name": "src/b.js", "coverage": 80.0, "coverablelines": 60},
        ]}]},
    })
    # The report measured ONE file; the configs declare TWO. Different numbers on
    # purpose: a row that reported 1 file would mean the declaration was ignored.
    _write(str(cov / "api" / "mutation.json"), {
        "mutationScore": 75.0, "killed": 3, "total": 4,
        "mutants": [{"File": "src/a.js"}],
    })
    _stryker(str(root / "app" / "api"), "stryker.one.config.json", ["src/a.js"])
    _stryker(str(root / "app" / "api"), "stryker.two.config.json", ["src/b.js"])
    ps_cfg = str(root / "psmutant.config.json")
    _write(ps_cfg, {"mutate": ["crawler-1.ps1", "crawler-2.ps1", "crawler-3.ps1"]})

    rows, _covered, _coverable = gcd.collect_rows(str(cov), ps_cfg, str(root))
    scope = {slug: data for slug, _, data in rows}["api"]["mutation_scope"]

    assert scope["files"] == 2                # the Stryker declaration, not the 3 PS files
    assert scope["measured_files"] == 1       # ...and the report is behind it
    assert scope["stale"] is True             # so the page says the score lags the scope
    assert scope["lines"] == 100              # both declared files matched a coverage entry
    assert scope["unmatched"] == 0


def test_resolve_declared_scope_prefers_the_declaration_then_the_report():
    report = {"operators": ["X", "Y"]}
    declared = {"files": {"a.ps1"}, "operators": 4}
    assert gcd.resolve_declared_scope(report, declared, {"z.ps1"}) == ({"a.ps1"}, 4)
    # No declaration → whatever the report actually ran.
    assert gcd.resolve_declared_scope(report, None, {"z.ps1"}) == ({"z.ps1"}, 2)
    # Declaration with no operator list → None rather than the report's count,
    # so the sentence omits the clause instead of quoting a mismatched number.
    assert gcd.resolve_declared_scope(report, {"files": {"a.ps1"}}, {"z.ps1"}) == ({"a.ps1"}, None)


def test_mutation_scope_prefers_the_declared_scope_over_the_report():
    # The committed config is current as of the merge; the report is regenerated
    # on its own cadence and can describe a narrower set.
    report = {"mutants": [{"File": "tools/a.ps1"}]}
    per_file = {
        "tools/a": {"coverable": 100, "branch": None, "line": None},
        "tools/b": {"coverable": 100, "branch": None, "line": None},
        "tools/c": {"coverable": 800, "branch": None, "line": None},
    }
    declared = {"files": {"tools/a.ps1", "tools/b.ps1"}, "operators": 4}
    s = gcd.mutation_scope(report, per_file, declared)
    assert s["files"] == 2            # declared, not the 1 the report measured
    assert s["measured_files"] == 1
    assert s["stale"] is True
    assert s["lines"] == 200 and s["line_pct"] == 20.0
    assert s["operators"] == 4


def test_mutation_scope_not_stale_when_report_matches_declaration():
    report = {"mutants": [{"File": "tools/a.ps1"}, {"File": "tools/b.ps1"}]}
    per_file = {"tools/a": {"coverable": 10, "branch": None, "line": None},
                "tools/b": {"coverable": 10, "branch": None, "line": None}}
    declared = {"files": {"tools/a.ps1", "tools/b.ps1"}, "operators": 4}
    assert gcd.mutation_scope(report, per_file, declared)["stale"] is False


def test_mutation_scope_falls_back_to_the_report_without_a_declaration():
    report = {"mutants": [{"File": "tools/a.ps1"}], "operators": ["X"]}
    per_file = {"tools/a": {"coverable": 10, "branch": None, "line": None}}
    s = gcd.mutation_scope(report, per_file, None)
    assert s["files"] == 1 and s["stale"] is False and s["operators"] == 1


def test_scope_note_flags_a_score_older_than_its_scope():
    note = gcd.scope_note({"files": 19, "files_total": 140, "line_pct": 31.0,
                           "operators": 4, "measured_files": 9, "stale": True})
    assert "covers 19 file(s) of 140" in note
    assert "score itself is older than that scope" in note
    assert "measured over 9 file(s)" in note


def test_scope_note_stays_quiet_when_score_and_scope_agree():
    note = gcd.scope_note({"files": 19, "files_total": 140, "line_pct": 31.0,
                           "operators": 4, "measured_files": 19, "stale": False})
    assert "older than that scope" not in note


# ── shape_flags ───────────────────────────────────────────────────────────────

def test_shape_flags_reports_method_below_line_inversion():
    flags = gcd.shape_flags({"line": 79.4, "method": 67.4, "branch": 68.1})
    assert len(flags) == 1
    assert "method coverage (67.4%) sits below line coverage (79.4%)" in flags[0]


def test_shape_flags_quiet_when_method_at_or_above_line():
    assert gcd.shape_flags({"line": 87.9, "method": 88.9, "branch": 77.1}) == []
    # A sub-1-point dip is noise, not a signal.
    assert gcd.shape_flags({"line": 88.0, "method": 87.5, "branch": 70.0}) == []


def test_shape_flags_reports_absent_branch_data():
    flags = gcd.shape_flags({"line": 91.3, "method": 97.2, "branch": None})
    assert any("No branch coverage is measured" in f for f in flags)


# ── complexity_hotspots ───────────────────────────────────────────────────────

def test_complexity_hotspots_flags_complex_units_below_the_suite_average():
    units = [
        {"file": "app/ui/src/components/Big.jsx", "unit": "Big", "cc": 28},
        {"file": "app/ui/src/components/Mid.jsx", "unit": "Mid", "cc": 20},
        {"file": "app/ui/src/utils/small.js", "unit": "small", "cc": 2},
    ]
    # Coverage keys are suite-relative; complexity keys are repo-relative.
    per_file = {
        "src/components/Big.jsx": {"branch": 32.4, "coverable": 100, "line": None},
        "src/components/Mid.jsx": {"branch": 90.0, "coverable": 100, "line": None},
    }
    hot = gcd.complexity_hotspots(units, per_file, suite_branch=68.1, limit=2)
    assert [h["cc"] for h in hot] == [28, 20]          # ranked by complexity
    assert hot[0]["branch"] == 32.4 and hot[0]["below_average"] is True
    assert hot[1]["branch"] == 90.0 and hot[1]["below_average"] is False


def test_complexity_hotspots_tolerates_units_with_no_coverage_entry():
    hot = gcd.complexity_hotspots(
        [{"file": "scripts/loose.ps1", "unit": "x", "cc": 9}], {"other": {"branch": 5.0, "coverable": 1}}, 50.0)
    assert hot[0]["branch"] is None and hot[0]["below_average"] is False


def test_complexity_hotspots_empty_without_inputs():
    assert gcd.complexity_hotspots(None, {"a": {}}, 50.0) == []
    assert gcd.complexity_hotspots([{"cc": 5}], {}, 50.0) == []


# ── note builders ─────────────────────────────────────────────────────────────

def test_scope_note_degrades_gracefully_when_fields_are_absent():
    note = gcd.scope_note({"files": 3, "files_total": None, "line_pct": None, "operators": None})
    assert "covers 3 file(s)." in note
    assert "of None" not in note and "None%" not in note


def test_scope_note_none_without_scope():
    assert gcd.scope_note(None) is None


def test_hotspot_note_ignores_hotspots_at_or_above_average():
    assert gcd.hotspot_note([{"file": "a", "unit": "u", "cc": 30,
                              "branch": 90.0, "below_average": False}]) is None
    assert gcd.hotspot_note([]) is None
    assert gcd.hotspot_note(None) is None


def test_hotspot_note_uses_plural_phrasing_for_several():
    note = gcd.hotspot_note([
        {"file": "a", "unit": "u", "cc": 30, "branch": 10.0, "below_average": True},
        {"file": "b", "unit": "v", "cc": 20, "branch": 20.0, "below_average": True},
    ])
    assert "each below this suite's own branch average" in note


def test_suite_notes_orders_scope_then_flags_then_hotspots():
    notes = gcd.suite_notes({
        "mutation_scope": {"files": 1, "files_total": 2, "line_pct": 5.0, "operators": 4},
        "flags": ["FLAG"],
        "hotspots": [{"file": "a", "unit": "u", "cc": 9, "branch": 1.0, "below_average": True}],
    })
    assert len(notes) == 3
    assert notes[0].startswith("**Mutation is scoped.**")
    assert notes[1] == "FLAG"
    assert notes[2].startswith("**The most complex code")


def test_suite_notes_empty_for_a_missing_suite():
    assert gcd.suite_notes(None) == []


# ── render_diagnostics ────────────────────────────────────────────────────────

def test_render_diagnostics_states_mutation_scope_and_hotspots():
    rows = [("ps", "PowerShell", {
        "line": 91.3, "branch": None, "method": 97.2,
        "mutation_scope": {"files": 9, "files_total": 138, "unmatched": 0,
                           "lines": 1100, "lines_total": 5996, "line_pct": 18.3,
                           "operators": 4},
        "flags": ["**No branch coverage is measured.** …"],
        "hotspots": [{"file": "tools/x.ps1", "unit": "Do-Thing", "cc": 30,
                      "branch": 10.0, "below_average": True}],
    })]
    text = "\n".join(gcd.render_diagnostics(rows))
    assert "## Reading these numbers" in text
    assert "covers 9 file(s) of 138" in text
    assert "18% of the suite's coverable lines" in text
    assert "4 mutation operators" in text
    assert "not comparable with the suite-wide line figure" in text
    assert "cyclomatic 30, 10.0% branch" in text
    # Singular phrasing for a single hotspot.
    assert "— below this suite's own branch average" in text


def test_render_diagnostics_says_so_when_nothing_is_flagged():
    rows = [("api", "API", {"line": 88.0, "branch": 77.0, "method": 89.0,
                            "mutation_scope": None, "flags": [], "hotspots": []}),
            ("ui", "UI", None)]
    text = "\n".join(gcd.render_diagnostics(rows))
    assert "_No scope or shape caveats detected for this build._" in text


def test_main_renders_the_diagnostics_section(tmp_path, monkeypatch):
    cov = tmp_path / "coverage"
    _write(str(cov / "ui" / "Summary.json"), {
        "summary": {"linecoverage": 79.4, "branchcoverage": 68.1, "methodcoverage": 67.4,
                    "coveredlines": 5995, "coverablelines": 7546},
        "coverage": {"assemblies": [{"classesinassembly": [
            {"name": "src/components/Big.jsx", "coverage": 59.4,
             "branchcoverage": 32.4, "coverablelines": 274},
        ]}]},
    })
    _write(str(cov / "ui" / "complexity.json"),
           [{"file": "app/ui/src/components/Big.jsx", "unit": "Big", "cc": 28, "cog": 14}])

    out = tmp_path / "coverage.md"
    monkeypatch.setattr("sys.argv", ["prog", "--coverage-dir", str(cov), "--out", str(out)])
    assert gcd.main() == 0
    text = out.read_text(encoding="utf-8")
    assert "## Reading these numbers" in text
    assert "method coverage (67.4%) sits below line coverage (79.4%)" in text
    assert "cyclomatic 28, 32.4% branch" in text
    # The section sits between the table and the browsable-reports list.
    assert text.index("| Suite |") < text.index("## Reading these numbers") < text.index("## Browsable reports")


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

#!/usr/bin/env python3
"""Render the curated test-coverage docs page from ReportGenerator summaries.

The coverage CI workflow (.github/workflows/coverage.yml) runs each test suite
with coverage, converts every suite to a consistent browsable HTML report plus a
machine-readable ``Summary.json`` via ReportGenerator, then calls this script to
turn those summaries into ``docs/reference/coverage.md``. The page and the HTML
reports under ``docs/coverage/`` are committed so mike versions them into the
edge (main) and release (tag) documentation sites — see the workflow header.

This mirrors the SBOM docs pattern (tools/update-sbom-doc.py): CI regenerates a
curated Markdown page from a generated artifact and commits it back to main.

Alongside line/branch/method coverage, the page surfaces two deeper quality
signals that the project already measures elsewhere, when a suite supplies them:

* **Complexity** — ``<coverage-dir>/<slug>/complexity.json``, the per-unit
  ``{file, unit, line, cc, cog}`` array. PowerShell emits it via
  ``tools/complexity/measure_ps.ps1`` (a thin wrapper over the PSComplexity module);
  the Node suites emit it via ``tools/complexity/ratchet.py --emit-complexity-json``
  (ESLint's ``complexity`` rule + eslint-plugin-sonarjs). We aggregate it to avg / max
  cyclomatic and cognitive complexity per suite.
* **Mutation** — ``<coverage-dir>/<slug>/mutation.json``, the PSMutant report
  (``{mutationScore, killed, total, …}``): the share of injected faults the tests
  actually catch. PowerShell-only today; suites without the file show —.

Usage:
    python3 tools/generate-coverage-doc.py \
        --coverage-dir docs/coverage \
        --out docs/reference/coverage.md \
        --commit "$GITHUB_SHA"

Each suite is expected at ``<coverage-dir>/<slug>/Summary.json`` (the JsonSummary
ReportGenerator emits). Missing suites are skipped with a note rather than failing
the build, so the page still renders if one suite produced no coverage. The
complexity/mutation inputs are likewise optional per suite.
"""
import argparse
import datetime
import json
import os
import sys

# Display label + browsable-report subfolder for each suite slug. Order here is
# the order rows appear in the table.
SUITES = [
    ("api", "API (Node / Vitest — unit + contract)"),
    ("ui", "UI (React / Vitest)"),
    ("powershell", "PowerShell (Pester)"),
]


def load_summary(coverage_dir, slug):
    """Return the ReportGenerator 'summary' dict for a suite, or None if absent."""
    path = os.path.join(coverage_dir, slug, "Summary.json")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    # ReportGenerator JsonSummary nests everything under "summary".
    return data.get("summary", data)


def load_json(coverage_dir, slug, filename):
    """Return the parsed JSON at ``<coverage-dir>/<slug>/<filename>``, or None if
    the file is absent. Used for the optional complexity/mutation side-inputs."""
    path = os.path.join(coverage_dir, slug, filename)
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def per_file_coverage(coverage_dir, slug):
    """Return ``{name: {...}}`` for every file in a suite's ReportGenerator summary.

    Iterates EVERY assembly, not just the first — the PowerShell report has 11 of
    them (one per crawler/SDK area) and reading only ``assemblies[0]`` silently
    reports a sixth of the suite as if it were all of it."""
    path = os.path.join(coverage_dir, slug, "Summary.json")
    if not os.path.isfile(path):
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    out = {}
    for assembly in data.get("coverage", {}).get("assemblies", []) or []:
        for cls in assembly.get("classesinassembly", []) or []:
            name = cls.get("name")
            if name:
                out[name] = {
                    "line": pct(cls.get("coverage")),
                    "branch": pct(cls.get("branchcoverage")),
                    "coverable": int(cls.get("coverablelines", 0) or 0),
                }
    return out


def complexity_stats(units):
    """Aggregate the per-unit complexity array from tools/complexity/measure_ps.ps1
    ([{cc, cog, ...}, ...]) into avg / max for each metric. Returns None when there
    is nothing usable to summarise (missing file, empty array, or no numeric rows)."""
    if not units:
        return None
    ccs = [int(u["cc"]) for u in units if isinstance(u, dict) and u.get("cc") is not None]
    cogs = [int(u["cog"]) for u in units if isinstance(u, dict) and u.get("cog") is not None]
    if not ccs or not cogs:
        return None
    return {
        "units": len(units),
        "cyclo_avg": sum(ccs) / len(ccs),
        "cyclo_max": max(ccs),
        "cog_avg": sum(cogs) / len(cogs),
        "cog_max": max(cogs),
    }


def mutation_stats(report):
    """Pull the headline score from a PSMutant report ({mutationScore, killed,
    total, ...}). Returns None if the report is absent or has no numeric score."""
    if not report:
        return None
    score = report.get("mutationScore")
    if score is None:
        return None
    try:
        score = float(score)
    except (TypeError, ValueError):
        return None
    return {
        "score": score,
        "killed": int(report.get("killed", 0) or 0),
        "total": int(report.get("total", 0) or 0),
    }


def lookup_file(name, per_file):
    """Find a file's coverage entry, tolerating the key shapes the reports use.

    The PowerShell (JaCoCo) report drops the extension ('…/Foo.Transform') while
    mutants and complexity units keep it; coverage keys are suite-relative
    ('src/…') while complexity keys are repo-relative ('app/ui/src/…'). Tries
    exact, then extension-stripped, then a trailing path-segment match — anchored
    on '/' so 'other/mysrc/App.jsx' cannot match the key 'src/App.jsx'."""
    if not name:
        return None
    for key in (name, os.path.splitext(name)[0]):
        if key in per_file:
            return per_file[key]
    return next((v for k, v in per_file.items() if name.endswith("/" + k)), None)


def mutated_files(report):
    """The set of files a mutation report actually mutated, from its own per-mutant
    entries — so the measured set can never drift from what was really run."""
    mutants = (report or {}).get("mutants") or []
    files = {m.get("File") or m.get("file") for m in mutants}
    files.discard(None)
    return files


def declared_mutation_files(config_path):
    """The scope a repo DECLARES it mutates, from .ci/psmutant.config.json.

    Scope and score move on different clocks. The config is committed alongside
    the change that widens scope, so it is correct the moment a PR merges. The
    report is regenerated by the weekly ps-mutation.yml, so it can describe a
    narrower set for up to a week. Reading scope from the report alone made the
    page understate itself — it kept saying "9 files" after the scope had grown
    to 19, which is the exact failure this section exists to prevent, aimed at
    itself. Returns None when the config is unreadable, so the caller can fall
    back to the report."""
    if not config_path or not os.path.isfile(config_path):
        return None
    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        return None
    declared = cfg.get("mutate")
    if not declared:
        return None
    return {"files": set(declared), "operators": len(cfg.get("operators") or []) or None}


def resolve_declared_scope(report, declared, measured):
    """Pick the authoritative file set and operator count for the scope note.

    The committed declaration wins when present — it is current as of the merge,
    while the report is regenerated on its own cadence. Falls back to what the
    report actually ran when there is no declaration to read."""
    if declared:
        return declared["files"], (declared.get("operators") or None)
    return measured, (len(report.get("operators") or []) or None)


def mutation_scope(report, per_file, declared=None):
    """How much of a suite the mutation score actually describes.

    A mutation score is only meaningful next to the file set it was measured over.
    PSMutant mutates a hand-listed subset (``mutate`` in .ci/psmutant.config.json),
    so a headline like "93.2%" sitting beside a suite-wide "91.3% line" invites the
    reading that the whole suite is mutation-tested — when in practice the list has
    been the pure record-shapers, the easiest code in the tree to kill mutants in.

    Derives the mutated set from the report's own per-mutant ``File`` entries, so
    it cannot drift from what was really run. Returns None when the report carries
    no per-mutant detail."""
    measured = mutated_files(report)
    if not measured:
        return None
    files, operators = resolve_declared_scope(report, declared, measured)
    matched = [e for e in (lookup_file(f, per_file) for f in files) if e is not None]
    total_lines = sum(v["coverable"] for v in per_file.values())
    scope_lines = sum(v["coverable"] for v in matched)
    return {
        "files": len(files),
        "files_total": len(per_file) or None,
        "unmatched": len(files) - len(matched),
        "lines": scope_lines,
        "lines_total": total_lines,
        "line_pct": (100.0 * scope_lines / total_lines) if total_lines else None,
        "operators": operators,
        # True when the published score was measured over a different file set
        # than the repo currently declares — i.e. the score lags the scope.
        "measured_files": len(measured),
        "stale": bool(declared) and measured != files,
    }


def shape_flags(data):
    """Diagnostics about the SHAPE of a suite's numbers rather than their level.

    Coverage percentages can be individually healthy and still, taken together,
    say something the headline hides. Two such signals:

    * **method < line** — normally entering a function covers several of its
      lines, so method coverage sits at or above line coverage. Inverted means a
      share of functions is never invoked at all while the rest are exercised
      thoroughly: in a React suite, components that are rendered and asserted on
      but never *driven* — the dead part is event handlers and callbacks.
    * **no branch data** — a suite reporting line coverage with no branch figure
      cannot be compared like-for-like with one that has both."""
    flags = []
    line, method, branch = data.get("line"), data.get("method"), data.get("branch")
    if line is not None and method is not None and method < line - 1.0:
        flags.append(
            f"**method coverage ({method:.1f}%) sits below line coverage ({line:.1f}%)** — "
            "roughly a third of functions are never invoked, while the ones that are get "
            "exercised well. Typically components rendered but not interacted with: the "
            "untested part is event handlers, callbacks and conditional render paths."
        )
    if branch is None and line is not None:
        flags.append(
            "**No branch coverage is measured.** The line figure is not comparable "
            "with the suites that report both — and for Pester it is command-based "
            "rather than true line coverage, so it is not directly comparable with "
            "the Vitest suites either."
        )
    return flags


def complexity_hotspots(units, per_file, suite_branch, limit=3):
    """The most complex units, joined to the branch coverage of the file they sit in.

    Aggregate coverage flatters a codebase exactly when its uncovered branches
    concentrate in its most complex functions — the two facts live in separate
    reports and nothing normally puts them side by side. This does: a hotspot
    whose file is below the suite's own branch average is flagged, because that
    is the case where the headline percentage is least representative."""
    if not units or not per_file:
        return []
    ranked = sorted(
        (u for u in units if isinstance(u, dict) and u.get("cc") is not None),
        key=lambda u: int(u["cc"]), reverse=True,
    )[:limit]
    out = []
    for u in ranked:
        name = str(u.get("file", ""))
        entry = lookup_file(name, per_file)
        branch = entry["branch"] if entry else None
        out.append({
            "file": name,
            "unit": u.get("unit"),
            "cc": int(u["cc"]),
            "branch": branch,
            "below_average": (
                branch is not None and suite_branch is not None and branch < suite_branch
            ),
        })
    return out


def pct(value):
    """ReportGenerator emits coverage as a float percent or null (no branches)."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fmt_pct(value):
    return "—" if value is None else f"{value:.1f}%"


def fmt_avg_max(avg, mx):
    """Render an 'average / max' complexity cell (e.g. '4.7 / 165'), or — if absent."""
    if avg is None or mx is None:
        return "—"
    return f"{avg:.1f} / {mx}"


def collect_rows(coverage_dir, psmutant_config=None):
    """Load each suite's ReportGenerator summary plus its optional complexity /
    mutation side-inputs into ``(slug, label, data|None)`` rows. Returns the rows
    along with the running overall covered / coverable line totals."""
    rows = []
    overall_covered = 0
    overall_coverable = 0
    declared_scope = declared_mutation_files(psmutant_config)
    for slug, label in SUITES:
        summary = load_summary(coverage_dir, slug)
        if summary is None:
            rows.append((slug, label, None))
            continue
        covered = int(summary.get("coveredlines", 0) or 0)
        coverable = int(summary.get("coverablelines", 0) or 0)
        overall_covered += covered
        overall_coverable += coverable
        # Optional deeper-quality side-inputs (PowerShell supplies both today).
        units = load_json(coverage_dir, slug, "complexity.json")
        report = load_json(coverage_dir, slug, "mutation.json")
        complexity = complexity_stats(units)
        mutation = mutation_stats(report)
        files = per_file_coverage(coverage_dir, slug)
        branch = pct(summary.get("branchcoverage"))
        data = {
            "line": pct(summary.get("linecoverage")),
            "branch": branch,
            "method": pct(summary.get("methodcoverage")),
            "covered": covered,
            "coverable": coverable,
            "complexity": complexity,
            "mutation": mutation,
        }
        # Scope + shape diagnostics: what each number is measured over, and where
        # the aggregate is least representative. See render_diagnostics.
        data["mutation_scope"] = mutation_scope(report, files, declared_scope)
        data["flags"] = shape_flags(data)
        data["hotspots"] = complexity_hotspots(units, files, branch)
        rows.append((slug, label, data))
    return rows, overall_covered, overall_coverable


def render_row(slug, label, data, report_base):
    """Render one suite's Markdown table row. ``data`` is None for a missing suite
    (all-dash row); otherwise it is the dict assembled in ``collect_rows``."""
    if data is None:
        return f"| {label} | — | — | — | — | — | — | _no report_ |"
    report_link = f"[{label}]({report_base}/{slug}/index.html)"
    covered_cell = f"{data['covered']:,} / {data['coverable']:,}"
    cx = data["complexity"]
    cyclo_cell = fmt_avg_max(cx["cyclo_avg"], cx["cyclo_max"]) if cx else "—"
    cog_cell = fmt_avg_max(cx["cog_avg"], cx["cog_max"]) if cx else "—"
    mut = data["mutation"]
    mut_cell = fmt_pct(mut["score"]) if mut else "—"
    return (
        f"| {report_link} | {fmt_pct(data['line'])} | {fmt_pct(data['branch'])} "
        f"| {fmt_pct(data['method'])} | {cyclo_cell} | {cog_cell} | {mut_cell} "
        f"| {covered_cell} |"
    )


DIAGNOSTICS_PREAMBLE = (
    "Every figure above is scoped to what its tool actually measured. The notes "
    "below are generated from the same reports as the table, so they stay true "
    "as the numbers move. They are descriptive, not gates — no CI job fails on "
    "anything in this section."
)


def scope_note(scope):
    """One sentence naming the subset a mutation score describes, or None."""
    if not scope:
        return None
    of_total = f" of {scope['files_total']}" if scope.get("files_total") else ""
    share = (f" — {scope['line_pct']:.0f}% of the suite's coverable lines"
             if scope.get("line_pct") is not None else "")
    ops = (f", using {scope['operators']} mutation operators"
           if scope.get("operators") else "")
    note = (
        f"**Mutation is scoped.** Mutation testing covers {scope['files']} file(s)"
        f"{of_total}{share}{ops}. It describes that subset — not the suite — "
        "and is not comparable with the suite-wide line figure on the same row."
    )
    if scope.get("stale"):
        # Scope is read from the committed config, the score from the last
        # mutation run. They move on different clocks, so say which is which
        # rather than let the reader assume the score covers the stated scope.
        note += (
            f" **The score itself is older than that scope:** it was measured over "
            f"{scope['measured_files']} file(s), before the current list was committed. "
            "Mutation runs are regenerated on their own schedule, so the percentage "
            "catches up on the next run."
        )
    return note


def hotspot_note(hotspots):
    """One sentence naming the complex-but-weakly-branch-covered units, or None."""
    flagged = [h for h in (hotspots or []) if h["below_average"]]
    if not flagged:
        return None
    worst = ", ".join(
        f"`{h['file']}` ({h['unit']}, cyclomatic {h['cc']}, {h['branch']:.1f}% branch)"
        for h in flagged
    )
    tail = ("each below this suite's own branch average" if len(flagged) > 1
            else "below this suite's own branch average")
    return (
        "**The most complex code is the least branch-covered.** "
        f"{worst} — {tail}, so the aggregate percentage overstates how "
        "well the hard parts are tested."
    )


def suite_notes(data):
    """Every caveat that applies to one suite, in reading order."""
    if data is None:
        return []
    candidates = [scope_note(data.get("mutation_scope"))]
    candidates.extend(data.get("flags") or [])
    candidates.append(hotspot_note(data.get("hotspots")))
    return [n for n in candidates if n]


def render_diagnostics(rows):
    """Render the 'Reading these numbers' section.

    The table above is a row of percentages per suite, and percentages invite
    comparison — across suites, and across columns within a suite. Most of those
    comparisons are invalid, because the numbers are measured over different file
    sets by different tools. Rather than trusting each reader to remember that,
    state it here, regenerated from the same inputs as the table, so the caveat
    can never drift from the figure it qualifies."""
    out = ["## Reading these numbers", "", DIAGNOSTICS_PREAMBLE, ""]
    any_note = False
    for _slug, label, data in rows:
        notes = suite_notes(data)
        if not notes:
            continue
        any_note = True
        out.extend([f"### {label}", ""])
        out.extend(f"- {n}" for n in notes)
        out.append("")
    if not any_note:
        out.extend(["_No scope or shape caveats detected for this build._", ""])
    return out


def render_markdown(rows, report_base, commit, generated):
    """Assemble the full ``coverage.md`` text from collected rows. Per-suite only —
    no cross-suite 'overall' figure: line coverage averaged across three unrelated
    languages/runners isn't a number worth quoting."""
    commit = commit.strip()
    commit_short = commit[:8] if commit else ""

    lines = []
    lines.append("# Test Coverage")
    lines.append("")
    lines.append(
        "<!-- GENERATED FILE — do not edit by hand. "
        "Produced by tools/generate-coverage-doc.py via .github/workflows/coverage.yml. -->"
    )
    lines.append("")
    lines.append(
        "Test quality across the project's automated suites — line/branch/method "
        "coverage plus, where measured, code complexity and mutation score — "
        "regenerated on every merge to `main`. The figures on this page reflect the "
        "version of the docs you are viewing — **edge** tracks `main`, a released "
        "version is frozen at its release tag."
    )
    lines.append("")
    lines.append("| Suite | Line | Branch | Method | Cyclomatic | Cognitive | Mutation | Lines covered |")
    lines.append("|-------|------|--------|--------|------------|-----------|----------|---------------|")
    for slug, label, data in rows:
        lines.append(render_row(slug, label, data, report_base))
    lines.append("")
    lines.append(
        "**Cyclomatic** / **Cognitive** are _average / max_ per unit (each function, and "
        "for PowerShell each script/module body too): PowerShell via "
        "[PSComplexity](https://github.com/Fortigi/PSComplexity), JS/TS via ESLint's "
        "`complexity` rule + [eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs). "
        "**Mutation** is the share of injected faults the tests catch via "
        "[PSMutant](https://github.com/Fortigi/PSMutant), PowerShell-only today. A suite "
        "without a given signal shows —."
    )
    lines.append("")
    lines.extend(render_diagnostics(rows))
    lines.append("## Browsable reports")
    lines.append("")
    lines.append("Each suite links to a full per-file, line-by-line HTML report:")
    lines.append("")
    for slug, label, data in rows:
        if data is None:
            lines.append(f"- {label} — _no report for this version_")
        else:
            lines.append(f"- [{label}]({report_base}/{slug}/index.html)")
    lines.append("")
    footer = f"_Generated {generated}"
    if commit_short:
        footer += f" from commit `{commit_short}`"
    footer += "._"
    lines.append(footer)
    lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--coverage-dir", default="docs/coverage")
    ap.add_argument("--out", default="docs/reference/coverage.md")
    ap.add_argument("--commit", default=os.environ.get("GITHUB_SHA", ""))
    ap.add_argument("--psmutant-config", default=".ci/psmutant.config.json",
                    help="Committed mutation-scope declaration. Scope is read from here "
                         "(current as of the merge) rather than from the report, which the "
                         "weekly ps-mutation.yml regenerates on its own cadence.")
    ap.add_argument("--report-base", default="../coverage",
                    help="Relative path from the page to the coverage report root.")
    args = ap.parse_args()

    rows, _covered, overall_coverable = collect_rows(args.coverage_dir, args.psmutant_config)
    generated = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    text = render_markdown(rows, args.report_base, args.commit, generated)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)

    print(f"Wrote {args.out} ({overall_coverable:,} coverable lines across "
          f"{sum(1 for _, _, d in rows if d)} suite(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())

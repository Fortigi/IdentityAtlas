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


def collect_rows(coverage_dir):
    """Load each suite's ReportGenerator summary plus its optional complexity /
    mutation side-inputs into ``(slug, label, data|None)`` rows. Returns the rows
    along with the running overall covered / coverable line totals."""
    rows = []
    overall_covered = 0
    overall_coverable = 0
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
        complexity = complexity_stats(load_json(coverage_dir, slug, "complexity.json"))
        mutation = mutation_stats(load_json(coverage_dir, slug, "mutation.json"))
        rows.append((slug, label, {
            "line": pct(summary.get("linecoverage")),
            "branch": pct(summary.get("branchcoverage")),
            "method": pct(summary.get("methodcoverage")),
            "covered": covered,
            "coverable": coverable,
            "complexity": complexity,
            "mutation": mutation,
        }))
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
    ap.add_argument("--report-base", default="../coverage",
                    help="Relative path from the page to the coverage report root.")
    args = ap.parse_args()

    rows, _covered, overall_coverable = collect_rows(args.coverage_dir)
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

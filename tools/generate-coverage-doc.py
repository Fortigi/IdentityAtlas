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

Usage:
    python3 tools/generate-coverage-doc.py \
        --coverage-dir docs/coverage \
        --out docs/reference/coverage.md \
        --commit "$GITHUB_SHA"

Each suite is expected at ``<coverage-dir>/<slug>/Summary.json`` (the JsonSummary
ReportGenerator emits). Missing suites are skipped with a note rather than failing
the build, so the page still renders if one suite produced no coverage.
"""
import argparse
import datetime
import json
import os
import sys

# Display label + browsable-report subfolder for each suite slug. Order here is
# the order rows appear in the table.
SUITES = [
    ("api", "API (Node / Vitest)"),
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


def badge_color(value):
    if value is None:
        return "lightgrey"
    if value >= 80:
        return "brightgreen"
    if value >= 60:
        return "yellow"
    if value >= 40:
        return "orange"
    return "red"


def shield(label, value):
    """A static shields.io badge URL. Renders alt text if the image can't load."""
    color = badge_color(value)
    shown = "n%2Fa" if value is None else f"{value:.1f}%25"
    # Spaces → underscores per shields.io static-badge escaping.
    safe_label = label.replace("-", "--").replace(" ", "_")
    return f"https://img.shields.io/badge/{safe_label}-{shown}-{color}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--coverage-dir", default="docs/coverage")
    ap.add_argument("--out", default="docs/reference/coverage.md")
    ap.add_argument("--commit", default=os.environ.get("GITHUB_SHA", ""))
    ap.add_argument("--report-base", default="../coverage",
                    help="Relative path from the page to the coverage report root.")
    args = ap.parse_args()

    rows = []
    overall_covered = 0
    overall_coverable = 0
    for slug, label in SUITES:
        summary = load_summary(args.coverage_dir, slug)
        if summary is None:
            rows.append((slug, label, None))
            continue
        line_cov = pct(summary.get("linecoverage"))
        branch_cov = pct(summary.get("branchcoverage"))
        method_cov = pct(summary.get("methodcoverage"))
        covered = int(summary.get("coveredlines", 0) or 0)
        coverable = int(summary.get("coverablelines", 0) or 0)
        overall_covered += covered
        overall_coverable += coverable
        rows.append((slug, label, {
            "line": line_cov,
            "branch": branch_cov,
            "method": method_cov,
            "covered": covered,
            "coverable": coverable,
        }))

    overall = (100.0 * overall_covered / overall_coverable) if overall_coverable else None

    generated = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    commit = args.commit.strip()
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
        "Line coverage across the project's automated test suites, regenerated on "
        "every merge to `main`. The figures on this page reflect the version of the "
        "docs you are viewing — **edge** tracks `main`, a released version is frozen "
        "at its release tag."
    )
    lines.append("")
    lines.append(f"![Overall coverage]({shield('coverage', overall)})")
    lines.append("")
    lines.append("| Suite | Line | Branch | Method | Lines covered |")
    lines.append("|-------|------|--------|--------|---------------|")
    for slug, label, data in rows:
        if data is None:
            lines.append(f"| {label} | — | — | — | _no report_ |")
            continue
        report_link = f"[{label}]({args.report_base}/{slug}/index.html)"
        covered_cell = f"{data['covered']:,} / {data['coverable']:,}"
        lines.append(
            f"| {report_link} | {fmt_pct(data['line'])} | {fmt_pct(data['branch'])} "
            f"| {fmt_pct(data['method'])} | {covered_cell} |"
        )
    lines.append(f"| **Overall** | **{fmt_pct(overall)}** | | | "
                 f"**{overall_covered:,} / {overall_coverable:,}** |")
    lines.append("")
    lines.append("## Browsable reports")
    lines.append("")
    lines.append("Each suite links to a full per-file, line-by-line HTML report:")
    lines.append("")
    for slug, label, data in rows:
        if data is None:
            lines.append(f"- {label} — _no report for this version_")
        else:
            lines.append(f"- [{label}]({args.report_base}/{slug}/index.html)")
    lines.append("")
    footer = f"_Generated {generated}"
    if commit_short:
        footer += f" from commit `{commit_short}`"
    footer += "._"
    lines.append(footer)
    lines.append("")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))

    print(f"Wrote {args.out} ({overall_coverable:,} coverable lines across "
          f"{sum(1 for _, _, d in rows if d)} suite(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())

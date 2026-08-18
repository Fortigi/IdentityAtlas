#!/usr/bin/env python3
"""Merge a package's Stryker reports into the mutation.json the coverage docs read.

`tools/generate-coverage-doc.py` surfaces a Mutation column per suite from
``docs/coverage/<slug>/mutation.json``, in the shape PSMutant emits
(``{mutationScore, killed, total, mutants:[{File, Status, ...}]}``). PowerShell has
had that column since ps-mutation.yml started publishing; the API and UI rows read
"-" because Stryker's JSON reporter emits a different shape (a per-file map of
mutant arrays, one report per Stryker config). This script is the adapter, run by
the weekly .github/workflows/js-mutation.yml after the four scopes finish.

WHY IT MERGES RATHER THAN PUBLISHING PER CONFIG: the docs page has one row per
suite, and app/api holds three Stryker configs (auth, effective access, account
linking). Publishing them separately would need three new rows describing arbitrary
slices of one suite; merging gives the suite the same single honest number the
PowerShell row has, and the per-scope detail is kept in ``scopes`` for anyone
reading the file.

WHICH REPORTS ARE REQUIRED IS DERIVED, NOT LISTED. Every ``stryker*.config.json``
in the package root names its own output in ``jsonReporter.fileName``, so the set
of reports this script demands comes from the configs themselves - add a fifth
config and the next run requires its report without anyone editing this file. A
missing report is a hard error rather than a quietly smaller merge: a merge that
silently drops a scope publishes a number measured over less code than the page
claims, which is the exact failure the scope note exists to prevent.

SCORE ARITHMETIC matches Stryker's own ``mutationScore``, so the published figure
agrees with the per-config ``break`` thresholds the workflow enforces: Killed and
Timeout count as detected, Survived and NoCoverage count as missed, and Ignored /
CompileError / RuntimeError are excluded from both - a mutant the runner never got
a verdict on is not evidence either way. NoCoverage counts as MISSED rather than
excluded: a mutant no test reaches is a fault nothing would catch, which is the
thing being measured.

Every generated mutant is emitted, including the ignored ones. They cost roughly
half the file size and buy correctness at the edge: generate-coverage-doc.py derives
the measured file set from the mutants' own ``File`` entries, so a file whose mutants
were all ignored (a string catalog under `excludedMutations`, say) would vanish from
that set and be reported as scope the score does not cover.

Usage:
    python3 tools/mutation/stryker_to_mutation_json.py \
        --package-dir app/api --out docs/coverage/api/mutation.json
"""
import argparse
import glob
import json
import os
import sys

# Stryker mutant status -> whether the tests detected the fault. Absent from both
# sets (Ignored, CompileError, RuntimeError) means "no verdict" and is excluded
# from the score entirely. Keep in step with Stryker's own mutationScore, which is
# what the per-config `break` thresholds are compared against.
DETECTED = {"Killed", "Timeout"}
MISSED = {"Survived", "NoCoverage"}


def stryker_configs(package_dir):
    """Every stryker*.config.json in a package root, sorted for stable output.

    Same discovery rule as app/api/src/mutationScope.guard.test.js, which derives
    the mutation-covered file set this way - one convention, not two lists."""
    return sorted(glob.glob(os.path.join(package_dir, "stryker*.config.json")))


def report_path(package_dir, config_path):
    """Where a Stryker config writes its JSON report, read from the config itself."""
    with open(config_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    name = (cfg.get("jsonReporter") or {}).get("fileName")
    if not name:
        raise SystemExit(
            f"{config_path} has no jsonReporter.fileName - the merge cannot know "
            "where its report lands. Add one, or drop the config."
        )
    return os.path.join(package_dir, name)


def read_mutants(path):
    """Flatten a Stryker report to ``[{File, Line, Status, Operator}, ...]``."""
    with open(path, "r", encoding="utf-8") as fh:
        report = json.load(fh)
    out = []
    for name, entry in sorted((report.get("files") or {}).items()):
        for mutant in entry.get("mutants") or []:
            start = (mutant.get("location") or {}).get("start") or {}
            out.append({
                "File": name,
                "Line": start.get("line"),
                "Status": mutant.get("status"),
                "Operator": mutant.get("mutatorName"),
            })
    return out


def tally(mutants):
    """(killed, survived) over a mutant list, using Stryker's own score rule."""
    killed = sum(1 for m in mutants if m["Status"] in DETECTED)
    survived = sum(1 for m in mutants if m["Status"] in MISSED)
    return killed, survived


def score(killed, survived):
    """Percentage detected, or None when nothing was measured - so an empty run
    publishes no number rather than a 0% or a 100% that both read as a verdict."""
    total = killed + survived
    return None if total == 0 else round(100.0 * killed / total, 2)


def merge(package_dir):
    """Merge every configured scope in a package into one PSMutant-shaped report."""
    configs = stryker_configs(package_dir)
    if not configs:
        raise SystemExit(f"No stryker*.config.json under {package_dir} - nothing to merge.")

    mutants, scopes, missing = [], [], []
    for config_path in configs:
        path = report_path(package_dir, config_path)
        if not os.path.isfile(path):
            missing.append(f"{os.path.basename(config_path)} -> {path}")
            continue
        found = read_mutants(path)
        killed, survived = tally(found)
        mutants.extend(found)
        scopes.append({
            "config": os.path.basename(config_path),
            "score": score(killed, survived),
            "killed": killed,
            "survived": survived,
        })

    if missing:
        raise SystemExit(
            "Missing Stryker report(s) - the merge would publish a score measured "
            "over less code than the docs page claims:\n  " + "\n  ".join(missing)
        )

    killed, survived = tally(mutants)
    return {
        "tool": "stryker",
        "mutationScore": score(killed, survived),
        "killed": killed,
        "survived": survived,
        "total": killed + survived,
        "scopes": scopes,
        "mutants": mutants,
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--package-dir", required=True,
                    help="Package root holding the stryker*.config.json files (e.g. app/api).")
    ap.add_argument("--out", required=True,
                    help="Where to write the merged report (e.g. docs/coverage/api/mutation.json).")
    args = ap.parse_args(argv)

    merged = merge(args.package_dir)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(merged, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print(f"[mutation] {args.package_dir}: {merged['mutationScore']}% "
          f"({merged['killed']} killed / {merged['total']}) across "
          f"{len(merged['scopes'])} scope(s) -> {args.out}")
    for entry in merged["scopes"]:
        detected = entry["killed"] + entry["survived"]
        print(f"           {entry['config']}: {entry['score']}% "
              f"({entry['killed']} killed / {detected})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

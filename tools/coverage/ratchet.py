#!/usr/bin/env python3
"""Per-file coverage ratchet — a committed line-coverage floor per source file so
an *existing* file can't quietly shed coverage.

Mirrors the file-length and complexity ratchets (tools/filesize, tools/complexity):
a committed baseline (.ci/coverage-baseline.json) records each measured file's
line-coverage percentage; CI then enforces, per file, that its coverage does not
fall below the baselined floor. The baseline only ever ratchets UP (--update).

Scope: the deterministic Vitest UNIT lcov (app/api + app/ui), so the measurement
matches locally and in CI (like the JS complexity ratchet). Contract/e2e coverage
— which needs a database — is intentionally out of scope; changed-line coverage is
the diff-coverage gate's job. This gate is the complementary "existing file didn't
regress" half.

Floors are stored as the floor() of the percentage (integer), giving ~1 point of
tolerance so a proportional refactor doesn't trip it while a real drop still does.

Usage:
  # check (CI) — only the files present in the given lcov are checked
  python tools/coverage/ratchet.py --lcov app/api/coverage/lcov.info --prefix app/api/
  python tools/coverage/ratchet.py --lcov app/ui/coverage/lcov.info  --prefix app/ui/

  # lock in an improvement: raises the floors in the given lcov, never lowers one
  # (other scopes' entries are preserved either way)
  python tools/coverage/ratchet.py --lcov app/api/coverage/lcov.info --prefix app/api/ --update

  # an intentional, reviewed DECREASE — the only way to move a floor down
  python tools/coverage/ratchet.py --lcov ... --prefix ... --update --allow-decrease

`--update` used to write every measured floor unconditionally, so a blanket run
lowered any file that happened to measure a point lower — silently weakening the
gate it exists to hold, and contradicting the "only ever ratchets UP" above. It
now refuses to lower a floor and reports each one it declined, so an improvement
can be locked in without reading the whole diff. Lowering is still possible, but
you have to ask for it.
"""
import argparse
import json
import math
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASELINE = os.path.join(REPO, ".ci", "coverage-baseline.json")

# Floors are stored one point below the measured floor(): the baseline is generated
# off-CI, and unit coverage — while deterministic per test — can wobble a line
# between platforms. This absorbs that (and a proportional refactor) while still
# failing on a real shed (a multi-point drop).
SAFETY_MARGIN = 1


def parse_lcov(path, prefix=""):
    """Return {repo_relative_path: (hit_lines, total_lines)} from an lcov report.
    lcov SF paths are package-relative (src/...); ``prefix`` (e.g. 'app/api/') makes
    the key repo-relative so API and UI entries never collide in one baseline."""
    files = {}
    cur, lf, lh = None, 0, 0
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if line.startswith("SF:"):
                cur, lf, lh = prefix + line[3:].replace("\\", "/"), 0, 0
            elif line.startswith("LF:"):
                lf = int(line[3:])
            elif line.startswith("LH:"):
                lh = int(line[3:])
            elif line == "end_of_record" and cur is not None:
                files[cur] = (lh, lf)
                cur = None
    return files


def pct(hit, total):
    return 100.0 * hit / total if total else 100.0


def floor_pct(hit, total):
    return math.floor(pct(hit, total))


def load_baseline():
    if not os.path.exists(BASELINE):
        return {}
    with open(BASELINE, encoding="utf-8") as fh:
        return json.load(fh).get("files", {})


def evaluate(measured, baseline):
    """Violation messages for baselined files whose current coverage fell below
    their floor. New files (not in the baseline) and zero-line files are skipped."""
    fails = []
    for path, (hit, total) in sorted(measured.items()):
        if total == 0 or path not in baseline:
            continue
        cur = pct(hit, total)
        floor = baseline[path]
        if cur < floor:
            fails.append(f"{path}: {cur:.1f}% line coverage - below its baselined "
                         f"floor ({floor}%). Add or restore tests for this file.")
    return fails


def write_baseline(baseline):
    os.makedirs(os.path.dirname(BASELINE), exist_ok=True)
    with open(BASELINE, "w", encoding="utf-8", newline="\n") as fh:
        json.dump({
            "_comment": ("Per-file line-coverage ratchet baseline (floor, integer percent). "
                         "Each source file's committed minimum; coverage may only rise. Only "
                         "ever raised (python tools/coverage/ratchet.py --lcov <f> --prefix <p> "
                         "--update). See the tool header."),
            "files": dict(sorted(baseline.items())),
        }, fh, indent=2)
        fh.write("\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--lcov", action="append", required=True,
                    help="lcov report to read (repeatable; e.g. app/api/coverage/lcov.info)")
    ap.add_argument("--prefix", default="",
                    help="prepended to lcov SF paths to make keys repo-relative (e.g. 'app/api/')")
    ap.add_argument("--update", action="store_true",
                    help="raise the floors for the files in the given lcov; never lowers one "
                         "(preserves other scopes)")
    ap.add_argument("--allow-decrease", action="store_true",
                    help="with --update: permit floors to move DOWN, for an intentional, "
                         "reviewed decrease. Each one is printed.")
    args = ap.parse_args(argv)
    if args.allow_decrease and not args.update:
        ap.error("--allow-decrease only means something with --update")

    measured = {}
    for lc in args.lcov:
        measured.update(parse_lcov(lc, args.prefix))

    baseline = load_baseline()

    if args.update:
        raised, added, declined, lowered = 0, 0, [], []
        for path, (hit, total) in measured.items():
            if total <= 0:
                continue
            new = max(0, floor_pct(hit, total) - SAFETY_MARGIN)
            old = baseline.get(path)
            if old is None:
                baseline[path] = new
                added += 1
            elif new > old:
                baseline[path] = new
                raised += 1
            elif new < old:
                # A ratchet that re-baselines downward is not a ratchet. Hold the floor unless the
                # decrease was asked for explicitly — a blanket --update after adding tests must not
                # quietly give back ground somewhere else because one file measured a point lower.
                if args.allow_decrease:
                    baseline[path] = new
                    lowered.append((path, old, new))
                else:
                    declined.append((path, old, new))
        write_baseline(baseline)
        print(f"Updated coverage baseline from {', '.join(args.lcov)}: "
              f"{raised} raised, {added} added, {len(declined) + len(lowered)} below their floor.")
        for path, old, new in lowered:
            print(f"  LOWERED {path}: {old}% -> {new}% (--allow-decrease)")
        for path, old, new in declined:
            print(f"  kept {path} at {old}% (measured {new}%) — re-run with --allow-decrease to lower it")
        return 0

    fails = evaluate(measured, baseline)
    checked = sum(1 for p in measured if p in baseline)
    print(f"[coverage] checked {checked} baselined file(s) from {', '.join(args.lcov)}.")
    if fails:
        print(f"Per-file coverage ratchet FAILED: {len(fails)} file(s) below their floor. "
              f"Add tests, or - only for an intentional, reviewed decrease - re-baseline with "
              f"--update --allow-decrease (plain --update will refuse to lower a floor).")
        for msg in fails:
            print(f"::error::Coverage ratchet: {msg}")
        return 1
    print("Per-file coverage ratchet OK - no file dropped below its floor.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

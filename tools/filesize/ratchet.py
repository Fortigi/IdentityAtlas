#!/usr/bin/env python3
"""File-length ratchet — enforces the CLAUDE.md rule that a source file past
~1000 lines "must be broken into focused files/functions before more is added
to it."

Mirrors the cyclomatic/cognitive complexity ratchet (tools/complexity/ratchet.py):
every source file currently over the ceiling is grandfathered into a committed
baseline (.ci/filesize-baseline.json). CI then enforces, per file:
  - a grandfathered file may only SHRINK (its line count must not exceed the
    baselined value);
  - a new file, or a file that crosses the ceiling for the first time, must be
    at or under the ceiling.
The baseline only ever ratchets DOWN (via --update).

Usage:
  python tools/filesize/ratchet.py            # check (CI)
  python tools/filesize/ratchet.py --update   # re-baseline from current sources
"""
import argparse
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASELINE = os.path.join(REPO, ".ci", "filesize-baseline.json")
CEILING = 1000
SMELL = 600   # CLAUDE.md "smell" threshold — a soft heads-up (warning), never a failure.
EXTS = (".ps1", ".js", ".jsx", ".sql")
# Substrings marking a path as out of scope: vendored, build output, generated,
# and test files (tests legitimately grow as cases are added; the rule is about
# source maintainability). test/ (harness scripts) is excluded by prefix below.
EXCLUDE = (
    "node_modules/", "/dist", "dist-frontend", "dist-node-launcher",
    "bundled-scripts/", "coverage/", "docs/coverage", "/site/",
    "app-bundle.mjs", ".test.", ".Tests.", "/e2e/",
)


def tracked_source():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=REPO,
                         capture_output=True, text=True, check=True).stdout
    for p in out.split("\0"):
        if not p or not p.endswith(EXTS):
            continue
        if p.startswith("test/"):          # PowerShell test-harness scripts, not source
            continue
        if any(x in p for x in EXCLUDE):
            continue
        yield p


def line_count(path):
    with open(os.path.join(REPO, path), "rb") as f:
        return sum(1 for _ in f)


def measure():
    return {p: line_count(p) for p in tracked_source()}


def over_ceiling(sizes):
    return {p: n for p, n in sizes.items() if n > CEILING}


def smelly(sizes, baseline):
    """Tracked files in the (SMELL, CEILING] band that aren't already grandfathered
    over the ceiling — a heads-up to split them before they cross it. Not a failure."""
    return {p: n for p, n in sizes.items() if SMELL < n <= CEILING and p not in baseline}


def load_baseline():
    if not os.path.exists(BASELINE):
        return {}
    with open(BASELINE, encoding="utf-8") as f:
        return json.load(f).get("files", {})


def evaluate(over, baseline):
    """Return the list of violation messages (empty == pass)."""
    fails = []
    for p, n in sorted(over.items()):
        if p in baseline:
            if n > baseline[p]:
                fails.append(f"{p}: {n} lines - grew past its grandfathered ceiling "
                             f"({baseline[p]}). Split it into focused files; do not add to it.")
        else:
            fails.append(f"{p}: {n} lines - new file over the {CEILING}-line ceiling. "
                         f"Split it into focused files/functions.")
    return fails


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--update", action="store_true",
                    help="re-baseline: record current over-ceiling files (ratchets down only)")
    args = ap.parse_args()

    sizes = measure()
    over = over_ceiling(sizes)

    if args.update:
        os.makedirs(os.path.dirname(BASELINE), exist_ok=True)
        with open(BASELINE, "w", encoding="utf-8") as f:
            json.dump({
                "_comment": ("File-length ratchet baseline. Files currently over the "
                             "ceiling; each may only shrink. Only ever lowered "
                             "(python tools/filesize/ratchet.py --update). See the tool header."),
                "ceiling": CEILING,
                "files": dict(sorted(over.items())),
            }, f, indent=2)
            f.write("\n")
        print(f"Wrote baseline: {len(over)} file(s) over {CEILING} lines.")
        return 0

    baseline = load_baseline()
    fails = evaluate(over, baseline)
    print(f"[filesize] {len(over)} file(s) over {CEILING} lines "
          f"({len(baseline)} grandfathered).")
    # Soft 'smell' heads-up (never fails the gate): files creeping toward the ceiling.
    for p, n in sorted(smelly(sizes, baseline).items()):
        print(f"::warning file={p}::{p} is {n} lines, over the {SMELL}-line smell "
              f"threshold — split it before it reaches the {CEILING}-line ceiling.")
    if fails:
        print(f"File-length ratchet FAILED: {len(fails)} violation(s). Split the file(s), "
              f"or - only for an intentional, reviewed increase - re-baseline with: "
              f"python tools/filesize/ratchet.py --update")
        for msg in fails:
            print(f"::error::File-length ratchet: {msg}")
        return 1
    print("File-length ratchet OK - no file exceeds its ceiling.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

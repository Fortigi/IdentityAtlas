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
The baseline only ever ratchets DOWN: `--update` shrinks a grandfathered entry and
drops a file that is back under the ceiling, but will not raise a ceiling or
grandfather a new oversized file — that needs `--update --allow-increase`, which
prints each one. It used to write the current measurement verbatim, so a file that
GREW was silently re-baselined at the worse value.

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


def merge_baseline(over, baseline, allow_increase=False):
    """Fold a fresh measurement into the committed baseline in the improving direction only.

    Returns (merged, shrunk, dropped, held) where `held` lists the (path, baselined, measured)
    the merge refused to worsen. `--update` used to write `over` verbatim, so a file that GREW
    past its grandfathered size — or a brand-new file over the ceiling — was silently re-baselined
    at the worse value, which is the opposite of "only ever ratchets DOWN".

    Improving moves, always taken:
      - a grandfathered file that shrank      -> record the smaller number
      - a grandfathered file now at/under the ceiling -> drop it; it is no longer an exception
    Worsening moves, only with allow_increase:
      - a grandfathered file that grew        -> raise its ceiling
      - a new file over the ceiling           -> grandfather it
    """
    merged, shrunk, held = dict(baseline), 0, []
    for p, n in sorted(over.items()):
        old = baseline.get(p)
        if old == n:
            continue                       # unchanged
        if old is not None and n < old:
            merged[p] = n                  # shrank — always take it
            shrunk += 1
            continue
        if allow_increase:                 # grew, or newly over the ceiling
            merged[p] = n
            continue
        held.append((p, old, n))

    # Back under the ceiling — stop grandfathering it.
    gone = [p for p in merged if p not in over]
    for p in gone:
        del merged[p]
    return merged, shrunk, len(gone), held


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
                    help="re-baseline: shrink grandfathered entries and drop files back under the "
                         "ceiling. Never raises a ceiling or grandfathers a new file.")
    ap.add_argument("--allow-increase", action="store_true",
                    help="with --update: also raise a ceiling / grandfather a new oversized file, "
                         "for an intentional, reviewed increase. Each one is printed.")
    args = ap.parse_args()
    if args.allow_increase and not args.update:
        ap.error("--allow-increase only means something with --update")

    sizes = measure()
    over = over_ceiling(sizes)

    if args.update:
        merged, shrunk, dropped, held = merge_baseline(
            over, load_baseline(), allow_increase=args.allow_increase)
        os.makedirs(os.path.dirname(BASELINE), exist_ok=True)
        with open(BASELINE, "w", encoding="utf-8") as f:
            json.dump({
                "_comment": ("File-length ratchet baseline. Files currently over the "
                             "ceiling; each may only shrink. Only ever lowered "
                             "(python tools/filesize/ratchet.py --update). See the tool header."),
                "ceiling": CEILING,
                "files": dict(sorted(merged.items())),
            }, f, indent=2)
            f.write("\n")
        print(f"Wrote baseline: {len(merged)} file(s) over {CEILING} lines "
              f"({shrunk} shrunk, {dropped} dropped, {len(held)} not worsened).")
        for p, old, n in held:
            was = f"{old} lines" if old is not None else "not grandfathered"
            verb = "kept" if old is not None else "did NOT grandfather"
            print(f"  {verb} {p} ({was}; measured {n}) — "
                  f"re-run with --allow-increase to accept it")
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

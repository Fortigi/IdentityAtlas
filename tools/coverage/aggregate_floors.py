#!/usr/bin/env python3
"""Aggregate coverage ratchet: raise a Vitest config's `coverage.thresholds`
to what the suite now measures, never lower them.

The per-file floors (.ci/coverage-baseline.json, tools/coverage/ratchet.py) rise
on their own after every merge. The aggregate floors in app/api/vitest.config.js
and app/ui/vite.config.js used to be raised by hand, and in practice were not:
by Nov 2026 they sat 20+ points under the measured numbers, so a change could
drop a quarter of the coverage and still pass. coverage.yml now runs this after
main's unit suites, with the same rule the per-file ratchet uses.

Rule, per metric (statements / branches / functions / lines):

    new floor = max(current floor, floor(measured - margin))

so a floor only moves up, and only by whole points, and stays `margin` points
under the measurement to absorb run-to-run variance. A failed or partial run can
only measure LESS (vitest writes no report on a failed run, and `include` counts
unexercised files as 0%), so it raises nothing and never weakens the gate.

Usage:
  python tools/coverage/aggregate_floors.py \
      --config app/api/vitest.config.js \
      --summary app/api/coverage/coverage-summary.json [--margin 2]

Reads `total.<metric>.pct` from vitest's `json-summary` reporter. Exit 0 always
when inputs are readable (raised or not; it prints what it did), 2 when the
config has no recognisable thresholds block, so a reformatted config is noticed
instead of silently never ratcheting again.
"""
import argparse
import json
import math
import re
import sys

METRICS = ("statements", "branches", "functions", "lines")

# `thresholds: { ... }` — the block holds only `metric: number,` entries, so the
# first closing brace ends it.
_BLOCK = re.compile(r"(thresholds:\s*\{)([^}]*)(\})")


def read_thresholds(text):
    """{metric: number} from the config's thresholds block, or None if absent."""
    m = _BLOCK.search(text)
    if not m:
        return None
    found = {}
    for metric in METRICS:
        mm = re.search(r"\b%s:\s*(\d+(?:\.\d+)?)" % metric, m.group(2))
        if mm:
            found[metric] = float(mm.group(1))
    return found


def raised_floors(current, measured, margin):
    """{metric: new floor} for each metric whose floor should go up."""
    out = {}
    for metric, floor in current.items():
        pct = measured.get(metric)
        if not isinstance(pct, (int, float)) or isinstance(pct, bool):
            continue  # vitest writes "Unknown" when a metric has no items
        candidate = math.floor(pct - margin)
        if candidate > floor:
            out[metric] = candidate
    return out


def apply_floors(text, floors):
    """Rewrite the thresholds block with the given floors; other text untouched."""
    def block(m):
        body = m.group(2)
        for metric, value in floors.items():
            body = re.sub(r"(\b%s:\s*)\d+(?:\.\d+)?" % metric, r"\g<1>%d" % value, body, count=1)
        return m.group(1) + body + m.group(3)
    return _BLOCK.sub(block, text, count=1)


def measured_totals(summary):
    total = summary.get("total", {})
    return {k: total.get(k, {}).get("pct") for k in METRICS}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--config", required=True)
    ap.add_argument("--summary", required=True)
    ap.add_argument("--margin", type=float, default=2.0)
    args = ap.parse_args(argv)

    with open(args.config, encoding="utf-8") as f:
        text = f.read()
    current = read_thresholds(text)
    if not current:
        print(f"::error::{args.config}: no coverage `thresholds: {{ ... }}` block found")
        return 2
    with open(args.summary, encoding="utf-8") as f:
        measured = measured_totals(json.load(f))

    raised = raised_floors(current, measured, args.margin)
    if not raised:
        print(f"{args.config}: floors unchanged ({_fmt(current)}; measured {_fmt(measured)})")
        return 0
    with open(args.config, "w", encoding="utf-8", newline="\n") as f:
        f.write(apply_floors(text, raised))
    for metric, value in raised.items():
        print(f"{args.config}: {metric} floor {current[metric]:g} -> {value} (measured {measured[metric]})")
    return 0


def _fmt(d):
    return " ".join(f"{k[0].upper()}{v}" for k, v in d.items())


if __name__ == "__main__":
    sys.exit(main())

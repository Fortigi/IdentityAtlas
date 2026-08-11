#!/usr/bin/env python3
"""Complexity ratchet for PowerShell, JS/TS and Python — cyclomatic AND cognitive.

A *ratchet*, not an absolute gate: every unit (function, plus each PowerShell
script/module body) currently over its language threshold is grandfathered into a
committed baseline. CI then enforces, per file: no unit may exceed its grandfathered
ceiling (complexity can only fall), and a new / newly-over-threshold unit must be
<= the language threshold. The baseline only ever ratchets DOWN: `--update` lowers a
ceiling and drops a file that is no longer over threshold, but will not raise one or
grandfather a newly over-threshold unit — that needs `--update --allow-increase`, which
prints each one. It used to rebuild the baseline from the current measurement, so a unit
that got MORE complex was silently re-baselined at the worse value.

Two independent metrics, each with its own baseline, selected with --metric:

  cyclomatic  (default)  — number of independent paths; every branch counts equally.
      Thresholds  PowerShell 15 · Python 15 · JS/TS 20   (JS looser; tighten later)
      Baseline    .ci/complexity-baseline.json

  cognitive              — how hard the code is to *follow* (SonarSource model):
      nesting-weighted (a branch 3 levels deep costs 4, not 1), else-if chains read
      flat, a switch counts once, a run of the same boolean operator counts once.
      Thresholds  PowerShell 15 · Python 15 · JS/TS 15   (the SonarSource S3776 default)
      Baseline    .ci/cognitive-baseline.json

Measurers (both metrics in one pass):
  * PowerShell  - tools/complexity/measure_ps.ps1 (AST; functions + <script-body>)
  * Python      - this file (ast; functions + <module>)
  * JS/TS       - ESLint: the built-in `complexity` rule (cyclomatic) and
                  eslint-plugin-sonarjs's `sonarjs/cognitive-complexity` (cognitive)

Usage:
  python tools/complexity/ratchet.py                       # cyclomatic check (CI gate)
  python tools/complexity/ratchet.py --update              # re-baseline cyclomatic
  python tools/complexity/ratchet.py --metric cognitive    # cognitive check
  python tools/complexity/ratchet.py --metric cognitive --update
"""
import argparse
import ast
import glob
import json
import os
import re
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Per-metric config: the unit field to gate, the language thresholds, the languages
# that participate, and the baseline file. cyclomatic is the default (unchanged CI).
METRICS = {
    "cyclomatic": {
        "field": "cc",
        "thresholds": {"ps": 15, "py": 15, "js": 20},
        "langs": ("ps", "py", "js"),
        "baseline": os.path.join(REPO, ".ci", "complexity-baseline.json"),
        "label": "cyclomatic complexity",
    },
    "cognitive": {
        "field": "cog",
        "thresholds": {"ps": 15, "py": 15, "js": 15},
        "langs": ("ps", "py", "js"),
        "baseline": os.path.join(REPO, ".ci", "cognitive-baseline.json"),
        "label": "cognitive complexity",
    },
}

# Paths never measured: dependencies, build output, and the generated bundled-scripts
# mirror (a copy of tools/** that is regenerated for the API image).
EXCLUDE = ("node_modules/", "/dist", "dist-node-launcher/", "bundled-scripts/")


def relpath(p):
    return os.path.relpath(p, REPO).replace(os.sep, "/")


# ─── PowerShell (measure_ps.ps1 emits cc + cog) ──────────────────────────────
def measure_ps():
    script = os.path.join(REPO, "tools", "complexity", "measure_ps.ps1")
    exe = shutil.which("pwsh") or shutil.which("powershell")
    if not exe:
        print("warning: pwsh not found - skipping PowerShell", file=sys.stderr)
        return []
    out = subprocess.run([exe, "-NoProfile", "-File", script], cwd=REPO,
                         capture_output=True, text=True)
    if out.returncode != 0:
        print("warning: measure_ps.ps1 failed:\n" + out.stderr[:800], file=sys.stderr)
        return []
    txt = out.stdout.strip()
    data = json.loads(txt) if txt else []
    if isinstance(data, dict):
        data = [data]
    return [dict(file=u["file"], unit=u["unit"], line=u["line"],
                 cc=u["cc"], cog=u.get("cog"), lang="ps") for u in data]


# ─── Python (cyclomatic + cognitive, one parse) ──────────────────────────────
def _py_cyclomatic(tree):
    """{unit-key: ((name, line), cc)} — every branch counts equally (+1 base)."""
    counts, names, stack = {}, {}, []

    def here():
        return stack[-1] if stack else "<module>"

    def bump(n=1):
        counts[here()] = counts.get(here(), 0) + n

    class V(ast.NodeVisitor):
        def _fn(self, node):
            key = f"{node.name}@{node.lineno}"
            counts.setdefault(key, 0)
            names[key] = (node.name, node.lineno)
            stack.append(key)
            self.generic_visit(node)
            stack.pop()
        visit_FunctionDef = _fn
        visit_AsyncFunctionDef = _fn

        def visit_If(self, n): bump(); self.generic_visit(n)
        def visit_For(self, n): bump(); self.generic_visit(n)
        def visit_AsyncFor(self, n): bump(); self.generic_visit(n)
        def visit_While(self, n): bump(); self.generic_visit(n)
        def visit_ExceptHandler(self, n): bump(); self.generic_visit(n)
        def visit_IfExp(self, n): bump(); self.generic_visit(n)
        def visit_BoolOp(self, n): bump(len(n.values) - 1); self.generic_visit(n)
        def visit_comprehension(self, n): bump(1 + len(n.ifs)); self.generic_visit(n)

    counts.setdefault("<module>", 0)
    names["<module>"] = ("<module>", 1)
    V().visit(tree)
    return {k: (names.get(k, (k, 1)), v + 1) for k, v in counts.items()}


class _PyCognitive(ast.NodeVisitor):
    """Cognitive complexity per unit — nesting-weighted; else-if flat; boolean runs.

    Mirrors the SonarSource model and the PowerShell measurer: a structure that
    introduces nesting (if / ternary / loop / except / lambda / comprehension) adds
    +1 for each enclosing nesting level; else / elif get a flat +1; each BoolOp node
    (Python already groups a run of one operator into a single node) is +1.

    Dispatch is `_<NodeType>` methods; anything without one just recurses its children
    at the same depth (via `_recurse`).
    """

    def run(self, tree):
        self.scores = {"<module>": 0}
        self.names = {"<module>": ("<module>", 1)}
        self._recurse(tree, "<module>", 0)
        return {k: (self.names.get(k, (k, 1)), v) for k, v in self.scores.items()}

    def handle(self, node, unit, depth):
        m = getattr(self, "_" + type(node).__name__, None)
        (m or self._recurse)(node, unit, depth)

    def _recurse(self, node, unit, depth):
        for c in ast.iter_child_nodes(node):
            self.handle(c, unit, depth)

    def _FunctionDef(self, node, unit, depth):
        key = f"{node.name}@{node.lineno}"
        self.scores.setdefault(key, 0)
        self.names[key] = (node.name, node.lineno)
        for c in node.body:
            self.handle(c, key, 0)
    _AsyncFunctionDef = _FunctionDef

    def _If(self, node, unit, depth):
        self.scores[unit] += 1 + depth          # the `if`: +1 + nesting
        self.handle(node.test, unit, depth)
        for c in node.body:
            self.handle(c, unit, depth + 1)
        orelse = node.orelse
        while orelse:
            is_elif = len(orelse) == 1 and isinstance(orelse[0], ast.If)
            self.scores[unit] += 1              # elif / else: flat +1, no nesting
            branch = orelse[0] if is_elif else None
            if branch:
                self.handle(branch.test, unit, depth)
            body = branch.body if branch else orelse
            for c in body:
                self.handle(c, unit, depth + 1)
            orelse = branch.orelse if branch else []

    def _While(self, node, unit, depth):
        self.scores[unit] += 1 + depth
        self.handle(node.test, unit, depth)
        self._loop_body(node, unit, depth)

    def _For(self, node, unit, depth):
        self.scores[unit] += 1 + depth
        self.handle(node.iter, unit, depth)
        self._loop_body(node, unit, depth)
    _AsyncFor = _For

    def _loop_body(self, node, unit, depth):
        for c in node.body:
            self.handle(c, unit, depth + 1)
        for c in node.orelse:
            self.handle(c, unit, depth)

    def _ExceptHandler(self, node, unit, depth):
        self.scores[unit] += 1 + depth
        for c in node.body:
            self.handle(c, unit, depth + 1)

    def _IfExp(self, node, unit, depth):        # ternary
        self.scores[unit] += 1 + depth
        self.handle(node.test, unit, depth)
        self.handle(node.body, unit, depth + 1)
        self.handle(node.orelse, unit, depth + 1)

    def _BoolOp(self, node, unit, depth):       # one node == one operator run
        self.scores[unit] += 1
        for v in node.values:
            self.handle(v, unit, depth)

    def _Lambda(self, node, unit, depth):
        self.handle(node.body, unit, depth + 1)

    def _comp(self, node, unit, depth):
        self.scores[unit] += 1 + depth
        for gen in node.generators:
            self.handle(gen.iter, unit, depth)
            for cond in gen.ifs:
                self.scores[unit] += 1
                self.handle(cond, unit, depth)
        for f in ("elt", "key", "value"):
            sub = getattr(node, f, None)
            if sub is not None:
                self.handle(sub, unit, depth + 1)
    _ListComp = _comp
    _SetComp = _comp
    _GeneratorExp = _comp
    _DictComp = _comp


def _py_cognitive(tree):
    return _PyCognitive().run(tree)


def measure_py():
    units = []
    for f in glob.glob(os.path.join(REPO, "**", "*.py"), recursive=True):
        r = relpath(f)
        if any(x in r for x in EXCLUDE):
            continue
        base = os.path.basename(f)
        if base.startswith("test_") or base.endswith("_test.py") or base == "conftest.py":
            continue   # test files are not production code — same as .Tests.ps1 for PowerShell
        try:
            with open(f, encoding="utf-8") as fh:
                tree = ast.parse(fh.read())
        except (SyntaxError, UnicodeDecodeError):
            continue
        cyc = _py_cyclomatic(tree)
        cog = _py_cognitive(tree)
        for k, ((name, line), cc) in cyc.items():
            units.append(dict(file=r, unit=name, line=line, cc=cc,
                              cog=cog.get(k, (None, 0))[1], lang="py"))
    return units


# ─── JS / TS (ESLint: `complexity` = cyclomatic, sonarjs = cognitive) ─────────
# Both metrics come from ONE eslint pass by injecting both rules. The core
# `complexity` message names the function ("Function 'foo' has a complexity of
# 21"); the sonarjs message does not ("Refactor this function to reduce its
# Cognitive Complexity from 19 to the 15 allowed"), so a cognitive unit borrows
# the cyclomatic message's name when one landed on the same line.
_JS_CC_RE = re.compile(r"complexity of (\d+)")
_JS_COG_RE = re.compile(r"Cognitive Complexity from (\d+)")


def parse_js_units(file_rel, messages):
    """One file's ESLint messages -> ratchet units (pure; unit-tested).

    Cyclomatic and cognitive findings become separate units — the two metrics
    have independent baselines, and a function can breach one without the other.
    A cyclomatic unit carries cc (cog=None); a cognitive unit carries cog
    (cc=None) and reuses the same-line function name if the cyclomatic rule also
    fired there, else falls back to a line label.
    """
    names = {}
    for m in messages:
        if m.get("ruleId") == "complexity" and _JS_CC_RE.search(m.get("message", "")):
            names[m.get("line")] = m["message"].split(" has a complexity")[0].strip()
    units = []
    for m in messages:
        rid, msg, line = m.get("ruleId"), m.get("message", ""), m.get("line")
        if rid == "complexity":
            mt = _JS_CC_RE.search(msg)
            if mt:
                units.append(dict(file=file_rel, unit=msg.split(" has a complexity")[0].strip(),
                                  line=line, cc=int(mt.group(1)), cog=None, lang="js"))
        elif rid == "sonarjs/cognitive-complexity":
            mt = _JS_COG_RE.search(msg)
            if mt:
                units.append(dict(file=file_rel, unit=names.get(line) or f"function (line {line})",
                                  line=line, cc=None, cog=int(mt.group(1)), lang="js"))
    return units


def _eslint_json(sub, rule):
    """Run ESLint over <sub>/src with the given --rule JSON; return the parsed
    report array (or None if npx / node_modules / output is unavailable)."""
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        print("warning: npx not found - skipping JS/TS", file=sys.stderr)
        return None
    d = os.path.join(REPO, sub)
    if not os.path.isdir(os.path.join(d, "node_modules")):
        print(f"warning: {sub}/node_modules missing - skipping its JS", file=sys.stderr)
        return None
    out = subprocess.run([npx, "eslint", "src", "--rule", rule, "--format", "json"],
                         cwd=d, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if not out.stdout.strip():
        print(f"warning: eslint produced no output for {sub}:\n{out.stderr[:400]}", file=sys.stderr)
        return None
    return json.loads(out.stdout)


def measure_js():
    rule = json.dumps({
        "complexity": ["warn", METRICS["cyclomatic"]["thresholds"]["js"]],
        "sonarjs/cognitive-complexity": ["warn", METRICS["cognitive"]["thresholds"]["js"]],
    })
    units = []
    for sub in ("app/api", "app/ui"):
        report = _eslint_json(sub, rule)
        for fobj in report or []:
            units.extend(parse_js_units(relpath(fobj["filePath"]), fobj.get("messages", [])))
    return units


# ─── JS/TS full measurement (for the coverage docs, NOT the gate) ─────────────
# The gate's measure_js only surfaces over-threshold outliers (ESLint reports a
# rule only when it's breached). The coverage page instead wants avg/max over
# EVERY function, so we run both rules at threshold 0: the cyclomatic rule then
# reports every function (cc >= 1 always), and cognitive is merged in by line,
# defaulting to 0 for a straight-line function the cognitive rule doesn't flag.
_JS_TEST_RE = re.compile(r"(?:\.test\.|\.spec\.|/__tests__/|/e2e/|/test-utils/)")


def merge_js_units(file_rel, messages):
    """One unit per function carrying BOTH cc and cog (cog defaults to 0). Keyed
    off the cyclomatic messages (one per function); pure, so it's unit-tested."""
    cog_by_line = {}
    for m in messages:
        if m.get("ruleId") == "sonarjs/cognitive-complexity":
            mt = _JS_COG_RE.search(m.get("message", ""))
            if mt:
                cog_by_line[m.get("line")] = int(mt.group(1))
    units = []
    for m in messages:
        if m.get("ruleId") == "complexity":
            mt = _JS_CC_RE.search(m.get("message", ""))
            if mt:
                units.append(dict(file=file_rel, unit=m["message"].split(" has a complexity")[0].strip(),
                                  line=m.get("line"), cc=int(mt.group(1)),
                                  cog=cog_by_line.get(m.get("line"), 0)))
    return units


def measure_js_all_units(sub):
    """Every product function in <sub>/src as {file,unit,line,cc,cog} — feeds the
    coverage docs' avg/max columns. Test files are excluded (product code only,
    matching the PowerShell measurer)."""
    rule = json.dumps({"complexity": ["warn", 0], "sonarjs/cognitive-complexity": ["warn", 0]})
    units = []
    for fobj in _eslint_json(sub, rule) or []:
        fr = relpath(fobj["filePath"])
        if not _JS_TEST_RE.search("/" + fr):
            units.extend(merge_js_units(fr, fobj.get("messages", [])))
    return units


# ─── Ratchet (metric-parameterised) ──────────────────────────────────────────
def over_threshold(units, metric):
    """file -> list of (unit, value) over the language threshold, for this metric."""
    field, thresholds, langs = metric["field"], metric["thresholds"], metric["langs"]
    out = {}
    for u in units:
        if u["lang"] not in langs:
            continue
        val = u.get(field)
        if val is None:
            continue
        if val > thresholds[u["lang"]]:
            out.setdefault(u["file"], []).append((u, val))
    return out


def build_baseline(over, metric):
    return build_baseline_from(
        {f: sorted((v for _, v in us), reverse=True) for f, us in over.items()}, metric)


def build_baseline_from(files, metric):
    """Wrap an already-merged {file: [values]} map in the baseline document shape."""
    return {
        "_comment": f"{metric['label'].capitalize()} ratchet baseline. Per file: the "
                    "sorted list of unit values over the language threshold. Only ever "
                    "lowered (--update). See tools/complexity/ratchet.py header.",
        "metric": metric["field"],
        "thresholds": metric["thresholds"],
        "files": dict(sorted(files.items())),
    }


def merge_baseline(over, baseline_files, allow_increase=False):
    """Fold a fresh measurement into the committed per-file lists, improving direction only.

    `--update` used to write `build_baseline(over)` verbatim, so a unit that got MORE complex —
    or a brand-new over-threshold unit — was silently re-baselined at the worse value, which is
    the opposite of "Only ever lowered". Re-baselining upward is not a ratchet.

    Each file's entry is the per-unit values over the threshold, sorted descending, and `check()`
    compares them position-wise. So the merge is position-wise too:
      - shorter measured list (fewer units over threshold) -> take it; that is an improvement
      - value lower at a position                          -> take it
      - value higher at a position, or an extra unit       -> hold the baseline, unless allowed
      - file no longer over threshold at all               -> drop it entirely

    Returns (merged, improved, dropped, held) where `held` lists (path, baselined, measured).
    """
    merged, improved, held = dict(baseline_files), 0, []
    for f, us in over.items():
        cur = sorted((v for _, v in us), reverse=True)
        base = sorted(baseline_files.get(f, []), reverse=True)
        if allow_increase:
            merged[f] = cur
            continue
        if not base:
            held.append((f, None, cur))     # a newly over-threshold file is a new exception
            continue
        new, worsened = _merge_values(cur, base)
        if worsened:
            held.append((f, base, cur))
        if new != base:
            merged[f] = new
            improved += 1

    # No unit over threshold any more — stop grandfathering the file.
    gone = [f for f in merged if f not in over]
    for f in gone:
        del merged[f]
    return merged, improved, len(gone), held


def _merge_values(cur, base):
    """One file's descending value lists -> (kept list, did the measurement get worse?).

    Position-wise, because that is how check() reads them: never a higher value at any rank,
    and never a longer list (an extra over-threshold unit is a new exception, not a ratchet).
    """
    keep = min(len(cur), len(base))
    new = [min(cur[i], base[i]) for i in range(keep)]
    worsened = len(cur) > len(base) or any(cur[i] > base[i] for i in range(keep))
    return new, worsened


def check(over, baseline_files, metric):
    """Return a list of (unit, value, ceiling) violations."""
    thresholds = metric["thresholds"]
    violations = []
    for f, us in over.items():
        cur = sorted(us, key=lambda uv: uv[1], reverse=True)
        base = sorted(baseline_files.get(f, []), reverse=True)
        for i, (u, val) in enumerate(cur):
            ceiling = base[i] if i < len(base) else thresholds[u["lang"]]
            if val > ceiling:
                violations.append((u, val, ceiling))
    return violations


def print_summary(args, metric, units, over):
    field, langs, thresholds = metric["field"], metric["langs"], metric["thresholds"]
    counted = [u for u in units if u["lang"] in langs and u.get(field) is not None]
    per_str = " ".join(f"{lang}={sum(1 for u in counted if u['lang'] == lang)}" for lang in langs)
    thr_str = " ".join(f"{lang}>{thresholds[lang]}" for lang in langs)
    n_over = sum(len(v) for v in over.values())
    print(f"[{args.metric}] Measured {len(counted)} units ({per_str}); "
          f"{n_over} over threshold ({thr_str}).")


def report_violations(args, metric, violations):
    thresholds, label = metric["thresholds"], metric["label"]
    for u, val, ceiling in sorted(violations, key=lambda x: x[1], reverse=True):
        why = ("exceeds this file's grandfathered ceiling"
               if ceiling > thresholds[u["lang"]] else
               f"is a new/over-threshold unit (max {ceiling} for {u['lang']})")
        print(f"::error file={u['file']},line={u['line']}::{label.capitalize()} "
              f"ratchet: {u['unit']} has {label} {val} - {why} ({ceiling}). "
              f"Refactor it down, or split it.")
    print(f"\n{label.capitalize()} ratchet FAILED: {len(violations)} unit(s) above "
          f"ceiling. Lower the complexity, or - only for an intentional, reviewed "
          f"increase - re-baseline with: python tools/complexity/ratchet.py "
          f"--metric {args.metric} --update", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="Complexity ratchet (cyclomatic / cognitive).")
    ap.add_argument("--metric", choices=list(METRICS), default="cyclomatic",
                    help="which complexity metric to gate (default: cyclomatic)")
    ap.add_argument("--update", action="store_true",
                    help="lower the baseline where complexity fell, and drop files no longer "
                         "over threshold. Never raises a ceiling or grandfathers a new unit.")
    ap.add_argument("--allow-increase", action="store_true",
                    help="with --update: also raise a ceiling / grandfather a newly over-threshold "
                         "unit, for an intentional, reviewed increase. Each one is printed.")
    ap.add_argument("--baseline", default=None, help="override the baseline path")
    ap.add_argument("--emit-complexity-json", metavar="WORKSPACE", default=None,
                    help="print the full per-unit {file,unit,line,cc,cog} JSON for one JS "
                         "workspace's src (e.g. app/api) and exit — feeds the coverage docs, "
                         "not the gate. Measures every function, not just over-threshold ones.")
    args = ap.parse_args()
    if args.allow_increase and not args.update:
        ap.error("--allow-increase only means something with --update")

    if args.emit_complexity_json:
        json.dump(measure_js_all_units(args.emit_complexity_json), sys.stdout)
        sys.stdout.write("\n")
        return 0

    metric = METRICS[args.metric]
    baseline_path = args.baseline or metric["baseline"]

    units = measure_ps() + measure_py() + measure_js()
    over = over_threshold(units, metric)
    print_summary(args, metric, units, over)

    if args.update:
        existing = {}
        if os.path.isfile(baseline_path):
            with open(baseline_path, encoding="utf-8") as fh:
                existing = json.load(fh).get("files", {})
        merged, improved, dropped, held = merge_baseline(
            over, existing, allow_increase=args.allow_increase)
        os.makedirs(os.path.dirname(baseline_path), exist_ok=True)
        with open(baseline_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(build_baseline_from(merged, metric), fh, indent=2)
            fh.write("\n")
        print(f"Wrote baseline: {relpath(baseline_path)} ({len(merged)} files; "
              f"{improved} improved, {dropped} dropped, {len(held)} not worsened).")
        for f, base, cur in held:
            was = base if base is not None else "not grandfathered"
            print(f"  kept {f} at {was} (measured {cur}) - "
                  f"re-run with --allow-increase to accept it")
        return 0

    if not os.path.isfile(baseline_path):
        print(f"ERROR: no baseline at {relpath(baseline_path)} - run with --update first.",
              file=sys.stderr)
        return 2
    with open(baseline_path, encoding="utf-8") as fh:
        baseline = json.load(fh).get("files", {})
    violations = check(over, baseline, metric)
    if not violations:
        print(f"{metric['label'].capitalize()} ratchet OK - no unit exceeds its ceiling.")
        return 0
    report_violations(args, metric, violations)
    return 1


if __name__ == "__main__":
    sys.exit(main())

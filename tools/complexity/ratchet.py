#!/usr/bin/env python3
"""Cyclomatic-complexity ratchet for PowerShell, JS/TS and Python.

A *ratchet*, not an absolute gate: every unit (function, plus each PowerShell
script/module body) that is currently over its language threshold is grandfathered
into a committed baseline (.ci/complexity-baseline.json). CI then enforces, per file:

  * no unit may exceed its grandfathered ceiling  (complexity can only fall), and
  * a new or newly-over-threshold unit must be <= the language threshold.

So the baseline can only ratchet DOWN. Nothing red-builds on adoption; the codebase
is squeezed toward "every unit <= 15" over time. Run with --update after a real
refactor to lock in the lower numbers.

Thresholds (the ceiling a new/clean unit must meet) differ by language because the
honest starting points differ: PowerShell and Python are close to clean per-function,
the JS app is not, so JS starts looser and is tightened later.

  PowerShell : 15        Python : 15        JS/TS : 20  (lower to 15 once squeezed)

Measurers:
  * PowerShell  - tools/complexity/measure_ps.ps1 (AST; functions + <script-body>)
  * Python      - this file (ast; functions + <module>)
  * JS/TS       - ESLint's built-in `complexity` rule (--format json)

Usage:
  python tools/complexity/ratchet.py            # check (CI gate); exit 1 on regression
  python tools/complexity/ratchet.py --update   # regenerate/lower the baseline
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
BASELINE_PATH = os.path.join(REPO, ".ci", "complexity-baseline.json")
THRESHOLDS = {"ps": 15, "py": 15, "js": 20}

# Paths never measured: dependencies, build output, and the generated bundled-scripts
# mirror (a copy of tools/** that is regenerated for the API image).
EXCLUDE = ("node_modules/", "/dist", "dist-node-launcher/", "bundled-scripts/")


def relpath(p):
    return os.path.relpath(p, REPO).replace(os.sep, "/")


# ─── PowerShell ──────────────────────────────────────────────────────────────
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
    return [dict(file=u["file"], unit=u["unit"], line=u["line"], cc=u["cc"], lang="ps")
            for u in data]


# ─── Python ──────────────────────────────────────────────────────────────────
def _py_units(tree):
    counts, names, stack = {}, {}, []

    def here():
        return stack[-1] if stack else "<module>"

    def bump(n=1):
        k = here()
        counts[k] = counts.get(k, 0) + n

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
    return [(names.get(k, (k, 1)), v + 1) for k, v in counts.items()]


def measure_py():
    units = []
    for f in glob.glob(os.path.join(REPO, "**", "*.py"), recursive=True):
        r = relpath(f)
        if any(x in r for x in EXCLUDE):
            continue
        try:
            tree = ast.parse(open(f, encoding="utf-8").read())
        except (SyntaxError, UnicodeDecodeError):
            continue
        for (name, line), cc in _py_units(tree):
            units.append(dict(file=r, unit=name, line=line, cc=cc, lang="py"))
    return units


# ─── JS / TS (ESLint complexity rule) ────────────────────────────────────────
def measure_js():
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        print("warning: npx not found - skipping JS/TS", file=sys.stderr)
        return []
    rule = json.dumps({"complexity": ["warn", THRESHOLDS["js"]]})
    units = []
    for sub in ("app/api", "app/ui"):
        d = os.path.join(REPO, sub)
        if not os.path.isdir(os.path.join(d, "node_modules")):
            print(f"warning: {sub}/node_modules missing - skipping its JS", file=sys.stderr)
            continue
        out = subprocess.run([npx, "eslint", "src", "--rule", rule, "--format", "json"],
                             cwd=d, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if not out.stdout.strip():
            print(f"warning: eslint produced no output for {sub}:\n{out.stderr[:400]}", file=sys.stderr)
            continue
        for fobj in json.loads(out.stdout):
            fr = relpath(fobj["filePath"])
            for m in fobj.get("messages", []):
                if m.get("ruleId") == "complexity":
                    mt = re.search(r"complexity of (\d+)", m["message"])
                    if mt:
                        unit = m["message"].split(" has a complexity")[0].strip()
                        units.append(dict(file=fr, unit=unit, line=m.get("line"),
                                          cc=int(mt.group(1)), lang="js"))
    return units


# ─── Ratchet ─────────────────────────────────────────────────────────────────
def over_threshold(units):
    """file -> list of unit dicts whose cc exceeds the language threshold."""
    out = {}
    for u in units:
        if u["cc"] > THRESHOLDS[u["lang"]]:
            out.setdefault(u["file"], []).append(u)
    return out


def build_baseline(over):
    files = {f: sorted((u["cc"] for u in us), reverse=True) for f, us in over.items()}
    return {
        "_comment": "Cyclomatic-complexity ratchet baseline. Per file: the sorted "
                    "list of unit CCs over the language threshold. Only ever lowered "
                    "(python tools/complexity/ratchet.py --update). See the tool header.",
        "thresholds": THRESHOLDS,
        "files": dict(sorted(files.items())),
    }


def check(over, baseline_files):
    """Return a list of (unit, ceiling) violations."""
    violations = []
    for f, us in over.items():
        cur = sorted(us, key=lambda u: u["cc"], reverse=True)
        base = sorted(baseline_files.get(f, []), reverse=True)
        for i, u in enumerate(cur):
            ceiling = base[i] if i < len(base) else THRESHOLDS[u["lang"]]
            if u["cc"] > ceiling:
                violations.append((u, ceiling))
    return violations


def main():
    ap = argparse.ArgumentParser(description="Cyclomatic-complexity ratchet.")
    ap.add_argument("--update", action="store_true", help="regenerate/lower the baseline")
    ap.add_argument("--baseline", default=BASELINE_PATH)
    args = ap.parse_args()

    units = measure_ps() + measure_py() + measure_js()
    over = over_threshold(units)
    n_over = sum(len(v) for v in over.values())
    per_lang = {lang: sum(1 for u in units if u["lang"] == lang) for lang in THRESHOLDS}
    print(f"Measured {len(units)} units (ps={per_lang['ps']} py={per_lang['py']} "
          f"js={per_lang['js']}); {n_over} over threshold "
          f"(ps>{THRESHOLDS['ps']} py>{THRESHOLDS['py']} js>{THRESHOLDS['js']}).")

    if args.update:
        os.makedirs(os.path.dirname(args.baseline), exist_ok=True)
        with open(args.baseline, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(build_baseline(over), fh, indent=2)
            fh.write("\n")
        print(f"Wrote baseline: {relpath(args.baseline)} ({len(over)} files).")
        return 0

    if not os.path.isfile(args.baseline):
        print(f"ERROR: no baseline at {relpath(args.baseline)} - run with --update first.",
              file=sys.stderr)
        return 2
    baseline = json.load(open(args.baseline, encoding="utf-8")).get("files", {})
    violations = check(over, baseline)
    if not violations:
        print("Complexity ratchet OK - no unit exceeds its ceiling.")
        return 0

    for u, ceiling in sorted(violations, key=lambda x: x[0]["cc"], reverse=True):
        why = ("exceeds this file's grandfathered ceiling"
               if ceiling > THRESHOLDS[u["lang"]] else
               f"is a new/over-threshold unit (max {ceiling} for {u['lang']})")
        print(f"::error file={u['file']},line={u['line']}::Complexity ratchet: "
              f"{u['unit']} has cyclomatic complexity {u['cc']} - {why} ({ceiling}). "
              f"Refactor it down, or split it.")
    print(f"\nComplexity ratchet FAILED: {len(violations)} unit(s) above ceiling. "
          f"Lower the complexity, or - only for an intentional, reviewed increase - "
          f"re-baseline with: python tools/complexity/ratchet.py --update", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

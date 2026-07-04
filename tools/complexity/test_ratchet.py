"""Unit tests for the complexity ratchet's Python measurers + gate logic.

Run:  python -m pytest tools/complexity/test_ratchet.py
"""
import ast
import importlib.util
import os

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("ratchet", os.path.join(_HERE, "ratchet.py"))
ratchet = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ratchet)


def _val(metric_fn, code, unit="f"):
    """Complexity value of `unit` (a function name, or '<module>') in `code`."""
    result = metric_fn(ast.parse(code))
    for (name, _line), v in result.values():
        if name == unit:
            return v
    raise AssertionError(f"unit {unit!r} not found in {list(n for (n, _), _ in result.values())}")


def cyc(code, unit="f"):
    return _val(ratchet._py_cyclomatic, code, unit)


def cog(code, unit="f"):
    return _val(ratchet._py_cognitive, code, unit)


# ─── Cyclomatic ──────────────────────────────────────────────────────────────
class TestCyclomatic:
    def test_straight_line_is_1(self):
        assert cyc("def f():\n    return 1") == 1

    def test_single_if_is_2(self):
        assert cyc("def f(a):\n    if a: return 1\n    return 0") == 2

    def test_if_elif_else_counts_both_branches(self):
        # if + elif each add a decision; else adds none -> 1 + 2 = 3.
        assert cyc("def f(a, b):\n    if a: pass\n    elif b: pass\n    else: pass") == 3

    def test_loops_add_one_each(self):
        assert cyc("def f(y):\n    for x in y:\n        while x: pass") == 3

    def test_boolean_operands_count_n_minus_1(self):
        assert cyc("def f(a, b, c):\n    return a and b and c") == 3   # 1 + (3-1)
        assert cyc("def f(a, b):\n    return a and b") == 2

    def test_except_and_comprehension(self):
        assert cyc("def f(y):\n    try:\n        pass\n    except ValueError:\n        pass") == 2
        assert cyc("def f(y):\n    return [x for x in y if x]") == 3   # comprehension +1, its if +1


# ─── Cognitive ───────────────────────────────────────────────────────────────
class TestCognitive:
    def test_straight_line_is_0(self):
        assert cog("def f():\n    return 1") == 0

    def test_single_if_is_1(self):
        assert cog("def f(a):\n    if a: return 1") == 1

    def test_nesting_is_weighted(self):
        # if (1) + nested if (1 + 1 nesting) = 3, not 2.
        assert cog("def f(a, b):\n    if a:\n        if b:\n            pass") == 3

    def test_else_if_chain_reads_flat(self):
        # if (1) + elif (flat +1) + else (flat +1) = 3 — no nesting penalty on the chain.
        assert cog("def f(a, b):\n    if a: pass\n    elif b: pass\n    else: pass") == 3

    def test_boolean_runs(self):
        assert cog("def f(a, b, c):\n    return a and b and c") == 1   # one run
        assert cog("def f(a, b, c):\n    return a and b or c") == 2    # two runs (and, or)

    def test_loop_and_nested_branch(self):
        # for (1) + if inside loop (1 + 1 nesting) = 3.
        assert cog("def f(y):\n    for x in y:\n        if x: pass") == 3

    def test_worked_example_is_11(self):
        code = (
            "def f(a, b, c, y, p, q, r):\n"
            "    if a:\n"                       # +1
            "        if b:\n"                   # +2
            "            for x in y:\n"         # +3
            "                print(x)\n"
            "        elif c:\n"                 # +1 flat
            "            pass\n"
            "        else:\n"                   # +1 flat
            "            pass\n"
            "    z = p and q and r\n"           # +1 (one run)
            "    w = p and q or r\n"            # +2 (and-run + or-run)
            "    return z, w\n"
        )
        assert cog(code) == 11

    def test_nested_function_is_its_own_unit(self):
        code = (
            "def outer(a):\n"
            "    if a: pass\n"                  # outer cog 1
            "    def inner(b):\n"
            "        if b:\n"
            "            if b: pass\n"          # inner: if(1) + nested if(2) = 3, reset nesting
            "    return inner\n"
        )
        assert cog(code, "outer") == 1
        assert cog(code, "inner") == 3


# ─── Divergence: cognitive punishes nesting that cyclomatic ignores ──────────
def test_same_cyclomatic_different_cognitive():
    flat = "def f(a, b, c):\n    if a: pass\n    if b: pass\n    if c: pass"
    nested = "def f(a, b, c):\n    if a:\n        if b:\n            if c: pass"
    assert cyc(flat) == cyc(nested) == 4          # 3 ifs each
    assert cog(flat) == 3                          # 1+1+1
    assert cog(nested) == 6                        # 1 + 2 + 3


# ─── Gate logic ──────────────────────────────────────────────────────────────
def _u(lang, cc, cog, file="x", unit="fn", line=1):
    return dict(file=file, unit=unit, line=line, cc=cc, cog=cog, lang=lang)


class TestGate:
    def test_over_threshold_uses_the_metric_field_and_langs(self):
        units = [_u("ps", cc=20, cog=5), _u("js", cc=25, cog=5), _u("py", cc=10, cog=30)]
        cyc_over = ratchet.over_threshold(units, ratchet.METRICS["cyclomatic"])
        cog_over = ratchet.over_threshold(units, ratchet.METRICS["cognitive"])
        # cyclomatic: ps 20>15 and js 25>20 are over; py 10 is not.
        assert sum(len(v) for v in cyc_over.values()) == 2
        # cognitive: only py 30>15 (js excluded from the cognitive gate entirely).
        assert sum(len(v) for v in cog_over.values()) == 1

    def test_js_is_excluded_from_cognitive_even_with_a_cog_value(self):
        units = [_u("js", cc=5, cog=99)]
        assert ratchet.over_threshold(units, ratchet.METRICS["cognitive"]) == {}

    def test_check_passes_at_or_below_ceiling_and_fails_above(self):
        metric = ratchet.METRICS["cognitive"]
        over = ratchet.over_threshold([_u("ps", cc=1, cog=20, file="a.ps1")], metric)
        assert ratchet.check(over, {"a.ps1": [20]}, metric) == []          # exactly at grandfathered ceiling
        assert ratchet.check(over, {"a.ps1": [18]}, metric)                # 20 > ceiling 18 -> violation
        assert ratchet.check(over, {}, metric)                            # no baseline -> must meet threshold 15

    def test_build_baseline_sorts_values_desc_per_file(self):
        metric = ratchet.METRICS["cognitive"]
        over = ratchet.over_threshold(
            [_u("ps", cc=1, cog=18, file="a.ps1", unit="one"),
             _u("ps", cc=1, cog=25, file="a.ps1", unit="two")], metric)
        bl = ratchet.build_baseline(over, metric)
        assert bl["files"]["a.ps1"] == [25, 18]
        assert bl["metric"] == "cog"

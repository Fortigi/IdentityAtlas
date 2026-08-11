"""Unit tests for the complexity ratchet's Python measurers + gate logic.

Run:  python -m pytest tools/complexity/test_ratchet.py
"""
import ast
import importlib.util
import os

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


# ─── JS/TS measurer: ESLint-message parsing ──────────────────────────────────
# `measure_js` runs one ESLint pass with both the core `complexity` rule
# (cyclomatic; message names the function) and `sonarjs/cognitive-complexity`
# (cognitive; message has no name). `parse_js_units` turns those messages into
# ratchet units — this is the pure, testable core of that measurer.
_CC = {"ruleId": "complexity", "line": 10,
       "message": "Function 'foo' has a complexity of 21. Maximum allowed is 20."}
_COG_SAME_LINE = {"ruleId": "sonarjs/cognitive-complexity", "line": 10,
                  "message": "Refactor this function to reduce its Cognitive Complexity from 19 to the 15 allowed."}
_COG_ONLY = {"ruleId": "sonarjs/cognitive-complexity", "line": 42,
             "message": "Refactor this function to reduce its Cognitive Complexity from 17 to the 15 allowed."}


class TestParseJsUnits:
    def test_cyclomatic_message_becomes_a_cc_unit(self):
        (u,) = ratchet.parse_js_units("app/api/src/x.js", [_CC])
        assert (u["cc"], u["cog"], u["lang"], u["line"]) == (21, None, "js", 10)
        assert u["unit"] == "Function 'foo'"

    def test_cognitive_message_becomes_a_cog_unit_borrowing_the_same_line_name(self):
        units = ratchet.parse_js_units("app/api/src/x.js", [_CC, _COG_SAME_LINE])
        assert len(units) == 2                                   # cyclomatic + cognitive are separate units
        cog_unit = next(u for u in units if u["cog"] is not None)
        assert (cog_unit["cog"], cog_unit["cc"]) == (19, None)
        assert cog_unit["unit"] == "Function 'foo'"             # borrowed from the same-line cyclomatic message

    def test_cognitive_only_function_falls_back_to_a_line_label(self):
        (u,) = ratchet.parse_js_units("app/api/src/x.js", [_COG_ONLY])
        assert (u["cog"], u["cc"], u["unit"]) == (17, None, "function (line 42)")

    def test_unrelated_rule_ids_are_ignored(self):
        assert ratchet.parse_js_units("x.js", [{"ruleId": "no-unused-vars", "line": 3, "message": "x"}]) == []


class TestMergeJsUnits:
    """merge_js_units feeds the coverage docs (avg/max over EVERY function): one
    merged unit per function carrying both cc and cog, cog defaulting to 0."""

    def test_merges_cc_and_cog_for_the_same_function(self):
        (u,) = ratchet.merge_js_units("app/api/src/x.js", [_CC, _COG_SAME_LINE])
        assert (u["cc"], u["cog"], u["unit"], u["line"]) == (21, 19, "Function 'foo'", 10)

    def test_straight_line_function_defaults_cog_to_zero(self):
        # The cyclomatic rule reports every function (cc>=1); a function the
        # cognitive rule doesn't flag is genuinely cog 0, not missing.
        cc_only = {"ruleId": "complexity", "line": 5,
                   "message": "Arrow function has a complexity of 1. Maximum allowed is 0."}
        (u,) = ratchet.merge_js_units("x.js", [cc_only])
        assert (u["cc"], u["cog"]) == (1, 0)

    def test_one_unit_per_function_not_per_message(self):
        # Unlike parse_js_units (separate cc/cog units), merge yields ONE row/function.
        assert len(ratchet.merge_js_units("x.js", [_CC, _COG_SAME_LINE, _COG_ONLY])) == 1


# ─── Gate logic ──────────────────────────────────────────────────────────────
def _u(lang, cc, cog, file="x", unit="fn", line=1):
    return dict(file=file, unit=unit, line=line, cc=cc, cog=cog, lang=lang)


class TestGate:
    def test_over_threshold_uses_the_metric_field_and_langs(self):
        units = [_u("ps", cc=20, cog=5), _u("js", cc=25, cog=30), _u("py", cc=10, cog=30)]
        cyc_over = ratchet.over_threshold(units, ratchet.METRICS["cyclomatic"])
        cog_over = ratchet.over_threshold(units, ratchet.METRICS["cognitive"])
        # cyclomatic: ps 20>15 and js 25>20 are over; py 10 is not.
        assert sum(len(v) for v in cyc_over.values()) == 2
        # cognitive: js 30>15 and py 30>15 are over; ps 5 is not.
        assert sum(len(v) for v in cog_over.values()) == 2

    def test_js_participates_in_the_cognitive_gate(self):
        # JS/TS is now gated on cognitive too (threshold 15), via eslint-plugin-sonarjs.
        units = [_u("js", cc=5, cog=99)]
        over = ratchet.over_threshold(units, ratchet.METRICS["cognitive"])
        assert sum(len(v) for v in over.values()) == 1
        # ...but a JS cog value at/under the threshold is not over.
        assert ratchet.over_threshold([_u("js", cc=5, cog=15)], ratchet.METRICS["cognitive"]) == {}

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


# ─── --update must ratchet, not re-baseline ──────────────────────────────────
# It used to rebuild the baseline from the current measurement, so a unit that got MORE complex —
# or a newly over-threshold one — was silently re-baselined at the worse value, the opposite of the
# header's "only ever ratchets DOWN". check() compares the per-file lists position-wise on values
# sorted descending, so the merge is position-wise too.
def _over(**files):
    """{file: [(unit, value), …]} in the shape over_threshold() produces."""
    return {f: [({"unit": f"u{i}", "lang": "js"}, v) for i, v in enumerate(vs)]
            for f, vs in files.items()}


def test_update_merge_lowers_a_value_that_fell():
    merged, improved, dropped, held = ratchet.merge_baseline(_over(**{"a.js": [22]}), {"a.js": [30]})
    assert merged == {"a.js": [22]}
    assert (improved, dropped, held) == (1, 0, [])


def test_update_merge_refuses_a_value_that_rose():
    merged, _, _, held = ratchet.merge_baseline(_over(**{"a.js": [35]}), {"a.js": [30]})
    assert merged == {"a.js": [30]}                 # ceiling held
    assert held == [("a.js", [30], [35])]


def test_update_merge_refuses_an_extra_over_threshold_unit():
    # Two units over threshold where the baseline grandfathered one: the list must not grow.
    merged, _, _, held = ratchet.merge_baseline(_over(**{"a.js": [30, 25]}), {"a.js": [30]})
    assert merged == {"a.js": [30]}
    assert held == [("a.js", [30], [30, 25])]


def test_update_merge_takes_a_shorter_list_as_an_improvement():
    merged, improved, _, held = ratchet.merge_baseline(_over(**{"a.js": [30]}), {"a.js": [30, 25]})
    assert merged == {"a.js": [30]} and improved == 1 and held == []


def test_update_merge_drops_a_file_no_longer_over_threshold():
    merged, _, dropped, _ = ratchet.merge_baseline({}, {"a.js": [30]})
    assert merged == {} and dropped == 1


def test_update_merge_refuses_to_grandfather_a_new_file():
    merged, _, _, held = ratchet.merge_baseline(_over(**{"new.js": [40]}), {})
    assert merged == {} and held == [("new.js", None, [40])]


def test_update_merge_takes_the_gain_and_holds_the_ground_in_one_run():
    merged, improved, _, held = ratchet.merge_baseline(
        _over(**{"fell.js": [21], "rose.js": [35]}), {"fell.js": [30], "rose.js": [30]})
    assert merged == {"fell.js": [21], "rose.js": [30]}
    assert improved == 1 and held == [("rose.js", [30], [35])]


def test_update_merge_allows_an_explicit_increase():
    merged, _, _, held = ratchet.merge_baseline(
        _over(**{"a.js": [35], "new.js": [40]}), {"a.js": [30]}, allow_increase=True)
    assert merged == {"a.js": [35], "new.js": [40]} and held == []

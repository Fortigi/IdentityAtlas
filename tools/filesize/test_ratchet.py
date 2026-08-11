"""Unit tests for the file-length ratchet's pure evaluation logic.

Run: python -m pytest tools/filesize/test_ratchet.py   (or: python tools/filesize/test_ratchet.py)
"""
import importlib.util
import os

# Load the sibling ratchet under a UNIQUE module name. Four tools/ directories each hold a
# `ratchet.py`, so `sys.path.insert(...)` + `from ratchet import ...` is ambiguous to anything
# that cannot model sys.path at runtime — CodeQL resolved it to a different ratchet and reported
# every keyword argument as a wrong name. Same pattern as tools/coverage + tools/complexity.
_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("filesize_ratchet", os.path.join(_HERE, "ratchet.py"))
ratchet = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ratchet)


def test_new_file_over_ceiling_fails():
    over = {"src/big.js": ratchet.CEILING + 50}
    fails = ratchet.evaluate(over, baseline={})
    assert len(fails) == 1
    assert "new file over" in fails[0]


def test_grandfathered_file_that_grew_fails():
    over = {"src/legacy.jsx": 1300}
    fails = ratchet.evaluate(over, baseline={"src/legacy.jsx": 1200})
    assert len(fails) == 1
    assert "grew past its grandfathered ceiling" in fails[0]


def test_grandfathered_file_that_shrank_passes():
    over = {"src/legacy.jsx": 1100}          # still over ceiling, but below its baseline
    assert ratchet.evaluate(over, baseline={"src/legacy.jsx": 1200}) == []


def test_grandfathered_file_at_exactly_baseline_passes():
    over = {"src/legacy.jsx": 1200}
    assert ratchet.evaluate(over, baseline={"src/legacy.jsx": 1200}) == []


def test_no_files_over_ceiling_passes():
    assert ratchet.evaluate({}, baseline={"src/legacy.jsx": 1200}) == []


def test_smelly_flags_the_600_to_1000_band_only():
    sizes = {
        "at_smell.js": ratchet.SMELL,        # exactly 600 — not yet ratchet.smelly
        "smelly.js": ratchet.SMELL + 1,      # 601 — ratchet.smelly
        "at_ceiling.js": ratchet.CEILING,    # 1000 — ratchet.smelly (still <= ceiling)
        "over.js": ratchet.CEILING + 1,      # 1001 — over-ceiling, handled by ratchet.evaluate(), not smell
        "small.js": 100,             # fine
    }
    assert set(ratchet.smelly(sizes, baseline={})) == {"smelly.js", "at_ceiling.js"}


def test_smelly_excludes_already_grandfathered_files():
    # A file recorded in the baseline is governed by the ceiling ratchet, not the
    # soft smell warning — don't nag about it.
    assert ratchet.smelly({"legacy.js": 800}, baseline={"legacy.js": 1200}) == {}


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")


# ─── --update must ratchet, not re-baseline ──────────────────────────────────
# It used to write the current over-ceiling map verbatim, so a grandfathered file that GREW — or a
# brand-new oversized file — was silently re-baselined at the worse value, which is the opposite of
# the header's "only ever ratchets DOWN".
def test_update_merge_records_a_shrink():
    merged, shrunk, dropped, held = ratchet.merge_baseline({"a.js": 1100}, {"a.js": 1200})
    assert merged == {"a.js": 1100}
    assert (shrunk, dropped, held) == (1, 0, [])


def test_update_merge_refuses_to_raise_a_grandfathered_ceiling():
    merged, shrunk, dropped, held = ratchet.merge_baseline({"a.js": 1300}, {"a.js": 1200})
    assert merged == {"a.js": 1200}          # held, not re-baselined
    assert held == [("a.js", 1200, 1300)]


def test_update_merge_refuses_to_grandfather_a_new_oversized_file():
    merged, _, _, held = ratchet.merge_baseline({"new.js": 1400}, {})
    assert merged == {}
    assert held == [("new.js", None, 1400)]


def test_update_merge_drops_a_file_back_under_the_ceiling():
    merged, _, dropped, _ = ratchet.merge_baseline({}, {"a.js": 1200})
    assert merged == {} and dropped == 1


def test_update_merge_takes_the_gain_and_holds_the_ground_in_one_run():
    merged, shrunk, _, held = ratchet.merge_baseline(
        {"shrank.js": 1100, "grew.js": 1300}, {"shrank.js": 1200, "grew.js": 1250})
    assert merged == {"shrank.js": 1100, "grew.js": 1250}
    assert shrunk == 1 and held == [("grew.js", 1250, 1300)]


def test_update_merge_allows_an_explicit_increase():
    merged, _, _, held = ratchet.merge_baseline(
        {"a.js": 1300, "new.js": 1400}, {"a.js": 1200}, allow_increase=True)
    assert merged == {"a.js": 1300, "new.js": 1400}
    assert held == []

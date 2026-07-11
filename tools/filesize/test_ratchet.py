"""Unit tests for the file-length ratchet's pure evaluation logic.

Run: python -m pytest tools/filesize/test_ratchet.py   (or: python tools/filesize/test_ratchet.py)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ratchet import evaluate, smelly, CEILING, SMELL  # noqa: E402


def test_new_file_over_ceiling_fails():
    over = {"src/big.js": CEILING + 50}
    fails = evaluate(over, baseline={})
    assert len(fails) == 1
    assert "new file over" in fails[0]


def test_grandfathered_file_that_grew_fails():
    over = {"src/legacy.jsx": 1300}
    fails = evaluate(over, baseline={"src/legacy.jsx": 1200})
    assert len(fails) == 1
    assert "grew past its grandfathered ceiling" in fails[0]


def test_grandfathered_file_that_shrank_passes():
    over = {"src/legacy.jsx": 1100}          # still over ceiling, but below its baseline
    assert evaluate(over, baseline={"src/legacy.jsx": 1200}) == []


def test_grandfathered_file_at_exactly_baseline_passes():
    over = {"src/legacy.jsx": 1200}
    assert evaluate(over, baseline={"src/legacy.jsx": 1200}) == []


def test_no_files_over_ceiling_passes():
    assert evaluate({}, baseline={"src/legacy.jsx": 1200}) == []


def test_smelly_flags_the_600_to_1000_band_only():
    sizes = {
        "at_smell.js": SMELL,        # exactly 600 — not yet smelly
        "smelly.js": SMELL + 1,      # 601 — smelly
        "at_ceiling.js": CEILING,    # 1000 — smelly (still <= ceiling)
        "over.js": CEILING + 1,      # 1001 — over-ceiling, handled by evaluate(), not smell
        "small.js": 100,             # fine
    }
    assert set(smelly(sizes, baseline={})) == {"smelly.js", "at_ceiling.js"}


def test_smelly_excludes_already_grandfathered_files():
    # A file recorded in the baseline is governed by the ceiling ratchet, not the
    # soft smell warning — don't nag about it.
    assert smelly({"legacy.js": 800}, baseline={"legacy.js": 1200}) == {}


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")

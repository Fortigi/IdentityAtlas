"""Unit tests for the file-length ratchet's pure evaluation logic.

Run: python -m pytest tools/filesize/test_ratchet.py   (or: python tools/filesize/test_ratchet.py)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ratchet import evaluate, CEILING  # noqa: E402


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


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")

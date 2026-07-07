"""Unit tests for the migration immutability gate's pure logic.

Run: python -m pytest tools/migrations/test_ratchet.py   (or: python tools/migrations/test_ratchet.py)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ratchet import evaluate, update_baseline, hash_text  # noqa: E402


def test_hash_is_newline_independent():
    assert hash_text("a\nb\n") == hash_text("a\r\nb\r\n") == hash_text("a\rb\r")


def test_unchanged_migrations_pass():
    base = {"001.sql": "h1", "002.sql": "h2"}
    assert evaluate(dict(base), base) == []


def test_edited_migration_fails():
    base = {"001.sql": "h1"}
    fails = evaluate({"001.sql": "CHANGED"}, base)
    assert len(fails) == 1
    assert "EDITED" in fails[0]


def test_deleted_migration_fails():
    fails = evaluate({}, {"001.sql": "h1"})
    assert len(fails) == 1
    assert "DELETED" in fails[0]


def test_new_migration_not_baselined_fails():
    fails = evaluate({"001.sql": "h1", "055.sql": "hnew"}, {"001.sql": "h1"})
    assert len(fails) == 1
    assert "055.sql" in fails[0] and "--update" in fails[0]


def test_update_is_additive_only():
    base = {"001.sql": "orig"}
    # 001 was edited AND a new 055 added; update must NOT rewrite 001's hash.
    current = {"001.sql": "TAMPERED", "055.sql": "hnew"}
    merged, added = update_baseline(base, current)
    assert merged["001.sql"] == "orig"      # existing entry preserved
    assert merged["055.sql"] == "hnew"       # new entry added
    assert added == ["055.sql"]


def test_update_then_evaluate_still_catches_the_edit():
    # Proves --update can't launder an edit: after an additive update, the
    # tampered existing file still mismatches the preserved baseline hash.
    base = {"001.sql": "orig"}
    current = {"001.sql": "TAMPERED", "055.sql": "hnew"}
    merged, _ = update_baseline(base, current)
    fails = evaluate(current, merged)
    assert len(fails) == 1 and "001.sql" in fails[0] and "EDITED" in fails[0]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")

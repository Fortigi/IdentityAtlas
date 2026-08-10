"""Unit tests for the migration immutability gate's pure logic.

Run: python -m pytest tools/migrations/test_ratchet.py   (or: python tools/migrations/test_ratchet.py)
"""
import importlib.util
import os

# Load the sibling ratchet under a UNIQUE module name. Four tools/ directories each hold a
# `ratchet.py`, so `sys.path.insert(...)` + `from ratchet import ...` is ambiguous to anything
# that cannot model sys.path at runtime — CodeQL resolved it to a different ratchet and reported
# every keyword argument as a wrong name. Same pattern as tools/coverage + tools/complexity.
_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("migration_ratchet", os.path.join(_HERE, "ratchet.py"))
ratchet = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ratchet)


def test_hash_is_newline_independent():
    assert ratchet.hash_text("a\nb\n") == ratchet.hash_text("a\r\nb\r\n") == ratchet.hash_text("a\rb\r")


def test_unchanged_migrations_pass():
    base = {"001.sql": "h1", "002.sql": "h2"}
    assert ratchet.evaluate(dict(base), base) == []


def test_edited_migration_fails():
    base = {"001.sql": "h1"}
    fails = ratchet.evaluate({"001.sql": "CHANGED"}, base)
    assert len(fails) == 1
    assert "EDITED" in fails[0]


def test_deleted_migration_fails():
    fails = ratchet.evaluate({}, {"001.sql": "h1"})
    assert len(fails) == 1
    assert "DELETED" in fails[0]


def test_new_migration_not_baselined_fails():
    fails = ratchet.evaluate({"001.sql": "h1", "055.sql": "hnew"}, {"001.sql": "h1"})
    assert len(fails) == 1
    assert "055.sql" in fails[0] and "--update" in fails[0]


def test_update_is_additive_only():
    base = {"001.sql": "orig"}
    # 001 was edited AND a new 055 added; update must NOT rewrite 001's hash.
    current = {"001.sql": "TAMPERED", "055.sql": "hnew"}
    merged, added = ratchet.update_baseline(base, current)
    assert merged["001.sql"] == "orig"      # existing entry preserved
    assert merged["055.sql"] == "hnew"       # new entry added
    assert added == ["055.sql"]


def test_update_then_evaluate_still_catches_the_edit():
    # Proves --update can't launder an edit: after an additive update, the
    # tampered existing file still mismatches the preserved baseline hash.
    base = {"001.sql": "orig"}
    current = {"001.sql": "TAMPERED", "055.sql": "hnew"}
    merged, _ = ratchet.update_baseline(base, current)
    fails = ratchet.evaluate(current, merged)
    assert len(fails) == 1 and "001.sql" in fails[0] and "EDITED" in fails[0]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")

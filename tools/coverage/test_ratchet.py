"""Unit tests for the per-file coverage ratchet (tools/coverage/ratchet.py).

Run:  python -m pytest tools/coverage/test_ratchet.py -q
"""
import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("cov_ratchet", os.path.join(_HERE, "ratchet.py"))
ratchet = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ratchet)


# ─── lcov parsing ────────────────────────────────────────────────────────────
def _write_lcov(tmp_path, body):
    p = tmp_path / "lcov.info"
    p.write_text(body, encoding="utf-8")
    return str(p)


def test_parse_lcov_reads_hit_and_total_and_applies_prefix(tmp_path):
    lcov = _write_lcov(tmp_path, "\n".join([
        "SF:src/routes/foo.js", "LF:10", "LH:8", "end_of_record",
        "SF:src/routes/bar.js", "LF:4", "LH:4", "end_of_record",
        "",
    ]))
    out = ratchet.parse_lcov(lcov, prefix="app/api/")
    assert out == {
        "app/api/src/routes/foo.js": (8, 10),
        "app/api/src/routes/bar.js": (4, 4),
    }


def test_parse_lcov_normalises_backslashes(tmp_path):
    lcov = _write_lcov(tmp_path, "SF:src\\routes\\win.js\nLF:2\nLH:1\nend_of_record\n")
    assert ratchet.parse_lcov(lcov, prefix="app/api/") == {"app/api/src/routes/win.js": (1, 2)}


# ─── percentage helpers ──────────────────────────────────────────────────────
def test_pct_and_floor_pct():
    assert ratchet.pct(8, 10) == 80.0
    assert ratchet.pct(0, 0) == 100.0            # no coverable lines -> treated as full
    assert ratchet.floor_pct(847, 1000) == 84    # 84.7% floors to 84
    assert ratchet.floor_pct(4, 4) == 100


# ─── gate logic ──────────────────────────────────────────────────────────────
def test_evaluate_fails_only_below_floor():
    measured = {
        "a.js": (83, 100),   # 83.0% — floor 84 -> BELOW -> fail
        "b.js": (84, 100),   # 84.0% — floor 84 -> at floor -> pass
        "c.js": (90, 100),   # 90.0% — floor 84 -> above -> pass
    }
    baseline = {"a.js": 84, "b.js": 84, "c.js": 84}
    fails = ratchet.evaluate(measured, baseline)
    assert len(fails) == 1 and fails[0].startswith("a.js")


def test_evaluate_skips_new_and_zero_line_files():
    measured = {
        "new.js": (1, 100),   # not in baseline -> skipped (diff-coverage's job)
        "empty.js": (0, 0),   # no coverable lines -> skipped
    }
    baseline = {"empty.js": 100}
    assert ratchet.evaluate(measured, baseline) == []


def test_evaluate_tolerates_sub_point_wobble_within_the_floor():
    # 84.9% with floor 84 passes (the floor() gives ~1 point of slack); a real
    # drop below the integer floor still fails.
    assert ratchet.evaluate({"x.js": (849, 1000)}, {"x.js": 84}) == []
    assert ratchet.evaluate({"x.js": (839, 1000)}, {"x.js": 84})  # 83.9% -> fail


# ─── --update / round-trip ───────────────────────────────────────────────────
def test_update_records_floors_and_preserves_other_scopes(tmp_path, monkeypatch):
    baseline_path = tmp_path / "coverage-baseline.json"
    monkeypatch.setattr(ratchet, "BASELINE", str(baseline_path))
    # Seed a UI entry that an API-scoped --update must not clobber.
    baseline_path.write_text('{"files": {"app/ui/src/x.jsx": 70}}', encoding="utf-8")

    lcov = _write_lcov(tmp_path, "SF:src/a.js\nLF:1000\nLH:847\nend_of_record\n")
    assert ratchet.main(["--lcov", lcov, "--prefix", "app/api/", "--update"]) == 0

    import json
    data = json.loads(baseline_path.read_text(encoding="utf-8"))["files"]
    assert data["app/api/src/a.js"] == 84 - ratchet.SAFETY_MARGIN   # 84.7% floored, minus the margin
    assert data["app/ui/src/x.jsx"] == 70        # preserved


def test_main_check_returns_1_on_regression(tmp_path, monkeypatch, capsys):
    baseline_path = tmp_path / "coverage-baseline.json"
    baseline_path.write_text('{"files": {"app/api/src/a.js": 90}}', encoding="utf-8")
    monkeypatch.setattr(ratchet, "BASELINE", str(baseline_path))
    lcov = _write_lcov(tmp_path, "SF:src/a.js\nLF:100\nLH:80\nend_of_record\n")  # 80% < 90
    assert ratchet.main(["--lcov", lcov, "--prefix", "app/api/"]) == 1
    assert "below its baselined floor" in capsys.readouterr().out


# ─── --update must ratchet, not re-baseline ──────────────────────────────────
# It used to write every measured floor unconditionally, so a blanket run after adding tests
# somewhere also gave back ground wherever a file happened to measure a point lower. That is the
# opposite of a ratchet, and it contradicted the tool's own "only ever ratchets UP" header.
def _seed(tmp_path, monkeypatch, files):
    import json
    p = tmp_path / "coverage-baseline.json"
    p.write_text(json.dumps({"files": files}), encoding="utf-8")
    monkeypatch.setattr(ratchet, "BASELINE", str(p))
    return p


def _floors(path):
    import json
    return json.loads(path.read_text(encoding="utf-8"))["files"]


def test_update_refuses_to_lower_an_existing_floor(tmp_path, monkeypatch, capsys):
    p = _seed(tmp_path, monkeypatch, {"app/api/src/a.js": 74})
    # Measures 73 after the safety margin — one point below the committed floor.
    lcov = _write_lcov(tmp_path, "SF:src/a.js\nLF:100\nLH:74\nend_of_record\n")

    assert ratchet.main(["--lcov", lcov, "--prefix", "app/api/", "--update"]) == 0

    assert _floors(p)["app/api/src/a.js"] == 74          # held, not re-baselined
    out = capsys.readouterr().out
    assert "kept app/api/src/a.js at 74%" in out          # and said so
    assert "--allow-decrease" in out


def test_update_still_raises_a_floor(tmp_path, monkeypatch):
    p = _seed(tmp_path, monkeypatch, {"app/api/src/a.js": 40})
    lcov = _write_lcov(tmp_path, "SF:src/a.js\nLF:100\nLH:95\nend_of_record\n")

    assert ratchet.main(["--lcov", lcov, "--prefix", "app/api/", "--update"]) == 0
    assert _floors(p)["app/api/src/a.js"] == 95 - ratchet.SAFETY_MARGIN


def test_update_lowers_only_when_the_decrease_is_asked_for(tmp_path, monkeypatch, capsys):
    p = _seed(tmp_path, monkeypatch, {"app/api/src/a.js": 74})
    lcov = _write_lcov(tmp_path, "SF:src/a.js\nLF:100\nLH:60\nend_of_record\n")

    assert ratchet.main(["--lcov", lcov, "--prefix", "app/api/",
                         "--update", "--allow-decrease"]) == 0

    assert _floors(p)["app/api/src/a.js"] == 60 - ratchet.SAFETY_MARGIN
    assert "LOWERED app/api/src/a.js: 74% ->" in capsys.readouterr().out


def test_allow_decrease_without_update_is_rejected(tmp_path, monkeypatch):
    import pytest
    _seed(tmp_path, monkeypatch, {})
    lcov = _write_lcov(tmp_path, "SF:src/a.js\nLF:100\nLH:60\nend_of_record\n")
    with pytest.raises(SystemExit):
        ratchet.main(["--lcov", lcov, "--prefix", "app/api/", "--allow-decrease"])


def test_a_blanket_update_locks_in_a_gain_without_giving_ground_elsewhere(tmp_path, monkeypatch):
    # The real scenario: tests added for b.js, while a.js wobbles a point low in the same run.
    p = _seed(tmp_path, monkeypatch, {"app/api/src/a.js": 74, "app/api/src/b.js": 0})
    lcov = _write_lcov(
        tmp_path,
        "SF:src/a.js\nLF:100\nLH:74\nend_of_record\n"
        "SF:src/b.js\nLF:100\nLH:99\nend_of_record\n",
    )

    assert ratchet.main(["--lcov", lcov, "--prefix", "app/api/", "--update"]) == 0

    floors = _floors(p)
    assert floors["app/api/src/b.js"] == 99 - ratchet.SAFETY_MARGIN   # gain locked in
    assert floors["app/api/src/a.js"] == 74                           # ground held

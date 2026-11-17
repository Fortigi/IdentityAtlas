"""Unit tests for the aggregate coverage ratchet (tools/coverage/aggregate_floors.py).

Run:  python -m pytest tools/coverage/test_aggregate_floors.py -q
"""
import importlib.util
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("agg_floors", os.path.join(_HERE, "aggregate_floors.py"))
agg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(agg)

# The shape both real configs use: a comment that mentions numbers, then the block,
# then more config after it that must not be touched.
CONFIG = """export default defineConfig({
  test: {
    coverage: {
      // Measured Nov 2026: S89.7 B83.0 F88.3 L91.4. branches: 12 in prose.
      thresholds: {
        statements: 87,
        branches: 81,
        functions: 86,
        lines: 89,
      },
    },
  },
  server: { port: 5173, branches: 3 },
});
"""


def _summary(**pct):
    return {"total": {k: {"total": 10, "covered": 9, "skipped": 0, "pct": v} for k, v in pct.items()}}


def _run(tmp_path, config, summary, *extra):
    cfg = tmp_path / "vite.config.js"
    cfg.write_text(config, encoding="utf-8")
    summ = tmp_path / "coverage-summary.json"
    summ.write_text(json.dumps(summary), encoding="utf-8")
    code = agg.main(["--config", str(cfg), "--summary", str(summ), *extra])
    return code, cfg.read_text(encoding="utf-8")


def test_reads_the_four_floors_from_the_block_only():
    assert agg.read_thresholds(CONFIG) == {"statements": 87, "branches": 81, "functions": 86, "lines": 89}


def test_no_block_reads_as_none():
    assert agg.read_thresholds("export default { coverage: {} }") is None


def test_raises_to_measured_minus_margin_rounded_down():
    current = {"statements": 87, "branches": 81, "functions": 86, "lines": 89}
    measured = {"statements": 92.99, "branches": 83.0, "functions": 88.0, "lines": 91.4}
    # 92.99-2=90.99 -> 90; 83-2=81 -> not above 81; 88-2=86 -> not above 86; 91.4-2 -> 89, not above
    assert agg.raised_floors(current, measured, 2) == {"statements": 90}


def test_never_lowers_a_floor():
    assert agg.raised_floors({"lines": 89}, {"lines": 50.0}, 2) == {}


def test_skips_a_metric_vitest_reports_as_unknown():
    assert agg.raised_floors({"branches": 81, "lines": 89}, {"branches": "Unknown", "lines": 95.0}, 2) == {"lines": 93}


def test_skips_a_metric_missing_from_the_summary():
    assert agg.raised_floors({"functions": 86}, {"functions": None}, 2) == {}


def test_margin_is_honoured():
    assert agg.raised_floors({"lines": 80}, {"lines": 90.0}, 5) == {"lines": 85}


def test_rewrites_only_the_raised_metrics_inside_the_block(tmp_path):
    code, out = _run(tmp_path, CONFIG, _summary(statements=95.2, branches=82.0, functions=86.5, lines=99.9))
    assert code == 0
    assert "        statements: 93," in out
    assert "        branches: 81," in out          # 82-2=80, not raised
    assert "        functions: 86," in out         # 84.5 -> 84, not raised
    assert "        lines: 97," in out
    # the prose comment and the later `branches: 3` are untouched
    assert "branches: 12 in prose" in out
    assert "server: { port: 5173, branches: 3 }" in out


def test_leaves_the_file_byte_identical_when_nothing_rises(tmp_path):
    code, out = _run(tmp_path, CONFIG, _summary(statements=80.0, branches=80.0, functions=80.0, lines=80.0))
    assert code == 0
    assert out == CONFIG


def test_a_config_without_the_block_is_an_error_not_a_silent_skip(tmp_path):
    code, out = _run(tmp_path, "export default {}\n", _summary(lines=99.0))
    assert code == 2
    assert out == "export default {}\n"


def test_the_real_configs_have_a_readable_block():
    # If either config is reformatted so the block can't be read, the post-merge
    # ratchet would exit 2 on main; catch that on the PR instead.
    root = os.path.normpath(os.path.join(_HERE, "..", ".."))
    for rel in ("app/api/vitest.config.js", "app/ui/vite.config.js"):
        with open(os.path.join(root, rel), encoding="utf-8") as f:
            found = agg.read_thresholds(f.read())
        assert found is not None and set(found) == set(agg.METRICS), rel

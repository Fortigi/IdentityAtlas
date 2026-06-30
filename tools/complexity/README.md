# Complexity ratchet

A CI gate that **squeezes** cyclomatic complexity down over time without ever
red-building on adoption. It measures every *unit* — each function, plus each
PowerShell script/module **body** (so a monolithic `Start-*Crawler.ps1` body is
visible as one high-CC unit, not hidden between its helpers) — across all three
languages, and enforces, per file:

- **No unit may exceed its grandfathered ceiling** — complexity can only fall.
- **A new or newly-over-threshold unit must be ≤ the language threshold.**

Everything currently over threshold is grandfathered into
[`.ci/complexity-baseline.json`](../../.ci/complexity-baseline.json); the baseline
only ever ratchets **down**. The end state is "every unit ≤ 15", at which point the
baseline is deleted and the thresholds become a flat rule.

## Thresholds

| Language | Threshold | Why |
|---|---|---|
| PowerShell | 15 | Already near-clean per function. |
| Python | 15 | Tiny surface. |
| JS / TS | 20 | The app starts with many 16–20 handlers/components; lowered to 15 once squeezed. |

## Run it

```bash
python tools/complexity/ratchet.py            # check (what CI runs); exit 1 on a regression
python tools/complexity/ratchet.py --update   # regenerate / lower the baseline
```

JS/TS measurement uses the project's ESLint, so `app/api` and `app/ui` need their
deps installed (`npm ci`). PowerShell and Python need no setup.

## Workflow

- **Lowering complexity?** Refactor, then `--update` to lock in the lower numbers and
  commit the baseline diff alongside your change. The baseline shrinks.
- **CI failed on your PR?** The `::error` annotation names the unit, its CC, and its
  ceiling. Lower it or split it. Re-baselining (`--update`) to raise a ceiling is only
  for a deliberate, reviewed increase — it shows up as an *increase* in the baseline
  diff, which a reviewer should challenge.

## Measurers

- PowerShell — `measure_ps.ps1` (PowerShell AST).
- Python — `ratchet.py` itself (`ast`).
- JS / TS — ESLint's built-in [`complexity`](https://eslint.org/docs/latest/rules/complexity) rule.

Generated mirrors (`bundled-scripts/`), dependencies, build output, and non-production
scripts (tests, CI harnesses, mocks, dev seeders) are excluded.

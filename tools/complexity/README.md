# Complexity ratchet

A CI gate that **squeezes** complexity down over time without ever red-building on
adoption. It measures every *unit* — each function, plus each PowerShell script/module
**body** (so a monolithic `Start-*Crawler.ps1` body is visible as one high-complexity
unit, not hidden between its helpers) — and enforces, per file:

- **No unit may exceed its grandfathered ceiling** — complexity can only fall.
- **A new or newly-over-threshold unit must be ≤ the language threshold.**

Everything currently over threshold is grandfathered into a baseline; the baseline only
ever ratchets **down**. The end state is "every unit ≤ 15", at which point the baseline
is deleted and the threshold becomes a flat rule.

## Two metrics

The ratchet gates two independent metrics, each with its own baseline, selected with
`--metric`:

### `cyclomatic` (default)

Number of independent paths — every branch counts equally (`+1` per `if`/`elseif`, loop,
`catch`, `case`, ternary, `&&`/`||`). Good at "how many test cases," blind to how the
code is *arranged*. Baseline: [`.ci/complexity-baseline.json`](../../.ci/complexity-baseline.json).

### `cognitive`

How hard the code is to **follow** ([SonarSource model](https://www.sonarsource.com/docs/CognitiveComplexity.pdf)).
Same breaks-in-flow, but weighted for readability:

- **Nesting is penalised.** A structure adds `+1` for *each enclosing nesting level*, so a
  branch three levels deep costs 4, not 1. This is what a flat cyclomatic count misses —
  and why a deeply-nested `Start-*Crawler.ps1` body scores far higher on cognitive (e.g.
  618) than cyclomatic (251).
- **Else-if chains read flat.** `else` / `elseif` get a bare `+1` with no nesting penalty
  (a chain reads top-to-bottom; re-nesting would over-count it).
- **A `switch` counts once**, not per `case`.
- **A run of the same boolean operator counts once** (`a -and b -and c` = +1;
  `a -and b -or c` = +2).

A straight-line function is 0. Baseline:
[`.ci/cognitive-baseline.json`](../../.ci/cognitive-baseline.json).

Cognitive is the better lever for *readability* refactors (flatten nesting, extract
guard clauses); cyclomatic is the better proxy for *test-case count*. They agree on
"this is a monolith" and disagree on "which of two same-CC functions is harder to read"
— which is exactly where cognitive earns its place.

## Thresholds

| Language | Cyclomatic | Cognitive | Why |
|---|---|---|---|
| PowerShell | 15 | 15 | Already near-clean per function. |
| Python | 15 | 15 | Tiny surface. |
| JS / TS | 20 | 15 | Cyclomatic starts looser (many 16–20 handlers); cognitive uses `eslint-plugin-sonarjs` at the S3776 default of 15. |

15 is the SonarSource default for cognitive complexity (rule `S3776`).

## Run it

```bash
python tools/complexity/ratchet.py                        # cyclomatic check (CI gate)
python tools/complexity/ratchet.py --update               # re-baseline cyclomatic
python tools/complexity/ratchet.py --metric cognitive     # cognitive check
python tools/complexity/ratchet.py --metric cognitive --update
```

JS/TS measurement uses the project's ESLint, so `app/api` and `app/ui` need their deps
installed (`npm ci`). PowerShell and Python need no setup.

## Workflow

- **Lowering complexity?** Refactor, then `--update` (for whichever metric moved) to lock
  in the lower numbers and commit the baseline diff alongside your change.
- **CI failed on your PR?** The `::error` annotation names the unit, its score, and its
  ceiling. Lower it or split it. Re-baselining to *raise* a ceiling is only for a
  deliberate, reviewed increase — it shows up as an increase in the baseline diff, which
  a reviewer should challenge.

## Measurers

- PowerShell — the published [**PSComplexity**](https://github.com/Fortigi/PSComplexity)
  module (a faithful, reference-validated SonarSource cognitive metric plus cyclomatic).
  `measure_ps.ps1` is a thin selector/formatter: it picks the production PS files and maps
  `Measure-PSComplexity`'s output to the ratchet's `{cc, cog}` contract. Run
  `measure_ps.ps1 -Path <file|dir>` to measure just that path.
- Python — `ratchet.py` itself (`ast`); both metrics in one parse.
- JS / TS — ESLint, in a single pass: the built-in [`complexity`](https://eslint.org/docs/latest/rules/complexity)
  rule (cyclomatic) and [`eslint-plugin-sonarjs`](https://github.com/SonarSource/eslint-plugin-sonarjs)'s
  `sonarjs/cognitive-complexity` (cognitive). The plugin is registered in each `eslint.config.js`
  but **no rule is enabled there** — the ratchet injects both rules via `--rule`, so `npm run lint`
  stays green while the ratchet still measures every function.

Generated mirrors (`bundled-scripts/`), dependencies, build output, and non-production
scripts (tests, CI harnesses, mocks, dev seeders) are excluded.

## Tests

The measurers gate the whole repo, so they're tested themselves:

- **Python** — `test_ratchet.py` (pytest): the cyclomatic + cognitive `ast` computers
  (including a worked cognitive example) and the ratchet gate logic
  (`over_threshold` / `check` / `build_baseline`). Run: `python -m pytest tools/complexity/test_ratchet.py`.
- **PowerShell** — `test/unit/ComplexityMeasure.Tests.ps1` (Pester): runs `measure_ps.ps1 -Path`
  over throwaway fixtures and asserts `cc` / `cog`. The cognitive cases **mirror** the Python
  ones (same worked example → cc 9 / cog 11) so the two measurers stay in agreement.

CI runs the Python tests in the `Complexity ratchet` workflow (before the gate); the
PowerShell tests run in the `Unit Tests: Pester` job. The `parse_js_units` ESLint-message
parser (the pure core of the JS/TS measurer) is covered by `test_ratchet.py` too.

# Test Coverage

<!-- GENERATED FILE — do not edit by hand. Produced by tools/generate-coverage-doc.py via .github/workflows/coverage.yml. -->

Test quality across the project's automated suites — line/branch/method coverage plus, where measured, code complexity and mutation score — regenerated on every merge to `main`. The figures on this page reflect the version of the docs you are viewing — **edge** tracks `main`, a released version is frozen at its release tag.

| Suite | Line | Branch | Method | Cyclomatic | Cognitive | Mutation | Lines covered |
|-------|------|--------|--------|------------|-----------|----------|---------------|
| [API (Node / Vitest — unit + contract)](../coverage/api/index.html) | 93.7% | 86.3% | 89.7% | 3.4 / 20 | 1.9 / 15 | 86.0% | 14,010 / 14,946 |
| [UI (React / Vitest)](../coverage/ui/index.html) | 86.9% | 77.5% | 77.2% | 2.8 / 28 | 1.1 / 15 | 69.5% | 8,412 / 9,676 |
| [PowerShell (Pester)](../coverage/powershell/index.html) | 92.2% | — | 97.3% | 3.8 / 15 | 3.9 / 15 | 100.0% | 8,099 / 8,782 |

**Cyclomatic** / **Cognitive** are _average / max_ per unit (each function, and for PowerShell each script/module body too): PowerShell via [PSComplexity](https://github.com/Fortigi/PSComplexity), JS/TS via ESLint's `complexity` rule + [eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs). **Mutation** is the share of injected faults the tests catch via [PSMutant](https://github.com/Fortigi/PSMutant), PowerShell-only today. A suite without a given signal shows —.

## Reading these numbers

Every figure above is scoped to what its tool actually measured. The notes below are generated from the same reports as the table, so they stay true as the numbers move. They are descriptive, not gates — no CI job fails on anything in this section.

### API (Node / Vitest — unit + contract)

- **Mutation is scoped.** Mutation testing covers 110 file(s) of 316 — 34% of the suite's coverable lines. It describes that subset — not the suite — and is not comparable with the suite-wide line figure on the same row. **The score itself is older than that scope:** it was measured over 18 file(s), before the current list was committed. Mutation runs are regenerated on their own schedule, so the percentage catches up on the next run.
- **method coverage (89.7%) sits below line coverage (93.7%)** — roughly a third of functions are never invoked, while the ones that are get exercised well. Typically components rendered but not interacted with: the untested part is event handlers, callbacks and conditional render paths.

### UI (React / Vitest)

- **Mutation is scoped.** Mutation testing covers 68 file(s) of 339 — 16% of the suite's coverable lines. It describes that subset — not the suite — and is not comparable with the suite-wide line figure on the same row. **The score itself is older than that scope:** it was measured over 6 file(s), before the current list was committed. Mutation runs are regenerated on their own schedule, so the percentage catches up on the next run.
- **method coverage (77.2%) sits below line coverage (86.9%)** — roughly a third of functions are never invoked, while the ones that are get exercised well. Typically components rendered but not interacted with: the untested part is event handlers, callbacks and conditional render paths.
- **The most complex code is the least branch-covered.** `app/ui/src/components/MatrixView.jsx` (Function 'MatrixView', cyclomatic 20, 68.8% branch) — below this suite's own branch average, so the aggregate percentage overstates how well the hard parts are tested.

### PowerShell (Pester)

- **Mutation is scoped.** Mutation testing covers 142 file(s) of 169 — 94% of the suite's coverable lines, using 4 mutation operators. It describes that subset — not the suite — and is not comparable with the suite-wide line figure on the same row. **The score itself is older than that scope:** it was measured over 90 file(s), before the current list was committed. Mutation runs are regenerated on their own schedule, so the percentage catches up on the next run.
- **No branch coverage is measured.** The line figure is not comparable with the suites that report both — and for Pester it is command-based rather than true line coverage, so it is not directly comparable with the Vitest suites either.

## Browsable reports

Each suite links to a full per-file, line-by-line HTML report:

- [API (Node / Vitest — unit + contract)](../coverage/api/index.html)
- [UI (React / Vitest)](../coverage/ui/index.html)
- [PowerShell (Pester)](../coverage/powershell/index.html)

_Generated 2026-10-24 09:43 UTC from commit `4e5b77a9`._

# Test Coverage

<!-- GENERATED FILE — do not edit by hand. Produced by tools/generate-coverage-doc.py via .github/workflows/coverage.yml. -->

Test quality across the project's automated suites — line/branch/method coverage plus, where measured, code complexity and mutation score — regenerated on every merge to `main`. The figures on this page reflect the version of the docs you are viewing — **edge** tracks `main`, a released version is frozen at its release tag.

| Suite | Line | Branch | Method | Cyclomatic | Cognitive | Mutation | Lines covered |
|-------|------|--------|--------|------------|-----------|----------|---------------|
| [API (Node / Vitest — unit + contract)](../coverage/api/index.html) | 91.5% | 83.1% | 90.6% | 3.7 / 20 | 2.3 / 15 | 86.0% | 9,522 / 10,396 |
| [UI (React / Vitest)](../coverage/ui/index.html) | 85.5% | 75.7% | 75.6% | 2.8 / 28 | 1.1 / 15 | 69.5% | 7,268 / 8,498 |
| [PowerShell (Pester)](../coverage/powershell/index.html) | 91.9% | — | 97.3% | 3.8 / 15 | 4.0 / 15 | 100.0% | 6,164 / 6,702 |

**Cyclomatic** / **Cognitive** are _average / max_ per unit (each function, and for PowerShell each script/module body too): PowerShell via [PSComplexity](https://github.com/Fortigi/PSComplexity), JS/TS via ESLint's `complexity` rule + [eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs). **Mutation** is the share of injected faults the tests catch via [PSMutant](https://github.com/Fortigi/PSMutant), PowerShell-only today. A suite without a given signal shows —.

## Reading these numbers

Every figure above is scoped to what its tool actually measured. The notes below are generated from the same reports as the table, so they stay true as the numbers move. They are descriptive, not gates — no CI job fails on anything in this section.

### API (Node / Vitest — unit + contract)

- **Mutation is scoped.** Mutation testing covers 35 file(s) of 227 — 13% of the suite's coverable lines. It describes that subset — not the suite — and is not comparable with the suite-wide line figure on the same row. **The score itself is older than that scope:** it was measured over 18 file(s), before the current list was committed. Mutation runs are regenerated on their own schedule, so the percentage catches up on the next run.
- **The most complex code is the least branch-covered.** `app/api/src/routes/contexts/members.js` (Async arrow function, cyclomatic 19, 81.0% branch) — below this suite's own branch average, so the aggregate percentage overstates how well the hard parts are tested.

### UI (React / Vitest)

- **Mutation is scoped.** Mutation testing covers 32 file(s) of 285 — 10% of the suite's coverable lines. It describes that subset — not the suite — and is not comparable with the suite-wide line figure on the same row. **The score itself is older than that scope:** it was measured over 6 file(s), before the current list was committed. Mutation runs are regenerated on their own schedule, so the percentage catches up on the next run.
- **method coverage (75.6%) sits below line coverage (85.5%)** — roughly a third of functions are never invoked, while the ones that are get exercised well. Typically components rendered but not interacted with: the untested part is event handlers, callbacks and conditional render paths.
- **The most complex code is the least branch-covered.** `app/ui/src/components/MatrixView.jsx` (Function 'MatrixView', cyclomatic 20, 68.8% branch) — below this suite's own branch average, so the aggregate percentage overstates how well the hard parts are tested.

### PowerShell (Pester)

- **Mutation is scoped.** Mutation testing covers 118 file(s) of 147 — 94% of the suite's coverable lines, using 4 mutation operators. It describes that subset — not the suite — and is not comparable with the suite-wide line figure on the same row. **The score itself is older than that scope:** it was measured over 90 file(s), before the current list was committed. Mutation runs are regenerated on their own schedule, so the percentage catches up on the next run.
- **No branch coverage is measured.** The line figure is not comparable with the suites that report both — and for Pester it is command-based rather than true line coverage, so it is not directly comparable with the Vitest suites either.

## Browsable reports

Each suite links to a full per-file, line-by-line HTML report:

- [API (Node / Vitest — unit + contract)](../coverage/api/index.html)
- [UI (React / Vitest)](../coverage/ui/index.html)
- [PowerShell (Pester)](../coverage/powershell/index.html)

_Generated 2026-09-16 12:28 UTC from commit `df40424f`._

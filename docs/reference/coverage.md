# Test Coverage

<!-- GENERATED FILE — do not edit by hand. Produced by tools/generate-coverage-doc.py via .github/workflows/coverage.yml. -->

Test quality across the project's automated suites — line/branch/method coverage plus, where measured, code complexity and mutation score — regenerated on every merge to `main`. The figures on this page reflect the version of the docs you are viewing — **edge** tracks `main`, a released version is frozen at its release tag.

| Suite | Line | Branch | Method | Cyclomatic | Cognitive | Mutation | Lines covered |
|-------|------|--------|--------|------------|-----------|----------|---------------|
| [API (Node / Vitest — unit + contract)](../coverage/api/index.html) | 88.3% | 78.3% | 89.2% | 3.8 / 20 | 2.4 / 15 | 86.0% | 8,207 / 9,291 |
| [UI (React / Vitest)](../coverage/ui/index.html) | 81.1% | 70.6% | 69.7% | 2.8 / 28 | 1.1 / 15 | 69.4% | 6,120 / 7,546 |
| [PowerShell (Pester)](../coverage/powershell/index.html) | 91.0% | — | 96.8% | 3.8 / 15 | 4.0 / 15 | 93.2% | 5,572 / 6,118 |

**Cyclomatic** / **Cognitive** are _average / max_ per unit (each function, and for PowerShell each script/module body too): PowerShell via [PSComplexity](https://github.com/Fortigi/PSComplexity), JS/TS via ESLint's `complexity` rule + [eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs). **Mutation** is the share of injected faults the tests catch via [PSMutant](https://github.com/Fortigi/PSMutant), PowerShell-only today. A suite without a given signal shows —.

## Reading these numbers

Every figure above is scoped to what its tool actually measured. The notes below are generated from the same reports as the table, so they stay true as the numbers move. They are descriptive, not gates — no CI job fails on anything in this section.

### API (Node / Vitest — unit + contract)

- **Mutation is scoped.** Mutation testing covers 18 file(s) of 190 — 9% of the suite's coverable lines. It describes that subset — not the suite — and is not comparable with the suite-wide line figure on the same row.
- **The most complex code is the least branch-covered.** `app/api/src/routes/updates.js` (Async arrow function, cyclomatic 20, 76.0% branch) — below this suite's own branch average, so the aggregate percentage overstates how well the hard parts are tested.

### UI (React / Vitest)

- **Mutation is scoped.** Mutation testing covers 6 file(s) of 219 — 5% of the suite's coverable lines. It describes that subset — not the suite — and is not comparable with the suite-wide line figure on the same row.
- **method coverage (69.7%) sits below line coverage (81.1%)** — roughly a third of functions are never invoked, while the ones that are get exercised well. Typically components rendered but not interacted with: the untested part is event handlers, callbacks and conditional render paths.
- **The most complex code is the least branch-covered.** `app/ui/src/components/MatrixView.jsx` (Function 'MatrixView', cyclomatic 20, 50.9% branch) — below this suite's own branch average, so the aggregate percentage overstates how well the hard parts are tested.

### PowerShell (Pester)

- **Mutation is scoped.** Mutation testing covers 112 file(s) of 140 — 93% of the suite's coverable lines, using 4 mutation operators. It describes that subset — not the suite — and is not comparable with the suite-wide line figure on the same row. **The score itself is older than that scope:** it was measured over 9 file(s), before the current list was committed. Mutation runs are regenerated on their own schedule, so the percentage catches up on the next run.
- **No branch coverage is measured.** The line figure is not comparable with the suites that report both — and for Pester it is command-based rather than true line coverage, so it is not directly comparable with the Vitest suites either.

## Browsable reports

Each suite links to a full per-file, line-by-line HTML report:

- [API (Node / Vitest — unit + contract)](../coverage/api/index.html)
- [UI (React / Vitest)](../coverage/ui/index.html)
- [PowerShell (Pester)](../coverage/powershell/index.html)

_Generated 2026-08-24 05:40 UTC from commit `b2de2a95`._

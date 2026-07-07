# Test Coverage

<!-- GENERATED FILE — do not edit by hand. Produced by tools/generate-coverage-doc.py via .github/workflows/coverage.yml. -->

Test quality across the project's automated suites — line/branch/method coverage plus, where measured, code complexity and mutation score — regenerated on every merge to `main`. The figures on this page reflect the version of the docs you are viewing — **edge** tracks `main`, a released version is frozen at its release tag.

| Suite | Line | Branch | Method | Cyclomatic | Cognitive | Mutation | Lines covered |
|-------|------|--------|--------|------------|-----------|----------|---------------|
| [API (Node / Vitest — unit + contract)](../coverage/api/index.html) | 73.8% | 62.6% | 76.5% | 4.6 / 46 | 3.3 / 104 | — | 6,694 / 9,068 |
| [UI (React / Vitest)](../coverage/ui/index.html) | 67.0% | 55.5% | 53.7% | 3.1 / 52 | 1.5 / 109 | — | 4,761 / 7,099 |
| [PowerShell (Pester)](../coverage/powershell/index.html) | 91.9% | — | 97.3% | 4.2 / 50 | 5.0 / 95 | 84.7% | 5,405 / 5,880 |

**Cyclomatic** / **Cognitive** are _average / max_ per unit (each function, and for PowerShell each script/module body too): PowerShell via [PSComplexity](https://github.com/Fortigi/PSComplexity), JS/TS via ESLint's `complexity` rule + [eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs). **Mutation** is the share of injected faults the tests catch via [PSMutant](https://github.com/Fortigi/PSMutant), PowerShell-only today. A suite without a given signal shows —.

## Browsable reports

Each suite links to a full per-file, line-by-line HTML report:

- [API (Node / Vitest — unit + contract)](../coverage/api/index.html)
- [UI (React / Vitest)](../coverage/ui/index.html)
- [PowerShell (Pester)](../coverage/powershell/index.html)

_Generated 2026-07-07 18:59 UTC from commit `03819c8e`._

# Test Coverage

<!-- GENERATED FILE — do not edit by hand. Produced by tools/generate-coverage-doc.py via .github/workflows/coverage.yml. -->

Test quality across the project's automated suites — line/branch/method coverage plus, where measured, code complexity and mutation score — regenerated on every merge to `main`. The figures on this page reflect the version of the docs you are viewing — **edge** tracks `main`, a released version is frozen at its release tag.

| Suite | Line | Branch | Method | Cyclomatic | Cognitive | Mutation | Lines covered |
|-------|------|--------|--------|------------|-----------|----------|---------------|
| [API (Node / Vitest — unit + contract)](../coverage/api/index.html) | 82.5% | 70.3% | 83.2% | 4.5 / 46 | 3.2 / 87 | — | 7,365 / 8,918 |
| [UI (React / Vitest)](../coverage/ui/index.html) | 69.9% | 57.3% | 56.1% | 3.1 / 52 | 1.5 / 109 | — | 4,981 / 7,121 |
| [PowerShell (Pester)](../coverage/powershell/index.html) | 91.4% | — | 96.9% | 4.2 / 50 | 5.0 / 95 | 84.7% | 5,431 / 5,938 |

**Cyclomatic** / **Cognitive** are _average / max_ per unit (each function, and for PowerShell each script/module body too): PowerShell via [PSComplexity](https://github.com/Fortigi/PSComplexity), JS/TS via ESLint's `complexity` rule + [eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs). **Mutation** is the share of injected faults the tests catch via [PSMutant](https://github.com/Fortigi/PSMutant), PowerShell-only today. A suite without a given signal shows —.

## Browsable reports

Each suite links to a full per-file, line-by-line HTML report:

- [API (Node / Vitest — unit + contract)](../coverage/api/index.html)
- [UI (React / Vitest)](../coverage/ui/index.html)
- [PowerShell (Pester)](../coverage/powershell/index.html)

_Generated 2026-07-15 15:40 UTC from commit `5c2d81f0`._

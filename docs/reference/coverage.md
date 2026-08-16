# Test Coverage

<!-- GENERATED FILE — do not edit by hand. Produced by tools/generate-coverage-doc.py via .github/workflows/coverage.yml. -->

Test quality across the project's automated suites — line/branch/method coverage plus, where measured, code complexity and mutation score — regenerated on every merge to `main`. The figures on this page reflect the version of the docs you are viewing — **edge** tracks `main`, a released version is frozen at its release tag.

| Suite | Line | Branch | Method | Cyclomatic | Cognitive | Mutation | Lines covered |
|-------|------|--------|--------|------------|-----------|----------|---------------|
| [API (Node / Vitest — unit + contract)](../coverage/api/index.html) | 87.9% | 77.1% | 88.9% | 3.8 / 20 | 2.4 / 15 | — | 8,175 / 9,293 |
| [UI (React / Vitest)](../coverage/ui/index.html) | 79.4% | 68.1% | 67.4% | 2.8 / 28 | 1.1 / 15 | — | 5,995 / 7,546 |
| [PowerShell (Pester)](../coverage/powershell/index.html) | 91.3% | — | 97.2% | 3.7 / 15 | 3.8 / 15 | 93.2% | 5,475 / 5,996 |

**Cyclomatic** / **Cognitive** are _average / max_ per unit (each function, and for PowerShell each script/module body too): PowerShell via [PSComplexity](https://github.com/Fortigi/PSComplexity), JS/TS via ESLint's `complexity` rule + [eslint-plugin-sonarjs](https://github.com/SonarSource/eslint-plugin-sonarjs). **Mutation** is the share of injected faults the tests catch via [PSMutant](https://github.com/Fortigi/PSMutant), PowerShell-only today. A suite without a given signal shows —.

## Browsable reports

Each suite links to a full per-file, line-by-line HTML report:

- [API (Node / Vitest — unit + contract)](../coverage/api/index.html)
- [UI (React / Vitest)](../coverage/ui/index.html)
- [PowerShell (Pester)](../coverage/powershell/index.html)

_Generated 2026-08-16 15:36 UTC from commit `d334a868`._

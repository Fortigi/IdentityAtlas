# Test Coverage

<!-- GENERATED FILE — do not edit by hand. Produced by tools/generate-coverage-doc.py via .github/workflows/coverage.yml. -->

Test quality across the project's automated suites — line/branch/method coverage plus, where measured, code complexity and mutation score — regenerated on every merge to `main`. The figures on this page reflect the version of the docs you are viewing — **edge** tracks `main`, a released version is frozen at its release tag.

![Overall coverage](https://img.shields.io/badge/coverage-76.2%25-yellow)

| Suite | Line | Branch | Method | Cyclomatic | Cognitive | Mutation | Lines covered |
|-------|------|--------|--------|------------|-----------|----------|---------------|
| [API (Node / Vitest — unit + contract)](../coverage/api/index.html) | 73.5% | 62.2% | 76.1% | — | — | — | 6,642 / 9,025 |
| [UI (React / Vitest)](../coverage/ui/index.html) | 66.8% | 55.1% | 53.4% | — | — | — | 4,704 / 7,034 |
| [PowerShell (Pester)](../coverage/powershell/index.html) | 91.8% | — | 97.2% | 4.2 / 50 | 5.0 / 95 | 84.7% | 5,213 / 5,678 |
| **Overall** | **76.2%** | | | | | | **16,559 / 21,737** |

**Cyclomatic** / **Cognitive** are _average / max_ per unit (each function, plus each script/module body) via [PSComplexity](https://github.com/Fortigi/PSComplexity); **Mutation** is the share of injected faults the tests catch via [PSMutant](https://github.com/Fortigi/PSMutant). Both are measured for PowerShell today — suites without them show —.

## Browsable reports

Each suite links to a full per-file, line-by-line HTML report:

- [API (Node / Vitest — unit + contract)](../coverage/api/index.html)
- [UI (React / Vitest)](../coverage/ui/index.html)
- [PowerShell (Pester)](../coverage/powershell/index.html)

_Generated 2026-07-06 08:25 UTC from commit `e5de101c`._

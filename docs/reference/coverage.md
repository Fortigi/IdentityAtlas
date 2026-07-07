# Test Coverage

<!-- GENERATED FILE — do not edit by hand. Produced by tools/generate-coverage-doc.py via .github/workflows/coverage.yml. -->

Test quality across the project's automated suites — line/branch/method coverage plus, where measured, code complexity and mutation score — regenerated on every merge to `main`. The figures on this page reflect the version of the docs you are viewing — **edge** tracks `main`, a released version is frozen at its release tag.

![Overall coverage](https://img.shields.io/badge/coverage-76.4%25-yellow)

| Suite | Line | Branch | Method | Cyclomatic | Cognitive | Mutation | Lines covered |
|-------|------|--------|--------|------------|-----------|----------|---------------|
| [API (Node / Vitest — unit + contract)](../coverage/api/index.html) | 73.6% | 62.3% | 76.1% | — | — | — | 6,645 / 9,022 |
| [UI (React / Vitest)](../coverage/ui/index.html) | 66.9% | 55.2% | 53.5% | — | — | — | 4,728 / 7,066 |
| [PowerShell (Pester)](../coverage/powershell/index.html) | 91.9% | — | 97.3% | 4.2 / 50 | 5.0 / 95 | 84.7% | 5,405 / 5,880 |
| **Overall** | **76.4%** | | | | | | **16,778 / 21,968** |

**Cyclomatic** / **Cognitive** are _average / max_ per unit (each function, plus each script/module body) via [PSComplexity](https://github.com/Fortigi/PSComplexity); **Mutation** is the share of injected faults the tests catch via [PSMutant](https://github.com/Fortigi/PSMutant). Both are measured for PowerShell today — suites without them show —.

## Browsable reports

Each suite links to a full per-file, line-by-line HTML report:

- [API (Node / Vitest — unit + contract)](../coverage/api/index.html)
- [UI (React / Vitest)](../coverage/ui/index.html)
- [PowerShell (Pester)](../coverage/powershell/index.html)

_Generated 2026-07-07 10:44 UTC from commit `5725f3a0`._

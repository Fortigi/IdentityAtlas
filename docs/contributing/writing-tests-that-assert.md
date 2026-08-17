# Writing tests that actually assert

Line coverage cannot tell a real assertion from an empty one. Everything on this
page was found in this repository under green coverage, and every rule here
exists because something got through.

This is a working guide, not a history. Defects that have been fixed are not
listed — the rules they produced are.

---

## The three habits that matter

1. **Assert what was computed, not that something ran.** Counts, call tallies and
   "did not throw" are cheap and blind.
2. **Choose inputs that would change the answer if the logic were subtly wrong.**
   Exercising a branch is not the same as separating it from a wrong version of
   that branch.
3. **State what a number measured over.** A score covering part of a codebase,
   printed next to a whole-codebase figure, will be read as whole-codebase.

---

## Assertions that look strict and are not

### Counts that mean "at least"

In Pester, `Should -Invoke Foo -Times 3` means **at least** three times. Only
`-Exactly` pins it. (`-Times 0` is special-cased as exact.)

```powershell
Should -Invoke Invoke-RestMethod -Exactly 1     # a count
Should -Invoke Invoke-RestMethod                # deliberately "at least once"
```

If you genuinely want at-least, omit `-Times` — that reads honestly.

> Guarded by `test/unit/PesterAssertionQuality.Tests.ps1`, which holds the count
> of bare `-Times` at **0**. Lower the baseline, never raise it.

In Vitest the naming is honest: `toHaveBeenCalled()` says at-least-once and
claims nothing more. `toHaveBeenCalledTimes(n)` is exact.

### Size instead of content

```powershell
$ctx.ContainsEdges.Count | Should -Be 1     # blind to what is in the edge
```

A count cannot see a flag flipped on a record or a field dropped from a
relationship. In this codebase that matters concretely: an Azure `Contains` edge
that loses `propagates` makes every child scope look unaffected by its parent's
RBAC assignments, while the count stays correct.

Assert the fields that carry meaning. The same applies to `toHaveLength` in the
JS suites when it is the only assertion in a test.

### Comparisons neutered by the language

| Written | Why it cannot fail |
|---|---|
| `$uri \| Should -Not -BeLike '*?*'` | `?` is a single-character **wildcard**; matches any non-empty string |
| `$keys \| Should -Not -Contain "$([char]0xFEFF)name"` | `-contains`/`-eq` are **linguistic**; U+FEFF is ignorable, so it equals `"name"` |
| `$s.Count \| Should -Be 1` on an unwrapped single-element list | PowerShell unwraps one-element collections; a hashtable's `.Count` is its **key count** |
| `-ForEach @($null, 429)` | Pester coerces a `$null` element into a **hashtable binding** — the null case never runs |
| `$PSBoundParameters` captured inside a `Mock` body | That is the **mock's** binding, not the caller's. Use `-ParameterFilter` |

---

## Fixtures that never reach the branch

The scenario is set up, never materialises, and the assertion passes down a
different path. Three shapes to watch for:

- **A fixture the reader cannot parse.** Status codes are the usual case: a
  helper doing `[int]$err.Exception.Response.StatusCode` gets `$null` from a
  `{ value__: 429 }` shape, and every status-specific branch is skipped in favour
  of the "no status at all" path. Use
  [`test/lib/HttpErrorFixtures.psm1`](https://github.com/Fortigi/IdentityAtlas/blob/main/test/lib/HttpErrorFixtures.psm1)
  rather than hand-rolling one — it owns the shapes and asserts they are not
  interchangeable.
- **A guard something else already satisfied.** A single UTF-8 BOM never reaches
  a BOM-stripping guard, because `StreamReader` consumes it first.
- **A default overridden in every test.** Overriding a retry ladder to `@(0)` for
  speed is good practice — but if *every* test does it, the shipped values have
  no coverage at all. Add one test that uses the real default.

---

## Choosing inputs that discriminate

The highest-leverage habit here, and it is measurable. Two batches written
against the same functions at comparable effort:

| batch | tests | mutants killed |
|---|---|---|
| plausible inputs | 14 | **2** |
| discriminating inputs | 13 | **9** |

The whole difference was the values:

- A `-gt 0` guard behaves identically at 0 and 3. Only **1** separates it from `-gt 1`.
- A `Count -eq 0` guard needs a **one-element** case, not an empty one.
- A chunk size of 1000 needs **1001** items to show the boundary.
- `Select-Object -First 1` looks right on a single-valued header. Only a
  **two-valued** one distinguishes it from `-First 2`.
- A precedence rule needs a case carrying **both** keys, where the lower-priority
  one matches.

Ask of each test: *if this condition were off by one or inverted, would my input
produce a different result?*

**Resist calling a survivor "equivalent" before trying.** A boundary that looks
untestable often is not — an expiry comparison reachable only at the exact
expiry instant is testable with `vi.useFakeTimers()`, and it encoded an
undocumented policy decision (is a token valid *at* its expiry?).

---

## Mutation testing

Two suites, two tools. Both answer "would a wrong answer be caught?", which
coverage cannot.

### PowerShell — PSMutant

Config: `.ci/psmutant.config.json`. Every eligible crawler file must be in
`mutate` or in `exclusions` with a written reason, enforced by
`test/unit/PSMutationScope.Tests.ps1`.

```bash
Install-Module PSMutant
Invoke-PSMutation -ConfigFile .ci/psmutant.config.json -SourceRoot .
```

**Map a file to the cheapest suite that exercises it.** The mapped tests run once
per mutant — one mapping to a suite that starts a mock HTTP server took a
baseline from 10s to 73s and made the run look hung.

### JavaScript — Stryker

Config: `app/api/stryker.auth.config.json`. Run it via the npm script:

```bash
cd app/api && npm run test:mutation
```

Use the script, not `npx stryker` — npx can resolve the **deprecated standalone
`stryker` package** from its cache instead of the installed
`@stryker-mutator/core`, failing with `Cannot find module 'rx'`.

Two constraints worth knowing before you widen the scope:

- **Stryker sandboxes `app/api` alone.** Any test reading the real filesystem —
  an upload path, or the crawler manifests at `../../tools/crawlers` — resolves
  nothing in the sandbox, fails the dry run, and aborts the whole run before a
  single mutant is evaluated. `vitest.stryker.config.js` narrows the include for
  this reason. Prefer a narrow include over a growing exclude list: an excluded
  test that happened to be a mutant's only killer becomes a **false survivor**,
  and a wrong number is worse than a smaller true one.
- **`StringLiteral` and `ObjectLiteral` are disabled.** On a module that is
  largely a catalog of labels and descriptions, mutating that text produced 68 of
  72 survivors and pulled the score to 32.7% while saying nothing about
  behaviour. With them off the same file scores 100%, and the number means "did a
  wrong *decision* get caught". The cost: SQL strings are not mutated either, so
  this cannot tell you a query is correct — that stays the contract tests' job
  (the unit mocks are SQL-blind by design; see `app/api/CLAUDE.md`).

### A worked example of why coverage is not enough

`src/auth/permissions.js` sat at **100% line, branch and function coverage** and
scored **32.7%** under mutation. Four of its survivors were real, two of them
authorization behaviour:

- `Admin: ['*']` — the wildcard is what lets a newly added permission reach the
  admin role. Nothing asserted it, so replacing it with `[]` survived.
- `mapping?.[role]` — the optional chain is load-bearing. Without it a tenant
  whose role mapping is not yet configured gets a **throw instead of an empty
  permission set**, turning "no permissions" into a 500 on every authenticated
  request.

Both are now tested. The credential path is at **100%** mutation score.

---

## Writing an exclusion reason

`exclusions` demands a reason, which is right, and has one sharp edge:

> **A reason that sounds authoritative is harder to dislodge than a blank one.**

Reasons in this repo have been wrong because they were reasoned rather than
measured — a cause blamed on assertion style that turned out to move a score by
**0.0 points**, a count of "five" cases where there were eight, a claim that a
layer was structurally untestable when it held 158 named functions and 263
existing tests.

**Measure first.** If you have not measured, write exactly that — "not yet
measured" is honest and invites the check. Every exclusion in the config today
carries a measured number.

---

## Pester traps specific to this repo

- **Functions declared in a `Describe` body only exist during discovery.** Put
  helpers in `BeforeAll` or they are `CommandNotFound` at run time.
- **`Should -Invoke` counts accumulate across a whole `It` block.** A `foreach`
  loop comparing a running total per case fails on the second iteration. Use
  `It … -ForEach`.
- **Loop variables are case-insensitive against mock parameters.** `$seconds`
  shadows a mock's `$Seconds`, so `-ParameterFilter { $Seconds -eq $seconds }`
  compares the value to itself and matches everything.
- **`[System.Net.HttpStatusCode]` has no member for 499 or 599.** Casting throws;
  boundary tests for a 5xx range need a plain `[int]`.
- **A blanket regex over a test file edits comments too.** A bulk `-Times` →
  `-Exactly` rewrite silently mangled a doc comment explaining the rule. Use the
  same predicate in the fixer as in the counter, and read the diff.

---

## The guards

| Guard | Protects |
|---|---|
| `test/unit/PesterAssertionQuality.Tests.ps1` | Bare `-Times` ratchet (at 0); the HTTP-fixture contract |
| `test/unit/PSMutationScope.Tests.ps1` | Every eligible crawler file mutated or excluded with a reason; every mutated file names a suite that exercises it |
| `test/lib/HttpErrorFixtures.psm1` | One owner for HTTP-error shapes |
| `tools/generate-coverage-doc.py` | Generates the scope and shape caveats on the coverage page |
| `.ci/psmutant.config.json` / `app/api/stryker.auth.config.json` | The mutation scope declarations |

---

## Where the work stands

**In mutation scope:** the crawler shapers, the shared ingest library, the
`*.Functions.ps1` layer, the OData library, the SDK's Graph pager, the
Azure/midPoint helper clients (23 PowerShell files), and the API credential path
(100%).

**Open:**

- **The crawler Phases layer** — five files at **50.1%**, 337 surviving mutants
  across 158 functions. No single cause; it is sustained test-writing. The
  technique that moves it is asserting payload content rather than collection
  counts.
- **`tools/powershell-sdk/` and `tools/riskscoring/`** have no eligibility
  definition, so the scope guard cannot see them.
- **The UI suite** has no mutation evidence, and its method coverage (69.2%) sits
  below its line coverage (80.9%) — the signature of components rendered but
  never driven.

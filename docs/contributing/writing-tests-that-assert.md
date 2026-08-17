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
| `@($x).Count \| Should -Be 0` | **`@($null).Count` is 1, not 0.** Wrapping null yields a one-element array holding null |
| `[regex]`-free `Should -BeLike '*[3/10]*'` | `[...]` is a wildcard **character class**, so this matches one of `3 / 1 0`. Use `Should -Match ([regex]::Escape(...))` |

**`@($null).Count == 1` deserves its own line** — it caused three separate wrong
results in one sitting, and each time it read as a real failure rather than a
broken assertion:

- a guard counting an absent property failed every run that had nothing to report;
- a test asserting "no records were produced" reported one record, because the
  variable had been assigned **inside** a `Should -Not -Throw` scriptblock (a child
  scope), so the outer variable stayed `$null`;
- a test asserting on `$result.MissingSyncKeys` — a property that does not
  exist — counted `@($null)` and got 1.

Two habits kill all three: assign outside the scriptblock, and check the shape of
what a function actually returns before asserting on a property name.

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
Install-Module PSMutant -RequiredVersion 0.2.0
Invoke-PSMutation -ConfigFile .ci/psmutant.config.json -SourceRoot .
```

**Map a file to the cheapest suite that exercises it.** The mapped tests run once
per mutant — one mapping to a suite that starts a mock HTTP server took a
baseline from 10s to 73s and made the run look hung.

**Re-check survivors instead of re-running everything.** Killing survivors is an
edit-run-edit loop, and re-running the mutants you already killed is most of the
wait:

```bash
Invoke-PSMutation -ConfigFile .ci/psmutant.config.json -SourceRoot . \
    -RecheckFrom reports/ps-mutation.json
```

It reports counts, never a score — the set is filtered, so no percentage over it
means anything — and writes to `*.recheck.json` so it cannot overwrite the
baseline. It refuses outright if the mutated source or the operator set changed,
because mutants are matched by AST-walk position. **Finish with a full run before
trusting a number**: a recheck is sound only for *added* assertions, since editing
an existing test can revive a mutant it never evaluates.

**A mutant that provably cannot change behaviour can be declared**, with a reason,
in the config's `equivalents` map. The declaration is checked, not merely
recorded: the run fails if a declared mutant is ever killed, or if it stops
existing. Nothing in this repo is declared yet — the remaining survivors here are
progress percentages and log constants, and leaving them visible is honest.

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
- **Angle brackets in an `It` name are a data placeholder.** Pester expands
  `<...>` for `-ForEach`, so `It 'attributes it to <script-body>'` is parsed as
  the expression `$script-body` and the test dies with a token error *before it
  runs*. It reads exactly like a broken fixture.
- **Only one `BeforeEach` per block takes effect.** A second one in the same
  `Describe` replaces the first, silently dropping its mocks — which surfaces as
  the real function running and failing on something unrelated.

---

## Assumptions worth checking before you assert

Every item here was written confidently, run, and turned out to be wrong. The
pattern is the same each time: an assertion built on a guess about *shape* or
*mechanism* rather than on something observed.

- **Does the test file you edited actually cover the mutant?** Mutation maps each
  source file to named suites. A ternary case added to the wrong suite left the
  mutant alive while the behaviour was genuinely covered — the test was right and
  the mapping was not.
- **Is the thing you asserted the observable difference?** "The file is unchanged"
  passed against a mutant that *did* rewrite the file, because the rewrite
  reserialised the same object byte-for-byte. The observable difference was
  whether the write **happened**, so the assertion had to be on the call.
- **Is the mutant reachable at all?** Two guards here look like gaps and are
  equivalent: `foreach ($x in $null)` is a no-op in PowerShell, so a bail-out
  before an empty loop changes nothing; and `$r -and $r.Count -gt 0` differs from
  `-or` only when `$r` is the scalar `0`. Check before writing the test, and say
  so in the comment when the answer is "equivalent".
- **Does the API behave the way its name suggests?** `-Force` on one SDK function
  was declared `[string]`, so the natural `-Force` call *failed* and only
  `-Force 'True'` worked. The test found the defect; assuming the signature would
  have hidden it.

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

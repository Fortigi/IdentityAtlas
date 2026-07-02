# Mutation testing (StrykerJS)

Line/branch coverage only proves a line *ran*. Mutation testing proves a test would
*catch a bug* in it: Stryker injects small faults (flip `>` to `>=`, `&&` to `||`,
empty an array, blank a string) and checks whether the suite fails. The **mutation
score** is the percentage of injected faults ("mutants") the tests killed.

It's the metric that catches the failure mode line coverage can't: tests that execute
code without asserting anything meaningful. Our pilot made the point immediately —
`src/ingest/validation.js` has near-total *line* coverage but scored **~39% mutation**:
hundreds of injected faults survived because no assertion pinned the behaviour down.

## Run it

```bash
cd app/api
npm run test:mutation                # full run over the configured scope
npm run test:mutation:incremental    # only re-tests mutants affected since the last run
```

Open the report at `app/api/reports/mutation/mutation.html` (also emitted as
`mutation.json` for tooling). The clear-text output lists every surviving mutant with
its file:line and the exact source→mutated diff — each survivor is either a missing
assertion, an equivalent mutant (a change that can't alter behaviour), or dead code.

## How it's wired

| File | Role |
|---|---|
| `stryker.conf.json` | Stryker config. `mutate` lists the modules under test; `coverageAnalysis: perTest` means a mutant only re-runs the handful of tests that actually cover it. |
| `vitest.mutation.config.js` | The test suite Stryker runs — a **hermetic, DB-free subset** (see below). Normal `npm test` still uses `vitest.config.js`. |

**Why a separate vitest config?** Stryker copies the project into a sandbox and re-runs
the suite many times, so the run must be self-contained and fast. `vitest.mutation.config.js`
therefore includes **only** the unit tests that cover the mutated modules — not the whole
`src` tree, not the Postgres **contract** suite, and not the cross-tree `tools/crawlers/**`
tests (they live outside `app/api` and aren't in the sandbox). It also excludes the
`assignmentTypes.guard.test.js` static scan, which walks the repo-root `tools/crawlers`
tree and can't resolve that path inside the sandbox.

## Scope: what belongs under mutation

Mutation testing pays off on **pure / DB-free logic** where a subtle fault would be a real
bug: validators, transforms, classifiers, SQL-fragment builders, the ingest/effective-access
engines. It's the right complement to the crawler decomposition — those `ConvertTo-*` /
`Sync-*` units are exactly this shape (though Stryker is JS-only; PowerShell has no mainstream
mutation tool yet).

Route handlers and raw-SQL modules are exercised by the **contract suite** against a real
database — that's the correct tool for them, and they stay **out** of `mutate`.

### Growing the scope

1. Add the module to `mutate` in `stryker.conf.json`.
2. Add the glob for the unit tests that cover it to `include` in `vitest.mutation.config.js`
   — DB-free / filesystem-free suites only.
3. Run `npm run test:mutation` and drive the surviving mutants down by adding assertions.

Treat the score like the complexity ratchet: **directional**. Raise `thresholds.break` in
`stryker.conf.json` from `null` (report-only) to a floor once a module's score is healthy,
so it can't regress. Don't chase 100% — equivalent mutants and untested log/error strings
make the last stretch noise.

## CI

A full mutation run is heavier than unit tests, so it's **not** on the normal PR path. Two
sensible options (not yet wired):
- **Incremental on PRs touching in-scope files** — `npm run test:mutation:incremental`
  commits a `.stryker-incremental.json` cache so only changed mutants re-run.
- **Scheduled full run** (nightly/weekly) that publishes the HTML report as an artifact.

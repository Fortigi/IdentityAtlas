# Drift & Regression Gate — Outstanding Items

Backlog from the drift/regression audit (a 63-agent review that mapped each
recently-fixed drift vector to its test/CI gate and adversarially verified the
gaps). **All HIGH-severity gaps are closed**; what remains is MEDIUM/LOW.

Keep this file current: when a PR closes an item, move it to **Shipped** with the
PR number; when a new gap is found, add it under **Outstanding**.

---

## Shipped

| Gap | PR |
|-----|----|
| `assignmentType`/`resourceType` enforced at the DB (CHECK constraints) | #604 |
| Node version — `.nvmrc` single source of truth + gate | #607 |
| `resourceType` retired-literal source-hygiene scan | #610 |
| Migration immutability gate (checksum baseline) | #611 |
| App-owner / app-permission crawler helper unit tests | #612 |
| OpenAPI drift — classify **every** router (new surface can't escape) | #613 |
| Contract-suite flakiness — `fileParallelism: false` | #614 (closes #606) |
| Diff-coverage gate — changed lines must be tested | #615 (stacked on #614) |
| Retired `Owner` removed from mock dataset + lock test | #616 |
| Nightly runner `node:20`→`24` + node-version gate scans `.ps1` | #617 |
| Owner-model UI badge tests (`colors.test.js` + Excel legend) | #618 |

---

## Outstanding — MEDIUM

### Data model / retired types
- **assignmentType schema-invariant test** — the enum lives on two hand-maintained
  schema objects in `validation.js`; a *new* ingest schema referencing
  `assignmentType` wouldn't be auto-guarded. Add a test that introspects `SCHEMAS`
  and asserts every schema with an `assignmentType` field constrains it to the enum.
- **Migration 046 contract test** — no real-schema test for the `Owner → GroupOwnership`
  resource + `HasOwnership` relationship + `Direct` rewrite (unlike 045's
  `collapseSourceTypes.contract.test.js`). Add `ownerAsResource.contract.test.js`.
- **Matrix matview column-set contract test** — nothing pins the LIVE matview's
  full column set/semantics; the only structural test reads the *superseded*
  migration 037's SQL text. Add a contract test asserting the identity-arm columns
  a matview redefinition must not silently drop/rename.

### Risk / OpenAPI
- **Risk-tier exhaustive boundary test** — the route test only distinguishes the
  85→High boundary. Drive the override handlers across *every* cutoff
  (90/70/40/20/1) and assert `riskTier` on both sides.
- **OpenAPI allow-list integrity** — `INTENTIONALLY_UNDOCUMENTED` is a pure escape
  hatch (append a line to silence the guard). Constrain *why* an entry is allowed
  (e.g. bound it to an internal-path prefix), not just *that* it's registered.

### Coverage / complexity ratchets
- **Coverage auto-baseline** — JS floors are manual and sit just below measured;
  no committed baseline like the complexity/filesize gates. (#615 covers the
  per-change intent; a committed per-file baseline tool is the rest.)
- **Pester (PowerShell) coverage floor** — PS coverage is computed but only fails
  on test failures; no floor/ratchet like the JS side. Commit a `.ci` floor and
  enforce `CoveragePercent >= floor` in the Pester job.
- **File-length & complexity gates must block merge** — verify "File-length ratchet"
  and "Complexity ratchet" are in the branch ruleset's required status checks; a
  red status must block merge.

### Hygiene gates
- **Empty-fragment changelog** — the gate only checks a `changes/*.md` appears in
  the diff, never opens it. Require at least one non-blank bullet line.
- **"test required" is shallow** — only checks a test file changed, not that it
  covers the change or asserts anything. (Pair with the Pester coverage floor above
  for the PS side.)
- **jscpd is repo-aggregate** — 2% over the whole repo, `minTokens=50`/`minLines=10`;
  a small pasted block or a PR-level dup is invisible. Add a delta/PR-scoped
  duplication check.

### Context cycles (deferred — see note below)
- **`repairPluginCycles()` untested** — no test fails if the reactive repair is
  removed. Add a runner contract test that reconciles a genuinely cyclic batch.
- **Delta deletion-only path skips repair** — the `(inserted+updated) <= 0` trigger
  can skip cycle repair on a delta whose net effect is deletions + a parent-pointer
  change. Add an end-to-end contract test.

### Crawler correctness
- **Secret-free resourceType allow-list e2e** — the deep tenant test that would
  catch a wrong `resourceType`/broken shape needs secrets. (#610 scan + #604 CHECK
  partially cover.) Add a secret-free resourceType check.

---

## Outstanding — LOW

- **OpenAPI router derivation** — `DOCUMENTED_ROUTERS` is hand-maintained (#613
  classifies all routers but doesn't derive the documented set from spec tags /
  `app.js` mounts).
- **Raw-SQL `parentContextId` cycle scan** — migrations/other server-side writers
  of `parentContextId` are unguarded for cycles. Add a static-scan guard.
- **600-line "smell" tier** — `tools/filesize/ratchet.py` hardcodes `CEILING=1000`;
  the CLAUDE.md 600-line smell is unenforced. Add a soft warning tier.
- **JS/TS cognitive-complexity gate** — the cognitive gate covers only `ps`/`py`;
  a deeply-nested JS function passes if cyclomatic ≤ 20. Add `sonarjs/cognitive-complexity`.
- **jscpd/hygiene ignore `.sql` and `.mjs`** — duplicated migration SQL and new/changed
  `.mjs` product code need neither a changelog nor a test. Close the globs.
- **`skip-hygiene` label is a silent job-skip** — make the escape hatch observable
  (a job that always runs and honours the label internally) rather than a skipped job.
- **Desktop launcher Node pin** — `build-node-launcher.mjs` pins exact `24.16.0`
  (+ ABI/SHA) while everything else uses floating `24`; the node-version gate
  doesn't scan `.mjs`. Extend the gate to the `.mjs` `NODE_VERSION` pin.
- **PSMutant is advisory** — mutation testing has `thresholds.break = null` and only
  runs on some diffs. Flip to a soft-then-hard gate for the crawler transforms.

---

## Notes / deliberately deferred

- **Context-cycle write paths** — a standing decision left the ingest/plugin/direct-SQL
  write paths able to persist a cyclic `parentContextId` (read-side CYCLE guards only).
  The MEDIUM/LOW context items above are the follow-ups.
- **`engine.js` `Owner` ownership queries** — the risk engine still queries
  `WHERE "assignmentType" = 'Owner'`, which returns 0 rows post-migration-046.
  Tracked separately (issue #598) — it needs a decision on whether ownership should
  feed risk, not just a mechanical rename.

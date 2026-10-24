---
type: concept
prereq: concepts/data-model.md
outcome: You know how several accounts become one person, and what happens when the match is wrong.
---

# Account Linking — architecture

!!! info "Before this page"
    Assumes you have read **[Data Model](../concepts/data-model.md)**.
    Brand new? Start at [The words you need first](../start/glossary.md).

> **Status:** current as of June 2026.
> Companion to [`030_account_linking.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/030_account_linking.sql) and the [Context Redesign](context-redesign.md) (the `orphaned-accounts` plugin).

## Purpose

Most directory-only deployments have **no IGA platform** feeding authoritative identities. Entra ID alone gives you accounts, not people: one person frequently owns a primary account, an admin account (`adm-jdoe`), a guest invite, and the odd secondary account. Without a correlation step, each of those shows up as its own row everywhere.

Account Linking is the step that attaches those orphan accounts to an existing Identity, with a confidence score, so the matrix, the identity graph, and risk scoring can reason about the *person*. It is **deterministic — there is no LLM**. The match logic is an editable dictionary of weighted signals plus regex account-type rules; an analyst tunes it from Admin → Account Linking and reviews the results.

This replaces the v4 PowerShell "account correlation" job (and the abandoned v5 LLM correlation wizard). See [History](../history.md).

## The deterministic engine

The engine lives in [`app/api/src/accountlinking/`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/accountlinking/):

| Module | Responsibility |
|---|---|
| `defaultRules.js` | The shipped default dictionary (`DEFAULT_RULES`). |
| `classifier.js` | Pure helpers: account-type classification, email-local-part / prefix handling, name parsing, graded name matching. Regex rules are compiled with **RE2** (linear-time, ReDoS-safe). |
| `engine.js` | `scoreMatch`, `buildLinks` (pure scoring), and `runLinking(runId, configId)` (the DB-writing run). |

A run is top-down: for each existing Identity, find orphan accounts that belong to that person and attach them.

### The dictionary

The dictionary is shipped with sensible defaults (`DEFAULT_RULES`) and is editable per-tenant via `AccountLinkingConfig.rules`. It has four parts:

```jsonc
{
  "signals": [
    { "name": "employeeId",  "type": "exact",  "field": "employeeId", "weight": 95 },
    { "name": "email",       "type": "exact",  "field": "email",      "weight": 90 },
    { "name": "emailPrefix", "type": "prefix", "field": "email",      "weight": 80,
      "stripPrefixes": ["adm-", "adm_", "a-", "a_", "admin-", "admin_", "ext-", "ext_", "svc-", "s-"] },
    { "name": "fullName",       "type": "name", "level": "full",           "weight": 60 },
    { "name": "surnameInitial", "type": "name", "level": "surnameInitial", "weight": 45 }
  ],
  "accountTypeRules": [
    { "accountType": "Admin",   "priority": 1, "patterns": ["^adm[-_]", "^a[-_]", "[-_]admin@", "\\badmin\\b", "\\(adm"] },
    { "accountType": "Guest",   "priority": 1, "patterns": ["#ext#"] },
    { "accountType": "Service", "priority": 2, "patterns": ["^svc[-_]", "^s[-_]", "\\bservice account\\b"] },
    { "accountType": "Shared",  "priority": 3, "patterns": ["\\broom\\b", "\\bequipment\\b", "\\bshared\\b", "\\bmailbox\\b"] }
  ],
  "linkThreshold": 50,
  "onlyLinkTypes": ["Admin", "Guest", "Secondary"]
}
```

- **`signals`** — weighted match rules. An orphan links to the candidate identity with the highest *summed* weight that clears `linkThreshold`. Strong signals (`employeeId`, `email` exact, `emailPrefix` after stripping a known prefix) are near-certain; name signals are softer (see below).
- **`accountTypeRules`** — regex patterns that classify an account's type. Lowest `priority` wins; the matched pattern is recorded on the link (`accountTypePattern`). Anything that matches nothing is `Secondary` (a plain extra human account). Directory metadata is the strongest guest signal: `userType=Guest` or an `#ext#` UPN short-circuits to `Guest` before the regexes run.
- **`linkThreshold`** — the minimum confidence to auto-link, surfaced as the **certainty slider** in the admin UI. The shipped default is `50`, which links name-only matches (they land around 45–60) at honest, low confidence; raise it to require stronger evidence.
- **`onlyLinkTypes`** — only these account types are attached to a person. `Service` and `Shared` accounts are deliberately left out so they fall through to the Orphaned Accounts context rather than being glued onto a person.

### Graded name matching + ambiguity guard

`nameVariants` reduces a person to **every name they are known by**, each a `{ given, surname, initial, key, variant }`. There are two independent sources and neither is authoritative, so both are kept:

| Variant | Source |
|---|---|
| the columns | the structured `givenName` / `surname` fields |
| the display name | the parsed free-text `displayName` |
| one half from each | whichever half a column leaves empty, filled from the display name |

Identical variants collapse, so the common case — every source spelling the person the same way — is a single name.

`variant` records *which* of the person's names each one is, which is what the ambiguity guard below weighs:

| `variant` | Meaning |
|---|---|
| `inUse` | the name they are known by, which is what their accounts are spelled with: the display name's halves, or a column the display name does not contradict |
| `birth` | a surname only the `surname` column holds while the display name spells a different one — the birth surname behind a partner name or a double name |

A column surname is only read as a birth name where a parsed display surname actually disagrees with it. A source that fills the columns and nothing else is stating the name in use like any other, and a key two of a person's names collapse onto keeps the stronger of the two variants (`nameKeyVariants` in `engine.helpers.js`).

Why both: HR sources routinely hold the **birth surname** in the `surname` column while the display name, and the accounts provisioned from it, carry the **name in use** — a partner name or a double name. Reading only the columns unlinks everyone whose name in use differs from their birth name (the larger population by far); reading only the display name re-opens the title mis-parse below. So a person is indexed under all of their names, and `bestNameMatch` takes the strongest match across every pair — a match on either name counts.

When the display name *is* parsed, three things happen before the halves are taken:

1. **Role/company qualifiers are stripped** — `(OGD)`, `[extern]`, `(ADM-azure)` — so `Euson, Robin (OGD)` and `(ADM-azure) Euson, Robin` both reduce to `{euson, robin}`. Both `Surname, Given` and `Given Surname` orderings are handled.
2. **Pre- and post-nominal titles are stripped** — `drs.`, `dr.`, `ir.`, `ing.`, `prof.`, `MSc`, `BSc`, `MBA`, `LLM`, `PhD`, … — repeatedly, from both ends, so `Prof. dr. ir. Willem van der Laan MSc` reduces to `{willem, vanderlaan}`. The strip never removes so much that fewer than two name tokens remain, which is what keeps a genuine short surname that happens to spell a degree (`Jan Ma`) intact.
3. **The surname keeps its particles.** In the `Given Surname` ordering the surname runs from the first particle (`van`, `de`, `den`, `der`, `ter`, `ten`, …) to the end of the name, including a hyphenated compound whose tail is a particle (`Schilder-van der Steen`). With no particle present it is the last token only, so inconsistently-recorded middle names still collapse (`John Michael Doe` → `{john, doe}`). Taking only the last token instead would reduce every `van den Berg` in a tenant to `berg`, and conflate `van der Steen` with `Schilder-van der Steen`.

The title and particle lists live next to `QUALIFIER_RE` in `classifier.js`; they are not per-tenant editable today.

`nameMatchLevel` returns the strongest of:

| Level | Meaning | Default weight |
|---|---|---|
| `full` | same surname **and** same given name | 60 |
| `surnameInitial` | same surname **and** same given initial (e.g. `r.euson` vs `robin.euson`) | 45 |
| `none` | otherwise (surname-only is treated as no match) | — |

The two name signals are mutually exclusive — only the signal whose `level` equals the computed best level fires.

**Ambiguity guard:** a *name-only* best match (no strong email/employeeId signal) that ties in confidence across multiple identities is too risky to auto-pick, so the engine leaves the account orphaned for manual review rather than guess. Two genuine namesakes therefore produce a review item, not a guess — including when one of them carries a title in their display name and the other does not, which previously hid one of the pair from the candidate set and made the guess look certain.

A name tie is read **per name key** (`resolveNameTie` in `engine.helpers.js`) before it is treated as a tie at all. Since a person is indexed under several names, the question is asked once per name the account carries: if exactly one of the equally-scoring identities has the strongest claim to one of those names, it is the match. It stays a tie, and the account goes to review, when no name singles anyone out or when different names single out different people. The resolution does not depend on the order identities were indexed in.

Within one key the claims are usually unequal, and **a match is only as strong as its weaker side**: it is a match on the name in use when the account *and* the identity are both spelled that way under that key, and a birth-name match when either side holds it only in a structured column. Accounts are provisioned from the name in use, so where both kinds meet under one key the name in use wins outright:

- An `Anna Jansen` account, an identity called `Anna Jansen`, and a second identity called `Anna de Boer-Jansen` whose HR record still carries `Jansen` in its `surname` column — all three under `jansen|anna`. The account is the first one's; the birth surname does not make it a review item. Indexing the birth-name variant without this rule turned links the engine used to make into ties.
- Equally strong claims still tie: two people who both *go by* the name, or two for whom it is equally a birth surname, send the account to review.
- Where the account itself carries the key only in its own `surname` column, neither side's claim is the name in use and the claims are left unranked — that key is an old name on both sides, so ranking it would hand the account to a stranger over the name it is actually spelled with.

### Candidate scope = orphans only

The only accounts the engine ever considers are **orphan Principals** — *live* Principals with no `IdentityMembers` row — excluding `ServicePrincipal`, `ManagedIdentity`, and `AIAgent` principal types. Accounts already attached to an Identity (e.g. by the crawler's IdentityFilter) are never disturbed. Candidates per orphan are narrowed by indexing identities on employeeId, email-local-part (raw and prefix-stripped), normalized display name, and an order-independent surname+given key **per name the person is known by**, so only plausible identities are scored and neither the birth name nor the name in use is a dead end.

**Accounts a sync has removed are not orphans.** A full sync does not delete a principal that vanished from its source — it stamps `deletedAt` and keeps the row ([soft delete](soft-delete.md)). A tombstoned account is therefore excluded from the candidate set, from the `orphansRemaining` statistic, and from the Orphaned Accounts report and context: it is not work the analyst still has to do. The symmetric half of that decision is that an account linked *before* it was removed **stays linked** — soft delete never detaches a person's history, and re-ingesting the account clears the stamp and makes it linkable again.

Excluding them is a correctness rule, not a tidier count. A leaver is usually gone from the HR source too, so their account's own identity no longer exists — and what is left matching it is *someone else*: a live namesake, or a colleague whose record still carries the leaver's surname (the `Anna de Boer-Jansen` shape above). With no rival claimant nothing ties, so the ambiguity guard has nothing to refuse, and a name-only match at weight 60 clears the default threshold of 50 on its own. The measurement on #1442 found exactly that: every removed account a first run attached went to a different, live person, who then inherited a leaver's account and every grant on it. The live-rows filter is what prevents it — the engine itself cannot tell the two people apart, because nothing in the names says they are two people.

That one definition — the `Principals` anti-join against `IdentityMembers`, restricted to live rows and human principal types — lives only in [`accountlinking/orphanQuery.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/accountlinking/orphanQuery.js). Callers that need a different projection build their query with its `orphanPrincipalsSql()` rather than re-inlining the anti-join; the engine's two hand-written copies are what let the live-rows filter go missing from all three selections ([#1442](https://github.com/Fortigi/IdentityAtlas/issues/1442)).

### Confidence scoring + writes

`scoreMatch` sums the weights of every matched signal, capped at 100. `buildLinks` keeps the highest-scoring candidate above `linkThreshold` per orphan. When `runLinking` writes the links into `IdentityMembers`:

- A non-primary member row is created (or updated) with `linkConfidence`, `linkSignals` (stored as a CSV string), `accountType`, and `accountTypePattern`.
- Per-identity rollups are written back to `Identities`: `accountCount`, `linkConfidence` (the best newly-linked account), `linkSignals` (the union), and `linkedAt`.
- **Analyst decisions win.** A member with any `analystOverride` is never overwritten, and an account the analyst marked `rejected` is never re-linked to anyone.

## Scheduling

Account Linking runs on a schedule and on demand. Configuration and run history mirror the risk-scoring substrate (`RiskClassifiers` / `ScoringRuns`):

| Table | Role |
|---|---|
| `AccountLinkingConfig` | Single active config row: `rules` (the dictionary), `schedules` (array), `isActive`, `updatedBy`. |
| `AccountLinkingRuns` | One row per run: `status`, `step`, `pct`, `candidatesScanned`, `linksCreated`, `linksUpdated`, `skippedAnalystOverride`, `orphansRemaining`, timestamps, `triggeredBy`. |

[`scheduler.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/scheduler.js) ticks every 60 s. Each tick it loads active configs that have at least one schedule, matches each `schedule` against the current minute, and queues a run (`triggeredBy = 'scheduler'`). A 55-minute look-back on `AccountLinkingRuns` prevents double-firing across container restarts. Runs are fire-and-forget — `runLinking` records its own progress and errors into the `AccountLinkingRuns` row, the same pattern manual runs use.

## The "Orphaned Accounts" context

Orphan-ness is **never modelled as a property** on the principal — it is context membership. The [`orphaned-accounts`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/contexts/plugins/orphaned-accounts.js) context plugin (a `targetType: 'Principal'` generated context) emits a tree of every live Principal not linked to any Identity, sub-grouped by detected account type (`Admin` / `Guest` / `Service` / `Shared` / `Secondary`). It runs:

- standalone from Admin → Contexts, and
- automatically as the final step of every Account Linking run, so the context always reflects what linking could not attach.

The future principals-clustering plugin refines this set into thematic contexts.

## Crawler / Account-Linking ownership split

Two writers touch `IdentityMembers`, with a clean division:

- **The crawler owns score-less source links.** When a source system (e.g. an Omada IGA feed, or Entra's IdentityFilter) already knows that an account belongs to an identity, the crawler ingests that `IdentityMembers` row with **no** `linkConfidence` (NULL). These are authoritative, not guesses.
- **Account Linking owns scored links.** It only attaches orphans — accounts the crawler did *not* already link — and always writes a `linkConfidence`.
- **Analyst overrides win over both.** `analystOverride` (`confirmed` / `rejected` / `moved`) is set via `PUT /api/identities/:id/members/:userId/override` and respected by every re-run.

!!! note "Reconcile behaviour"
    A full crawl's `IdentityMembers` reconcile **preserves** the scored (Account Linking) and analyst-overridden rows rather than deleting accounts the crawler didn't re-send. The reconcile delete in [`ingest/engine.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/ingest/engine.js) (`scopedDelete`) skips any target row that carries a `linkConfidence` or an `analystOverride` — so a crawler full-sync only ever removes the score-less source links it owns, never Account Linking's or an analyst's. (The guard is a no-op for every other table, where neither column exists.)

## API

All endpoints are mounted under `/api`. Config writes and run starts are gated by the **`admin.crawlers`** permission (the same gate as risk-scoring runs); reads of config and runs are open to any signed-in user.

| Method | Path | Gate | Purpose |
|---|---|---|---|
| `GET`  | `/account-linking/config` | — | Active config, or the shipped defaults (`defaults: true`) when none exists. |
| `PUT`  | `/account-linking/config` | `admin.crawlers` | Upsert the single config row (`rules`, `schedules`, `isActive`). |
| `POST` | `/account-linking/runs` | `admin.crawlers` | Start a run. Returns `202` + the new run row; runs in the background. |
| `GET`  | `/account-linking/runs` | — | The 50 most recent runs, newest first. |
| `GET`  | `/account-linking/runs/:id` | — | Single-run status (for the polling UI). |

The analyst-facing override endpoints live on the identities route and are gated separately by `data.write.identity`:

| Method | Path | Gate |
|---|---|---|
| `PUT`    | `/identities/:id/members/:userId/override` | `data.write.identity` |
| `DELETE` | `/identities/:id/members/:userId/override` | `data.write.identity` |

## Related references

- Engine + dictionary — [`app/api/src/accountlinking/*`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/accountlinking)
- Run/config API — [`app/api/src/routes/accountLinking.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/routes/accountLinking.js)
- Orphaned Accounts plugin — [`app/api/src/contexts/plugins/orphaned-accounts.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/contexts/plugins/orphaned-accounts.js)
- Schema — [`030_account_linking.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/030_account_linking.sql)
- Scheduler — [`app/api/src/scheduler.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/scheduler.js)

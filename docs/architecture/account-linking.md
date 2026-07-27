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

Names are parsed from `displayName` (falling back to `givenName`/`surname`) with role/company qualifiers like `(OGD)`, `[extern]`, or `(ADM-azure)` stripped, so `Euson, Robin (OGD)` and `(ADM-azure) Euson, Robin` both reduce to `{euson, robin}`. Both `Surname, Given` and `Given Surname` orderings are handled.

`nameMatchLevel` returns the strongest of:

| Level | Meaning | Default weight |
|---|---|---|
| `full` | same surname **and** same given name | 60 |
| `surnameInitial` | same surname **and** same given initial (e.g. `r.euson` vs `robin.euson`) | 45 |
| `none` | otherwise (surname-only is treated as no match) | — |

The two name signals are mutually exclusive — only the signal whose `level` equals the computed best level fires.

**Ambiguity guard:** a *name-only* best match (no strong email/employeeId signal) that ties in confidence across multiple identities is too risky to auto-pick, so the engine leaves the account orphaned for manual review rather than guess.

### Candidate scope = orphans only

The only accounts the engine ever considers are **orphan Principals** — Principals with no `IdentityMembers` row — excluding `ServicePrincipal`, `ManagedIdentity`, and `AIAgent` principal types. Accounts already attached to an Identity (e.g. by the crawler's IdentityFilter) are never disturbed. Candidates per orphan are narrowed by indexing identities on employeeId, email-local-part (raw and prefix-stripped), normalized display name, and an order-independent surname+given key, so only plausible identities are scored.

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

Orphan-ness is **never modelled as a property** on the principal — it is context membership. The [`orphaned-accounts`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/contexts/plugins/orphaned-accounts.js) context plugin (a `targetType: 'Principal'` generated context) emits a tree of every Principal not linked to any Identity, sub-grouped by detected account type (`Admin` / `Guest` / `Service` / `Shared` / `Secondary`). It runs:

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

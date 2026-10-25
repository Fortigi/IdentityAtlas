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
| `classifier.js` | Pure helpers: account-type classification, email-local-part / prefix handling, name parsing, graded name matching, and the login name forms (`loginToken` / `loginNameForms` / `loginFormMatch`). Regex rules are compiled with **RE2** (linear-time, ReDoS-safe). |
| `engine.js` | `scoreMatch`, `buildLinks` (pure scoring), and `runLinking(runId, configId)` (the DB-writing run). |
| `engine.helpers.js` | Pure building blocks: identity indexing, candidate collection, the name-signal set and the graded name ladder (`strongestNameRung`), the `isNameOnly` predicate, the `nameClaim` name-uniqueness reading, reading stored `linkSignals`. |
| `staleNameOnlyLinks.js` | The retroactive cleanup: removes the engine-scored, analyst-untouched name-only links the active policy would no longer create. |

A run is top-down: for each existing Identity, find orphan accounts that belong to that person and attach them.

### The dictionary

The dictionary is shipped with sensible defaults (`DEFAULT_RULES`) and is editable per-tenant via `AccountLinkingConfig.rules`. It has five parts:

```jsonc
{
  "signals": [
    { "name": "employeeId",  "type": "exact",  "field": "employeeId", "weight": 95 },
    { "name": "email",       "type": "exact",  "field": "email",      "weight": 90 },
    { "name": "emailPrefix", "type": "prefix", "field": "email",      "weight": 80,
      "stripPrefixes": ["adm-", "adm_", "a-", "a_", "admin-", "admin_", "ext-", "ext_", "svc-", "s-"] },
    { "name": "loginNameForm", "type": "loginName", "field": "email", "weight": 55,
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
  "onlyLinkTypes": ["Admin", "Guest", "Secondary"],
  "allowNameOnlyLinks": true
}
```

- **`signals`** — weighted match rules. An orphan links to the candidate identity with the highest *summed* weight that clears `linkThreshold`. Strong signals (`employeeId`, `email` exact, `emailPrefix` after stripping a known prefix) are near-certain; name signals are softer (see below) and do not sum with each other.
- **`accountTypeRules`** — regex patterns that classify an account's type. Lowest `priority` wins; the matched pattern is recorded on the link (`accountTypePattern`). Anything that matches nothing is `Secondary` (a plain extra human account). Directory metadata is the strongest guest signal: `userType=Guest` or an `#ext#` UPN short-circuits to `Guest` before the regexes run.
- **`linkThreshold`** — the minimum confidence to auto-link, surfaced as the **certainty slider** in the admin UI. The shipped default is `50`. Name signals land at 45–60, so the threshold alone does not decide whether a name-only match links — the name-uniqueness guard below does. Raise the threshold to require stronger evidence from *every* match.
- **`onlyLinkTypes`** — only these account types are attached to a person. `Service` and `Shared` accounts are deliberately left out so they fall through to the Orphaned Accounts context rather than being glued onto a person.
- **`allowNameOnlyLinks`** — default `true`: a match whose signals are *all* name signals links where the name points at exactly one person, and is held for review where it does not (see the name-uniqueness guard below). Set to `false` — unchecking **"Link on a name match alone"** in the admin UI — to hold back *every* name-only match, which costs a source that carries nothing but display names (a badge system, many ERPs) all of its links. Only a literal `false` opts out; configs are merged over `DEFAULT_RULES`, so an install that never stored the key runs the shipped policy.

### Graded name matching + the name-uniqueness guard

`nameVariants` reduces a person to **every name they are known by**, each a `{ given, surname, initial, key, variant }`. There are two independent sources and neither is authoritative, so both are kept:

| Variant | Source |
|---|---|
| the columns | the structured `givenName` / `surname` fields |
| the display name | the parsed free-text `displayName` |
| one half from each | whichever half a column leaves empty, filled from the display name |

Identical variants collapse, so the common case — every source spelling the person the same way — is a single name.

`variant` records *which* of the person's names each one is, which is what the guard below weighs:

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

### The login read as a name

A login is a name too: `adm-fhogenbirk` says *the F. Hogenbirk of this tenant*. Until [#1454](https://github.com/Fortigi/IdentityAtlas/issues/1454) the only rule that read one was `emailPrefix`, which reads it as an **address** — strip a known prefix, then require the remainder to equal the person's email local part exactly. That recognises a single provisioning convention: where the personal mailbox is `f.h.hogenbirk` (two initials) and the admin login carries `fhogenbirk` (one), the weight-80 signal never fires and the account links only if its display name happens to spell the person's name. The reporting tenant measured 30 of 64 admin accounts linked, every one of them on `fullName`, none on a login. Separator-insensitive comparison does not bridge it either — `f.h.hogenbirk` reduces to `fhhogenbirk`, not to `fhogenbirk`.

So the `loginName` signal compares the stripped login against the forms a convention writes a *name* in (`loginNameForms` in `classifier.js`), graded by how much of the name each form carries:

| Form | Built from | Example for `Fay Hogenbirk` / `f.h.hogenbirk@…` |
|---|---|---|
| `full` | given name + surname, or the separator-stripped local part of the person's own address | `fayhogenbirk`, `fhhogenbirk` |
| `initial` | given initial + surname | `fhogenbirk` |

Read off **every** name the person is known by, and each form records which name it came from (`inUse` / `birth`) like a parsed name does. The grade says what the form *carries*, never where it was read from: a person whose own address is already the short form (`j.jansen` for Jan Jansen) is listed at `initial` like everybody else spelled that way — read as a `full` form it would outrank the real initial-level claimants and silently break the tie between two people genuinely called the same thing.

Two consequences, both deliberate:

- **It is name-class evidence, not address evidence.** Its weight is **55** — it clears the shipped threshold of 50 on its own where the login points at exactly one person, sits below `fullName`, and never inherits `emailPrefix`'s near-certain 80. `adm-pmunck` fits every P. Munck in the tenant, and this engine decides whose access review, risk score and leaver handling an admin account inherits, so a derived name form must never be near-certain. It therefore goes through the name-uniqueness guard below and is counted in `nameOnlyMatches` / suggestions.
- **Scope.** This reads the email/UPN login. `Principals` has no separate login column — crawlers store mail-or-UPN in `email` — so a source that supplies no address at all (the "Surname, Initials" ERP accounts) gains nothing here; those stay with [#1455](https://github.com/Fortigi/IdentityAtlas/issues/1455), along with account-to-account evidence and a first-class login column.

**Name-class signals are one graded ladder, not a stack** (`strongestNameRung` in `engine.helpers.js`). The two parsed-name levels were already mutually exclusive; the login rung joins them, and the heaviest rung the dictionary configures is the one that fires. Summing them instead would let one name counted twice reach the confidence of an exact `employeeId` match — an account whose display name *and* login spell its owner is no more certainly hers than the name is, because a namesake's account spells that name just as well. Ranking by configured weight is also what keeps a reweighted dictionary coherent: a login read (55) outranks a surname+initial read (45) of the same person, and `fullName` (60) outranks both.

A match is **name-only** when every signal that fired is a name signal — the graded `name` signals, the `loginName` signal, plus the legacy single-signal `fuzzy` type, which is a name comparison by definition. The name-uniqueness guard applies to those.

**Name-uniqueness guard** (always on): a name-only match links **only where the account's name points at exactly one person**. A name a second person answers to *at the level the match rests on* is no evidence of which of them the account belongs to, and the wrong one then inherits that person's access review, risk score and leaver handling. Such matches are held for review, counted and recorded on the run instead (see below).

Why a uniqueness reading rather than a blanket refusal to link on a name: measured on a synthetic 7,000-identity, 11,500-account dataset across four systems, refusing *every* name-only match held back ≈4,100 links that were correct and removed none that were wrong — a system that carries only display names (a badge reader, many ERPs, the admin accounts) stopped linking altogether. The wrong links the issue was filed for turned out to come from the name *parsing* — titles and surname particles read as names — which [#1443](https://github.com/Fortigi/IdentityAtlas/issues/1443) fixed. What is left to guard against is the namesake, and that is what uniqueness tests for.

Who the name points at is read by `nameClaim` in `engine.helpers.js`, and four things make the reading non-obvious:

1. **A name is read at the level its own evidence rests on.** The people spelled exactly that name are its claimants; only when *nobody* is spelled it do the people who share its surname and given initial become the claimants instead. That fallback is what the old tie between top-scoring candidates could not see: an account spelled `Johan Jansen` is an exact match for nobody, and both the `Jan` and the `Johannes` it may belong to stand one initial away. Identities are indexed for it in `bySurnameInitial`, which is deliberately **not** a candidate index — a surname+initial match alone scores below the shipped threshold, so widening the candidate set with it would change nothing about who links.

    Reading *both* levels at once instead — the shipped behaviour until [#1460](https://github.com/Fortigi/IdentityAtlas/issues/1460) — made every near spelling a rival of a name only one person answers to: `Youssef El Mahdi` could not be placed while a `Yasmina` or a `Yassin` existed, which cost ≈1,700 correct links per run on the reporting tenant's dataset and detached the same class on upgrade. A rival one level down is not a competing answer to the name the account actually carries. The protection the guard was built for is untouched where it applies: a second person spelled the same name still ties, **including a titled spelling** — `stripTitles` runs before a name is keyed, so `drs. Sandro Blanker` and `Sandro Blanker` share the exact key. That titled/particle class is what the 44 wrong links measured behind #1440 actually were, and [#1443](https://github.com/Fortigi/IdentityAtlas/issues/1443) plus this tie are what hold it.

    The residual exposure, consciously accepted: an account that exactly spells a *different* identity's full name while its real owner's record carries the short form nowhere. This dataset does not exercise it and it is not measured; a given-name-variant lexicon is the follow-up that would address it.
2. **The account's login is one of the names the question is asked of** ([#1454](https://github.com/Fortigi/IdentityAtlas/issues/1454)). It is read at its own two levels on exactly the terms above — whoever's whole name the login writes out answers to it, and only when nobody does can the people it writes an initial of become claimants, with the name in use beating a birth-name form under the same login. So a login can single somebody out where the display name carries no person's name at all (`Admin account 042`), and it can tie where the form fits two people (`adm-pmunck`). A login derived from a name that is itself contested resolves nothing: compressing a name loses information, it never adds any, which is why `j.jansen`'s owner gets no privileged claim to a `jjansen` login over the other Jan Jansen.
3. **The question is asked once per name the account carries**, not once overall. A person is indexed under every name they are known by, so a name that is ambiguous does not veto a *different* name that is unique: an account spelled `Anna Bakker-de Wit` in the directory and `de Wit` in its HR column belongs to the one person called Bakker-de Wit, even though two people answer to `de Wit`. The account's name points at one person when some name singles them out and no other name singles out anybody else — it points at nobody when no name singles anyone out, or when two names disagree. The reading does not depend on the order identities were indexed in.
4. **Within one name the claims are usually unequal, and a match is only as strong as its weaker side**: it is a match on the name in use when the account *and* the identity are both spelled that way, and a birth-name match when either side holds it only in a structured column. Accounts are provisioned from the name in use, so where both kinds meet the name in use wins outright:
    - An `Anna Jansen` account, an identity called `Anna Jansen`, and a second identity called `Anna de Boer-Jansen` whose HR record still carries `Jansen` in its `surname` column. The account is the first one's; the birth surname is not a rival. Indexing the birth-name variant without this rule turned links the engine used to make into review items.
    - Equally strong claims make the name ambiguous: two people who both *go by* the name, or two for whom it is equally a birth surname, send the account to review.
    - Where the account itself carries the name only in its own `surname` column, neither side's claim is the name in use and the claims are left unranked — that name is an old one on both sides, so ranking it would hand the account to a stranger over the name it is actually spelled with.

The identity the name points at also has to be one of the **top-scoring** candidates for the match to link: a name that singles out somebody the score ranks lower settles nothing, and linking them would attach the account to a weaker match than the engine's own best candidate.

Setting `allowNameOnlyLinks: false` holds back every name-only match on top of this — including one whose name is unique in the whole tenant. It is the stricter policy for a tenant that wants a name to never be evidence enough; it is not the default because it costs every link from a source that carries nothing but display names.

**Retroactive cleanup.** The guard would otherwise only apply to *new* links, leaving every wrong name-only link made before it existed attached forever. So each run first detaches the name-only links it would no longer create and recomputes `accountCount` for the identities that lost an account. Those accounts rejoin the orphan pool and re-score in the *same* run, so one that still links does so immediately and one that no longer does becomes a held-for-review match.

Which links those are follows the active policy, and the scoping matters in both directions: too narrow and the data that motivated the guard stays wrong, too wide and every run detaches and re-creates the same links forever.

| Policy | What a run detaches |
|---|---|
| shipped (`allowNameOnlyLinks` not `false`) | only the links whose account name no longer points at the identity it hangs off — a namesake, or, for an account nobody is spelled exactly, a near-identical name shared with a second person. A link on a name unique to one person stays exactly where it is, so an upgrade churns nothing it needn't and a second run detaches nothing. |
| `allowNameOnlyLinks: false` | every name-only link, because under that policy the engine would create none of them. |

The scan is over engine-scored (`linkConfidence IS NOT NULL`), analyst-untouched (`analystOverride IS NULL`) member rows on **live** accounts (`p."deletedAt" IS NULL`), joined to `Principals` for the account's own names — its display name, its columns **and its login**, since the uniqueness question has to be put on exactly the terms the engine put it. Asked without the login, every link the engine made on one reads as resting on a name that points at nobody: the run detaches it, re-creates it from the orphan pool in the same run, and reports a removal on every run forever. Crawler-sourced links (no confidence) and analyst decisions are never touched — the same exclusions the crawler's reconcile honours.

The live-account restriction is what makes "rejoins the orphan pool and re-scores in the same run" true. A link to an account a sync has removed cannot re-score — the orphan pool is live rows only — so detaching it deletes the identity's trail to that account and every grant on it, with nothing to correct it to and no held-for-review record to act on ([#1461](https://github.com/Fortigi/IdentityAtlas/issues/1461)). That is the same decision as the paragraph below: a link made before the account was removed is kept as history. For a *live* account the cleanup behaves exactly as the table above says. Note the asymmetry this preserves — a removed account is never **newly** attached to a namesake, and never **detached** from the person it was already linked to.

**The one-off restore after #1460.** Scoping rivalry to the matched level releases a whole class the previous reading held — and, on an existing install, had already detached. Those accounts are orphans, so the first run after the upgrade re-links them automatically; analyst overrides and rejections are still never overridden. Because that is a silent mass change, the run counts it: `linksRestored` is how many links it **created** on a name shared only at the weaker surname + initial level. Counting creations only means the figure reports the restore once and then settles back to `0`.

### Candidate scope = orphans only

The only accounts the engine ever considers are **orphan Principals** — *live* Principals with no `IdentityMembers` row — excluding `ServicePrincipal`, `ManagedIdentity`, and `AIAgent` principal types. Accounts already attached to an Identity (e.g. by the crawler's IdentityFilter) are never disturbed. Candidates per orphan are narrowed by indexing identities on employeeId, email-local-part (raw and prefix-stripped), normalized display name, an order-independent surname+given key **per name the person is known by**, and the two login forms above, so only plausible identities are scored and neither the birth name nor the name in use is a dead end. The login indexes are genuinely candidate indexes (unlike `bySurnameInitial`): a login-form match scores above the shipped threshold on its own, so an account whose login is the only evidence has to reach scoring through them — which is precisely what it could not do before #1454.

**Accounts a sync has removed are not orphans.** A full sync does not delete a principal that vanished from its source — it stamps `deletedAt` and keeps the row ([soft delete](soft-delete.md)). A tombstoned account is therefore excluded from the candidate set, from the `orphansRemaining` statistic, and from the Orphaned Accounts report and context: it is not work the analyst still has to do. The symmetric half of that decision is that an account linked *before* it was removed **stays linked** — soft delete never detaches a person's history, and re-ingesting the account clears the stamp and makes it linkable again.

Excluding them is a correctness rule, not a tidier count. A leaver is usually gone from the HR source too, so their account's own identity no longer exists — and what is left matching it is *someone else*: a live namesake, or a colleague whose record still carries the leaver's surname (the `Anna de Boer-Jansen` shape above). With no rival claimant nothing ties, so the ambiguity guard has nothing to refuse, and a name-only match at weight 60 clears the default threshold of 50 on its own. The measurement on #1442 found exactly that: every removed account a first run attached went to a different, live person, who then inherited a leaver's account and every grant on it. The live-rows filter is what prevents it — the engine itself cannot tell the two people apart, because nothing in the names says they are two people.

That one definition — the `Principals` anti-join against `IdentityMembers`, restricted to live rows and human principal types — lives only in [`accountlinking/orphanQuery.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/accountlinking/orphanQuery.js). Callers that need a different projection build their query with its `orphanPrincipalsSql()` rather than re-inlining the anti-join; the engine's two hand-written copies are what let the live-rows filter go missing from all three selections ([#1442](https://github.com/Fortigi/IdentityAtlas/issues/1442)).

### Confidence scoring + writes

`scoreMatch` sums the weights of every matched signal, capped at 100. `buildLinks` keeps the highest-scoring candidate above `linkThreshold` per orphan and returns `{ links, stats }`, where `stats` carries the name-only matches it held back. When `runLinking` writes the links into `IdentityMembers`:

- A non-primary member row is created (or updated) with `linkConfidence`, `linkSignals` (stored as a CSV string), `accountType`, and `accountTypePattern`.
- Per-identity rollups are written back to `Identities`: `accountCount`, `linkConfidence` (the best newly-linked account), `linkSignals` (the union), and `linkedAt`.
- **Analyst decisions win.** A member with any `analystOverride` is never overwritten, and an account the analyst marked `rejected` is never re-linked to anyone.

## Scheduling

Account Linking runs on a schedule and on demand. Configuration and run history mirror the risk-scoring substrate (`RiskClassifiers` / `ScoringRuns`):

| Table | Role |
|---|---|
| `AccountLinkingConfig` | Single active config row: `rules` (the dictionary), `schedules` (array), `isActive`, `updatedBy`. |
| `AccountLinkingRuns` | One row per run: `status`, `step`, `pct`, `candidatesScanned`, `linksCreated`, `linksUpdated`, `skippedAnalystOverride`, `orphansRemaining`, timestamps, `triggeredBy`, plus the name-only reporting columns below. |

[`scheduler.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/scheduler.js) ticks every 60 s. Each tick it loads active configs that have at least one schedule, matches each `schedule` against the current minute, and queues a run (`triggeredBy = 'scheduler'`). A 55-minute look-back on `AccountLinkingRuns` prevents double-firing across container restarts. Runs are fire-and-forget — `runLinking` records its own progress and errors into the `AccountLinkingRuns` row, the same pattern manual runs use.

### What a run reports about name-only matches

Added by [`092_account_linking_name_only.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/092_account_linking_name_only.sql), plus `linksRestored` below. All are **nullable**: `NULL` means the run predates the feature, which is not the same as a run that looked and found none. (`nameOnlySuggestions` is JSONB, so `matchLevel` needed no migration of its own.)

| Column | Meaning |
|---|---|
| `nameOnlyMatches` | How many above-threshold matches resting on name signals alone the run **held for review** instead of linking. The true, uncapped count — the stored list below is capped, so this is what the card counts against. A name-only match that linked is not counted here; it is an ordinary link. |
| `linksRemoved` | How many pre-existing name-only links the retroactive cleanup detached. Counts links on live accounts only — a link to an account a sync has removed is kept as history and never appears here. Expected to be `0` on every run after the first one that saw a given dataset. |
| `linksRestored` | How many links the run **created** on a name shared only at the weaker surname + initial level — the class the pre-#1460 cross-level reading held for review. Added by [`093_account_linking_links_restored.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/093_account_linking_links_restored.sql), nullable on the same convention. Expected to be large on the first run after that upgrade and `0` afterwards, since a link that already exists is refreshed rather than created. |
| `nameOnlySuggestions` | The held-back matches themselves — `{ principalId, displayName, identityId, identityName, confidence, signals, accountType, reason, matchLevel, rivals, rivalCount }` — capped at 500 entries so one run cannot store an unbounded document. `reason` is `ambiguousName` (somebody else answers to the name) or `uncorroborated` (the name is unique, but this tenant set `allowNameOnlyLinks: false`); `matchLevel` is the level the match rested on (`full`, `surnameInitial`, or `loginName` where the evidence was the account's login — absent on a run stored before #1460) and is what lets the card say *which* name the rivals share; `rivals` names up to 5 of the other claimants at that level and `rivalCount` is how many there really are. |

They surface in the run-completion notice and in the read-only **"Name-only matches (held for review)"** card in Admin → Account Linking. The routes `SELECT *`, so no API change was needed. There is deliberately **no confirm/reject action** on a suggestion: a durable reviewable link object would have to not act as linked while awaiting review (any `IdentityMembers` row removes the account from the orphan set and feeds the matrix and risk rollups), which is a separate feature. The analyst acts through the existing per-account override controls on the identity page.

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
- Schema — [`030_account_linking.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/030_account_linking.sql), [`092_account_linking_name_only.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/092_account_linking_name_only.sql)
- Scheduler — [`app/api/src/scheduler.js`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/scheduler.js)

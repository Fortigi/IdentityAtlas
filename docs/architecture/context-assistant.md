# Context Assistant — design (DRAFT)

> Status: design draft, not built. Branch `feature/context-assistant`, stacked on
> `feature/custom-reports` (PR #1223). Developed by hand on sk7, outside the DoR pipeline.

A role miner describes a context in their own words — *"all groups related to het inkoopproces"*,
*"everything to do with HAMIS"*, *"groups that (almost) only people from department Inkoop have"* —
and builds it in a short dialog with a local language model: the model proposes search terms, the
miner keeps or drops each one while seeing what it finds, reviews the matched objects and includes or
excludes individual ones, and saves the result as a context tree.

It is the fourth way to create a context, next to *Import*, *Run a plugin* and *Create manual*.

## 1. The one decision everything follows from

**The model produces a recipe; a deterministic plugin runs the recipe.** Exactly as custom reports: the
model never writes SQL and never decides membership. It fills in a JSON *context recipe*, constrained by
a JSON-schema grammar. The recipe is stored as the **parameters of a regular context plugin**
(`context-recipe`), and that plugin — plain SQL, no model — produces the contexts and members.

What that buys, all for free from the existing plugin framework:

| Existing mechanism | What it gives the assistant |
|---|---|
| `runner.js` reconcile + `sourceInstanceKey` | "Refresh this tree" keeps renames / re-parenting |
| `refreshGeneratedContexts()` after every crawl | A new group called `SG_Inkoop_Facturen` joins the context after the next crawl — **with the generator switched off** |
| `/context-plugins/:name/dry-run` | The preview step |
| Context tree UI, matrix filter | Nothing new to build for *using* the context |

And one constraint it forces, which is the right one: **exclusions cannot be member deletions.** The
runner replaces every `addedBy='algorithm'` member on each run, so a group the miner removed by hand
would be back after the next crawl. Includes and excludes therefore live **in the recipe**.

## 2. The recipe

```json
{
  "version": 1,
  "name": "Inkoopproces",
  "target": "resource",
  "scope": { "resourceTypes": ["Group"], "systemIds": [] },
  "strategies": [
    {
      "type": "terms",
      "fields": ["displayName", "description", "mail"],
      "terms": [
        { "text": "inkoop",      "match": "wordStart", "origin": "model",   "state": "accepted" },
        { "text": "procurement", "match": "wordStart", "origin": "model",   "state": "accepted" },
        { "text": "crediteur",   "match": "wordStart", "origin": "model",   "state": "accepted" },
        { "text": "ink",         "match": "token",     "origin": "model",   "state": "rejected" },
        { "text": "coupa",       "match": "token",     "origin": "analyst", "state": "accepted" }
      ]
    },
    {
      "type": "population",
      "population": { "entity": "account", "field": "department",
                      "values": ["Inkoop", "Inkoop & Contractbeheer"] },
      "minShare": 0.8,
      "minMembers": 3
    }
  ],
  "combine": "any",
  "include": ["<resource id>"],
  "exclude": ["<resource id>", "<resource id>"],
  "structure": "byTerm"
}
```

- **`target`** — `resource`, `account` or `identity`; maps onto the plugin's `targetType`. v1 builds
  `resource` only (see phasing).
- **`fields`** — names from `nlreports/catalog.js`, never column names. The catalog already knows the
  text fields of each entity and their SQL templates (`displayName`, `description`, `mail`, extended
  attributes), so *"search the description too"* is a catalog lookup, not new SQL.
- **Rejected terms are kept.** They stop "suggest more" from proposing them again, and they are the
  audit trail of *why* the context is what it is.
- **`include` / `exclude`** — record ids. Include pins an object even when it stops matching; exclude
  wins over every strategy.
- **`structure`** — `flat` (one context), `byTerm` (a child per accepted term; an object can sit in
  more than one, like `resource-cluster`), or `byToken` (run the existing `resource-cluster` token
  algorithm over just the matched set).

### Matching

Terms are **values, never patterns**: no regex is built from model or analyst text. Text is normalised in
SQL — lowercase, every non-alphanumeric run replaced by one space, padded with spaces — and matched with a
parameterised `LIKE` (escaped via `sqlParams.likeContains`):

| `match` | Matches `inkoop` in… | Normalised test |
|---|---|---|
| `token` | `SG_INKOOP_Users` — not `Inkoopfacturen` | `' ' \|\| norm \|\| ' ' LIKE '% inkoop %'` |
| `wordStart` (default) | `SG_INKOOP_Users`, `Inkoopfacturen` — not `Herinkoop` | `LIKE '% inkoop%'` |
| `contains` | all three | `LIKE '%inkoop%'` |

Short abbreviations (≤ 3 characters) default to `token`, which is what makes `INK` usable without
matching every `link` and `inkt`. (Postgres `\m` word boundaries are not used: they treat `_` as a word
character, so `SG_INKOOP` would not match.)

## 3. The dialog

The builder opens in its **own tab**, like the report builder — the term and match review does not fit
the 640 px wizard modal. The wizard card only starts it.

```
 1 Describe ──► 2 Terms ──► 3 Matches ──► 4 Structure & save
      ▲            │  ▲          │
      └ clarify    │  └ suggest  └ include / exclude per object
                   └ add own term
```

**1 · Describe.** The miner types the request. The model replies with a recipe draft or a clarifying
question (at most two rounds, then it must produce a recipe — same rule as reports). It chooses the
strategy: *"related to X"* → `terms`; *"only people from department X have"* → `population`.

**2 · Terms.** Each proposed term is a chip with what the *data* says about it, computed right away
without the model:

| Shown per term | Why |
|---|---|
| hits | how many objects it finds |
| unique hits | objects **only** this term finds — a term with 40 hits and 0 unique adds nothing |
| field split | "12 by name, 3 only by description" |
| too-broad flag | hits above a share of the scope (e.g. > 5 %) — the `maxTokenCoverage` idea from `resource-cluster` |
| model's reason | *translation · synonym · abbreviation · system name* — one short phrase |

The miner ticks and unticks terms, adds their own, and can ask for more:

- **Suggest more (model)** — the model gets the request plus the accepted *and rejected* terms, and
  returns only new ones.
- **Related words (no model)** — tokens that occur unusually often in the names of the accepted
  matches compared with all groups (`resource-cluster/tokenize.js` + a lift score). This is how `HAMIS`
  turns up `HMS` or `Zaaksysteem`: the model cannot know a customer's system names, but the data can.

"Not too many, not too few" is **enforced, not asked for**: the prompt asks for 6–12 terms, the grammar
caps a reply at 15 (every array bounded — the lesson from the report generator's 570-second `columns`
loop), and the hit counts let the miner prune the rest in seconds.

**3 · Matches.** A table of every matched object: name, type, system, member count, *which term matched
in which field* (highlighted), and for `population` the share (*14 of 15 members are in Inkoop — 93 %*)
and reach (*14 of the 20 Inkoop people*). Per-row include/exclude, and bulk actions — *exclude everything
found only via "order"*, *show only description-only matches*. Objects that no term finds can be pinned
with the name search from custom reports (`references.js` → `searchNames`).

**4 · Structure & save.** Name, structure, new tree or refresh an existing one (the wizard's existing
`TargetChooser`), preview through the plugin's dry-run, create.

**Re-opening.** A tree created by the assistant can be opened in the builder again from its context
page — the recipe is its run parameters — to add a term or exclude a group, then refresh in place.

## 4. The population strategy

*"Groups that (by overwhelming majority) only people from Inkoop have."*

1. **Population.** The model produces terms for a person field (`department`, `jobTitle`,
   `companyName`). Code matches them against the **distinct values** of that field and the miner ticks
   values (`Inkoop` ✓, `Inkoop & Contractbeheer` ✓, `Inkomsten` ✗) — the same term UI with values
   instead of objects as hits. The model still never sees the values.
2. **Candidates.** For every group with at least `minMembers` population members:
   `share = population members ÷ all members` and `reach = population members ÷ population size`, over
   `Direct` + `Indirect` assignments.
3. **Keep** `share ≥ minShare` (default 0.8). Sorted by reach, so *"the group every Inkoop person has"*
   comes first and *"a 3-person group"* last.

Identity vs account: the population is defined on accounts in v1 (that is where `department` lives on
the Principals row); an identity-based population is a later option once identity attributes are the
reliable source.

It combines with `terms` (`combine: any|all`): *"groups about inkoop, or held almost only by Inkoop"* is
`any`; *"Inkoop groups that really are Inkoop's"* is `all`.

## 5. The pieces

Reused, not copied — the assistant is a second consumer of the report generator's layers:

| From custom reports | Used for |
|---|---|
| `nlreports/llm.js`, `llamacpp.js` | `chat({ messages, schema })` — unchanged |
| prompt-cache warm-up (`service.js` `ensureWarm`) | **must become per system prompt**: `warm()` already keys the cache file on a hash of the prompt, but `service.js` holds a single module-level `warmup`. Move it into a small shared `nlreports/warmup.js` keyed by prompt; one slot restores whichever prompt is asked (~0.1 s) |
| `catalog.js` entities, text fields, `GLOSSARY` | searchable fields and their SQL; person = identity, business role = access package |
| `references.js` `searchNames` | pinning an object by name |
| `lib/httpJson.js`, `db/sqlParams.js` | as in reports |
| generator container, compose profile, Azure app | unchanged — same model, a second system prompt |
| `tools/nl-reports/eval.mjs` pattern | the accuracy harness |

From contexts: plugin registry, runner, dry-run, refresh-after-crawl, `TargetChooser`,
`resource-cluster/tokenize.js`.

New:

| File | Responsibility |
|---|---|
| `contexts/plugins/context-recipe/index.js` | The plugin: validate the recipe, run strategies, apply include/exclude, shape the tree |
| `…/context-recipe/recipe.js` | Recipe validation + normalisation (the `spec.js` of this feature): unknown field/strategy rejected, terms trimmed and de-duplicated, every list capped; errors as sentences the model can be handed |
| `…/context-recipe/terms.js`, `population.js` | One strategy each: recipe fragment → parameterised SQL |
| `…/context-recipe/evaluate.js` | Per-term hits / unique hits / field split, and the paged match list — the data behind steps 2 and 3 |
| `…/context-recipe/relatedTokens.js` | "Related words" by lift |
| `contextAssistant/prompt.js`, `service.js` | System prompt + reply grammar; `interpret()` and `suggestTerms()` with the repair round |
| `routes/contextAssistant.js` | HTTP surface |
| UI `components/contexts/assistant/…` | builder page, term chips, match table; fourth wizard card |

### API

| Route | Model? | Returns |
|---|---|---|
| `POST /api/context-assistant/interpret` `{ question, history }` | yes | `recipe` + plain-language summary, or `clarify` |
| `POST /api/context-assistant/suggest-terms` `{ question, recipe }` | yes | new terms only |
| `POST /api/context-assistant/evaluate` `{ recipe, page }` | no | per-term stats + matches |
| `POST /api/context-assistant/related-tokens` `{ recipe }` | no | ranked tokens |
| `GET /api/context-assistant/values` `{ field, terms }` | no | matching distinct person-field values |
| existing `POST /api/context-plugins/context-recipe/dry-run` and `/run` | no | preview / create |

### Gates

- **Feature flag** `contextAssistant` (experimental, off by default) — independent of `customReports`
  so each can be switched on on its own merit.
- **Permission.** Plugin routes are gated on `admin.context-plugins` today — an *admin* permission a
  role miner may not hold. Proposed: a new `data.write.contexts-assistant` for the assistant routes, and
  the `context-recipe` run accepted under that permission too (see open questions).
- Without a model server, steps 2–4 still work: the miner types their own terms. The assistant is an
  accelerator on a feature that stands by itself.

## 6. Safety

Same model as custom reports, one addition:

- **SQL injection** — fields only from the catalog; terms, values and ids always parameters; `LIKE`
  escaped; no regex built from input. `evaluate` runs `READ ONLY` with a statement timeout.
- **Plugin runs at crawl time** had no statement timeout; the population strategy is the most expensive
  query this adds (a join over all group assignments), so `context-recipe` sets its own timeout and
  fails the run rather than stalling the post-crawl refresh.
- **Recipe size** — terms, values, include and exclude are capped (the recipe is stored as run
  parameters and replayed after every crawl).
- **Prompt injection** — bounded by the grammar plus validation; the worst outcome is a wrong term the
  miner sees and unticks.
- **The model sees** the request, the catalog's field names, and earlier accepted/rejected terms. Never
  object names, values or members.

## 7. Risk: will a 4B model propose good terms?

This is the question to answer **before** building UI. Report generation is slot-filling against a known
vocabulary; term proposal leans on the model's *world knowledge* (Dutch procurement vocabulary,
common system names) — a different skill, and a 4B model has less of it. Two things soften it: the
"related words" path finds customer-specific terms without the model, and a weak model degrades to "the
miner types the terms", not to a wrong context.

**Measure first.** An evaluation set of ~20 requests on the Fortigi copy, each with a hand-labelled set
of groups that belong. Metrics per request, with every proposed term accepted (worst case) and with only
terms that have unique hits (a realistic miner):

- recall and precision of the labelled groups;
- number of proposed terms, and how many had zero hits;
- time to answer.

Go/no-go: if the model's terms, before any analyst edit, don't reach usable recall on the tuning set,
the assistant's first version ships with "related words" and manual terms only, and model-proposed terms
wait for a better model.

## 8. Phasing (stacked PRs, all developed on sk7)

| Step | What | Model? |
|---|---|---|
| 0 · Spike | Prompt + grammar + eval set on Fortigi data, terms only. Go/no-go on term quality. | yes |
| 1 · Recipe plugin | `context-recipe` with `terms`, include/exclude, `flat`/`byTerm`; `evaluate`; tests | no |
| 2 · Builder | Builder page (terms, matches, save), fourth wizard card, typing terms by hand | no |
| 3 · Assistant | `interpret`, `suggest-terms`, per-prompt warm-up, clarify rounds | yes |
| 4 · Population | the exclusivity strategy + person-field values | partly |
| 5 · Extras | related words, `byToken`, re-open from context page, account/identity targets | no |

Steps 1–2 are useful without any model, which makes them a safe first merge.

## 9. Open questions

1. **Does the model see object names?** Proposed: no (identical promise to custom reports), with
   "related words" doing the data-driven part. Letting the local model read accepted group names would
   likely improve suggestions for customer-specific names — a conscious trade-off.
2. **New matches after a crawl** — included automatically (proposed for v1, with a "N new since you last
   reviewed" count on the context), or held for review (needs a pending state that does not exist).
3. **Permission** — a new `data.write.contexts-assistant`, or open `admin.context-plugins` to role
   miners?
4. **One context or a tree by default** — `byTerm` gives the miner visibility of *why*; `flat` is what
   the matrix filter wants. Proposed default: `byTerm` under a root, since filtering on the root includes
   the children.

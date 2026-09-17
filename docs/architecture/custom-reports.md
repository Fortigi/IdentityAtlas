# Custom Reports — how it works

The analyst-facing side is [Custom Reports](../ui/custom-reports.md); the model and its hosting are in
[Report Generator](../reference/report-generator.md). This page is the design: what a report
definition is, how it becomes SQL, and where the seams are.

## The shape

```
question ─► model ─► report definition (JSON) ─► validate ─► resolve names ─► compile ─► READ ONLY tx ─► rows
              ▲          ▲                         │             │              │
              │          └ built by hand in the    │             │              └ parameterised SQL,
              │            definition editor       │             │                statement timeout
              │                                    │             └ "did you mean …?" for a fuzzy name
              └ JSON-schema grammar: the model can only
                emit known entities, fields and relations
```

A **report definition** is the only thing that travels between the layers, and the only thing stored:

```json
{
  "entity": "group",
  "match": "all",
  "conditions": [
    { "type": "compare", "relation": "members", "measure": "identical",
      "reference": { "entity": "resource", "name": "Fortigi - Algemeen - Maten", "id": "d2d71e…" } },
    { "type": "relation", "relation": "businessRoles", "quantifier": "none", "match": "all",
      "conditions": [{ "type": "field", "field": "displayName", "op": "eq", "value": "Fortigi - Algemeen - Maten" }] }
  ],
  "columns": ["displayName", "memberCount", "compare.similarity"],
  "limit": 1000
}
```

## The pieces

| File | Responsibility |
|---|---|
| `nlreports/catalog.js` | The whole vocabulary: entities (user, group, account, resource, identity), their fields and relations, each with a constant SQL template and an analyst-language description. Nothing outside this file decides what can be reported on. |
| `nlreports/spec.js` | Validation and normalisation of a definition — unknown field/operator/relation rejected, values coerced to the field's type, enum values snapped to values that exist, columns resolved, limits capped. Errors are plain sentences, so they can be handed back to the model. |
| `nlreports/compare.js` | The set-comparison building block (identical / containsAll / within / similar) with its CTE-based SQL and its plain-language wording. |
| `nlreports/references.js` | Looks up every named object (comparison references and `name is X` conditions): exact → punctuation-insensitive → `pg_trgm` fuzzy, producing a "did you mean" confirmation the UI applies without another model call. |
| `nlreports/compile.js` | Definition → parameterised SQL. Every identifier comes from the catalog; every value goes into the parameter array. |
| `nlreports/explain.js` | Definition → the sentence shown to the analyst. Generated from the *validated* definition, never from the model's prose. |
| `nlreports/prompt.js` | The system prompt (release-stable, no deployment data) and the JSON schema handed to the model server as a decoding grammar. |
| `nlreports/service.js` | `interpret()` (model → definition, with the repair rounds) and `runSpec()` (validate → resolve → compile → run). Also owns the single prompt-cache warm-up. |
| `nlreports/llamacpp.js`, `ollama.js`, `llm.js` | Model-server clients and the backend switch. llama.cpp is what ships; the Ollama client is kept for comparing models with the evaluation harness. |
| `nlreports/savedReports.js` | `SavedReports` storage plus the bridge into the report registry: a saved report is served as a normal `list` report named `custom-<id>`. |
| `routes/nlReports.js` | The HTTP surface. Every route carries its own gates (permission, then feature flag). |

## Decisions worth knowing

**The model fills slots; it does not write SQL.** A JSON-schema grammar on the model server makes an
unknown field name physically unemittable, and validation rejects whatever the grammar cannot prevent.
This is why a 4B model on a CPU is enough: the task is slot-filling, not code generation.

**Analysts' nouns are entities.** `user` and `group` are entities of their own (accounts of type User,
resources of type Group) rather than "account + a type filter". Small models reliably forgot that
filter; making it part of the entity took the best model of that round (Qwen2.5-Coder 3B, later dropped
for its licence) from 22/32 to 28/32 on the tuning set at the time. `account` and `resource` remain for everything else, and a definition that restates the
implied type is accepted and normalised away.

**A glossary, not synonym handling in code.** `catalog.js` exports `GLOSSARY` (person = identity,
account = principal = user, business role = access package, plus Dutch terms). It is rendered into the
prompt so that one list governs the model's vocabulary, and the same aliases are accepted by the
validator.

**Saved reports reuse the report registry.** `registerReportSource()` lets the registry take templates
from somewhere other than the code, so a saved report gets the existing report tab, refresh and
download with no new UI. The engine still never names a report — see
[Reports](reports.md).

**Names resolve to ids, once.** A saved comparison stores the record id it was built against, so
renaming a business role does not break the report; the name is refreshed on each run.

**The generator is optional at every level.** No model server → the definition editor still works. The
feature flag off → the API answers 404 and saved reports are not listed (but kept). No
`data.write.reports` → 403.

**The prompt cache is re-checked, never remembered.** Reading the ~4k-token system prompt costs
minutes on a small CPU; llama.cpp can save the processed result and restore it in ~0.1 s. The catch is
that the model server is a separate container with its own lifecycle — Azure scales it to zero between
questions, Docker restarts it with the host — so "we warmed it up once" says nothing about whether it
still holds the prompt. `ensureWarm()` therefore re-restores on every call rather than short-circuiting
on an earlier success, and `interpret()` calls it before asking. A hit is ~0.1 s, a miss is no worse
than asking cold and leaves the cache saved. Remembering the state instead is how this optimisation
silently did nothing in the one case it was built for: a restarted generator, an API that still said
"ready", and a 266 s answer where 76 s was expected.

**The model is loaded on demand by a supervisor inside the container, not by the web app.** The model
server holds ~3 GB it cannot release while it runs. Having the web app start and stop the container would
need the Docker socket — root on the host — so the container stays up and its main process,
`setup/docker/report-generator/supervisor.py`, starts llama-server (on loopback) when a request needs it
and stops it after `REPORT_GENERATOR_IDLE_SECONDS` unused. It passes requests through unchanged, answers
`/health` (with `model: unloaded | starting | ready`) and the model list itself so that status checks
never wake the model, never unloads under a request in flight, and checks the API key before starting
anything. `/api/nl-reports/warm` reads that state to tell "loading the model" (seconds) from "preparing
the prompt cache" (minutes). llama-swap does the same job but would have needed client path rewrites for
the cache endpoints and brings its own log, UI and unload endpoints; ~200 lines of standard-library Python
added none of that. Its tests use a fake model server and run in CI (`test_supervisor.py`).

## Limits (and why)

- **One relation hop.** A condition can reach a related record but not that record's relations.
  Two hops would need either nested EXISTS with correlated aliases the compiler does not generate, or
  a join planner — and it is not what the questions we collected ask for.
- **No aggregation beyond counts.** Counts (members, groups, owners, accounts) are catalog fields.
  Grouping, sums and percentages would be a second, different feature (a pivot, not a list).
- **No field-to-field comparison** within a record.
- **No history.** Definitions run against current data; the history tables are a separate surface.
- **Comparison is per row.** The reference set is computed once as a CTE, the candidate set per row. On
  a large tenant a comparison over every group is the most expensive thing this feature can run, which
  is why the row limit and statement timeout apply to it like everything else.

## Tests

| Layer | Where |
|---|---|
| Definition language (validation, compilation, wording, comparison, lookup) | `nlreports/*.test.js` — unit, no database |
| SQL actually matching the schema | `contract-tests/` against a real PostgreSQL |
| HTTP surface, gates, validation, error mapping | `routes/nlReports.test.js` |
| Builder end-to-end, without a model server | `app/ui/e2e/custom-reports.spec.js` |
| Model accuracy | `tools/nl-reports/eval.mjs` with `questions.json` (tuning) and `holdout.json` (never tuned on) — run on demand, not in PR CI |

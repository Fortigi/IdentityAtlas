# Organisation truth — design

> **Status:** MVP under construction on `feature/org-truth-mvp` (October 2026), behind the
> experimental flag `orgTruth`. This page is the shared reference for the parallel
> workstreams building it; the handover per workstream lives outside the repo.

## Why

The crawlers sync the **system truth**: accounts, groups, roles, assignments. Strictly
modelled, read several times a day, the IST. The organisation has a truth of its own that
no system holds: which project is whose, which CMDB asset is behind which group, who owns a
data domain, which team an external colleague works in. Today that lives in spreadsheets,
in conversations and in mail, and a role miner stitches it to the system truth by hand.

Organisation truth is the second layer next to the first: uploaded once, describing a point
in time, with a structure that is only known after looking at it. Opinions (what an analyst
knows and nobody wrote down) are a third source that uses the same model with the analyst as
provenance. All three meet in one graph that the matrix, reports and risk plugins already
read: contexts.

## The four layers

| Layer | Tables | What it holds | Pattern reused |
|---|---|---|---|
| Source | `OrgSources` | The original, unchanged: bytes or text, kind (list, transcript, email, manual), `observedAt` (the moment it describes), who | Named graph (RDF); crawler uploads |
| Claims | `OrgEntities`, `OrgRelations` | Free-form `entityType` / `predicate`, name, attributes in JSONB. Every row: source + locator, `origin` (import, model, analyst), `confidence`, `status` (proposed, accepted, rejected), `observedAt`, `validFrom`/`validTo`. Append-only | RDF-star statement annotations; `extendedAttributes` |
| Links | `OrgLinks` | An org entity matched to a system object (Identity, Principal, Resource, Context) with confidence, the matched field and value, and `analystOverride` that every re-run respects | Account Linking (`IdentityMembers.linkConfidence`) |
| Projection | none new | The `org-truth` context plugin emits one generated context per org entity with its linked system objects as members. Nothing else reads the org tables | Context plugins, `refreshGeneratedContexts()` |

Rules the layers follow:

- **Nothing a model produces is authoritative.** Model output lands as `origin='model'`,
  `status='proposed'`; an analyst accepts it. Imports from a list are `origin='import'`
  and accepted on arrival, because the list is the organisation speaking.
- **A full run closes, a delta run never does.** Full: entities of this profile that the
  new source no longer contains get `validTo = observedAt`. Delta: only the rows in the
  source are applied. Rows are never deleted by a run.
- **Analyst overrides win** over any later run, exactly as in Account Linking.
- **Postgres is the store.** No triple store, no graph database: the claims tables are a
  clean node list and edge list with stable ids, so a Turtle/JSON-LD export or, later,
  SQL/PGQ (PostgreSQL 19) or Apache AGE are additions, not migrations.

## The import wizard

Two objects behind it:

- `OrgImportProfiles` — the reusable, **versioned** recipe: the object-relation model
  (which column is which entity, attribute or relation), the canonical key per entity type,
  and the link rules. Adjusting a profile creates the next version; runs record which one
  they used.
- `OrgImportRuns` — one execution: source, profile version, mode (full/delta), status,
  stats (the data-quality report), timestamps.

| Step | New import | Repeat | Who does the work |
|---|---|---|---|
| 1 Start | Name, source kind | Pick a profile, full or delta, adjust the config? | UI |
| 2 Source | Upload (kept as is), `observedAt` | Same | API |
| 3 Model | Column profile; the model or a heuristic proposes the recipe; analyst edits | Skipped unless adjusting; new/vanished columns flagged | code + optional LLM |
| 4 Links | Per entity type: detected candidate fields with unique-hit rates ("Owner matches 94% unique on Principal.email, accept?") | Prefilled; detection re-run | code, deterministic |
| 5 Quality | Dry run: unique / ambiguous / none per type, duplicates in the source, threshold slider, per-row feedback | Plus comparison with the previous run | code |
| 6 Confirm | Save profile, start run, poll | Save a new version if anything changed | API |

## Contracts

Defined in `app/api/src/orgtruth/contracts.js` (validators return `{ ok, errors }` with
sentence errors; JSON schemas double as the model's decoding grammar).

**Recipe** — how a row of a list becomes entities and relations:

```json
{
  "version": 1,
  "entities": [
    { "type": "Project", "keyColumn": "ProjectCode", "nameColumn": "ProjectName",
      "attributes": [ { "column": "Budget", "name": "budget" } ] },
    { "type": "Person",  "nameColumn": "OwnerName",
      "attributes": [ { "column": "OwnerEmail", "name": "email" } ] }
  ],
  "relations": [ { "predicate": "owner", "from": "Project", "to": "Person" } ]
}
```

One row yields one instance per entity definition (de-duplicated by `keyColumn`, default
`nameColumn`) and one relation per relation definition between that row's instances.

**Link rules** — how an entity type is matched to the system truth:

```json
[
  { "entityType": "Person", "targetType": "Principal", "threshold": 50,
    "signals": [
      { "attribute": "email",       "targetField": "email",       "type": "exact", "weight": 90 },
      { "attribute": "displayName", "targetField": "displayName", "type": "name",  "weight": 60 }
    ] }
]
```

Allowed target fields per target type (`LINK_TARGETS`): Principal and Identity: `email`,
`employeeId`, `displayName`; Resource: `displayName`, `mail`, `externalId`; Context:
`displayName`. Signal types: `exact`, `prefix`, `name`, `token`. The best candidate whose
summed weight reaches the threshold is linked `accepted`; below it, `proposed` for review;
a tie between candidates is `proposed`, never guessed.

## API (all under `/api/org-truth`, feature `orgTruth`)

Reads need `data.read`; writes reuse `data.write.contexts` for the MVP (a dedicated
`data.write.org` is the productisation step, with the permission manifest and docs).

| Area | Routes | Workstream |
|---|---|---|
| Sources | `POST /sources` (multipart), `GET /sources`, `GET /sources/:id`, `GET /sources/:id/download`, `GET /sources/:id/columns` | T1 |
| Profiles | `GET /profiles`, `GET /profiles/:id`, `POST /profiles`, `PUT /profiles/:id` (new version) | T1 |
| Runs | `POST /runs/dry-run`, `POST /runs` (202), `GET /runs`, `GET /runs/:id` | T1 (+T2 stats) |
| Links | `POST /links/detect`, `GET /review`, `PUT /links/:id/override`, `DELETE /links/:id/override`, `PUT /entities/:id/status`, `PUT /relations/:id/status` | T2 |
| Proposal | `GET /propose/status`, `POST /propose/recipe` | T3 |
| Model | `GET /model`, `GET /entities`, `GET /entities/:id`, `GET /entities/:id/graph` | T4 |

Any `/org-truth` path no sub-router claims answers 501 (`routes/orgTruth.js`), so a client
can tell "not built" from "wrong URL".

## Code map

```
app/api/src/orgtruth/
  contracts.js            recipe + link-rule validation, schemas, normalisation  (shared)
  http/gates.js           READ_GATE / WRITE_GATE                                  (shared)
  http/{sources,profiles,runs}.js                                                 T1
  import/                 parse (xlsx/csv), profileColumns, applyRecipe, writeRun T1
  linking/                signals, score, detect, run.js, stats.js, review        T2
  propose/                heuristic.js, prompt.js, llm.js                         T3
  projection/plugin.js    the context plugin                                      T4
  http/{links}.js T2   http/propose.js T3   http/model.js + model/ T4
app/api/src/routes/orgTruth.js            composes the sub-routers              (shared)
app/api/src/db/migrations/084_org_truth.sql                                      (shared)
app/ui/src/components/orgtruth/
  OrgTruthPage.jsx, orgTabs.js, NotBuiltYet.jsx                                  (shared)
  wizard/                                                                         T5
  SourcesTab, ModelTab, EntitiesTab, ReviewTab (+ detail page, graph)            T6
app/ui/src/hooks/useCanImportOrgTruth.js                                          (shared)
```

Gates that apply to every workstream: a `changes/` fragment (one exists), tests next to
every file (hygiene), every new `.js`/`.jsx` listed in `stryker.orgtruth.config.json`
(`mutate` or a reasoned exclusion), file length under 1000 lines, cyclomatic 20 /
cognitive 15 per function, `@ui/` imports in the UI, no "Org Unit" wording.

## Open decisions (recorded, not blocking the MVP)

1. Link level for people: the matched field decides (account field → Principal, person
   field → Identity); the projection raises to Identity where asked.
2. CMDB assets as `Application` Resources with `GrantsAccessTo` from linked groups, versus
   contexts only. MVP projects everything to contexts; the Resource path is the follow-up.
3. Model for Dutch transcripts: the local 4B model proposes recipes for lists only in the
   MVP; unstructured extraction waits for a measured model choice.
4. A dedicated permission and OpenAPI documentation before the flag leaves experimental.

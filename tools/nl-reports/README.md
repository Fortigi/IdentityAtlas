# Report generator — evaluation and prompt-cache tools

The maintainer tools behind custom reports: the question sets the feature is measured on,
the harness that measures it, and the script that prepares its prompt cache. For the
feature itself see [Custom Reports](../../docs/ui/custom-reports.md); for the model, the
measurements and the hosting see [Report Generator](../../docs/reference/report-generator.md).

Analysts describe a report in their own words ("guest accounts without a manager, or whose
manager is disabled"). A small model running locally on CPU turns that into a **report
definition** (JSON). The API validates the definition against a semantic catalog and
compiles it to parameterised, read-only SQL. The model never sees data — only the
question, the catalog and the names of types that exist (e.g. `Guest`, `ServicePrincipal`).

```
question ──► local model (llama.cpp, CPU) ──► JSON definition ──► validate (catalog) ──► compile ──► READ ONLY tx ──► rows
                  ▲   JSON-schema grammar: can only emit known entities/fields/relations
                  └── one repair round with the validator's error messages
```

## Where things are

| Piece | File |
|---|---|
| Vocabulary (entities, fields, relations, SQL templates, glossary) | `app/api/src/nlreports/catalog.js` |
| Validation / normalisation of model output | `app/api/src/nlreports/spec.js` |
| Definition → SQL | `app/api/src/nlreports/compile.js` |
| Set comparison (role mining) | `app/api/src/nlreports/compare.js` |
| Named-object lookup and "did you mean" | `app/api/src/nlreports/references.js` |
| Definition → plain language (what the analyst checks) | `app/api/src/nlreports/explain.js` |
| Prompt + output grammar | `app/api/src/nlreports/prompt.js` |
| Model client, interpret/run service, routes | `llamacpp.js`, `service.js`, `app/api/src/routes/nlReports.js` |
| UI | `app/ui/src/components/reports/ask/` |
| The model container | `setup/docker/Dockerfile.report-generator` |
| Model server for local development | `docker-compose.nl-reports.yml` |
| Internals, for maintainers | `docs/architecture/custom-reports.md` |

## Running it

The model is baked into the image, so there is nothing to download first:

```bash
docker compose -f docker-compose.yml -f docker-compose.nl-reports.yml up -d --build
```

Then Reports → **New report** → describe it. The model server sits on an internal network
that only the web container joins: no published port, no route to postgres, no egress.

The first start prepares the prompt cache in the background (~3 minutes, once per
release); until that finishes the builder says so and questions are slow. To do it in the
foreground and be told when it is done:

```bash
node tools/nl-reports/prepare-prompt-cache.mjs      # idempotent, and verifies a restore works
```

## Evaluating

```bash
node tools/nl-reports/eval.mjs --check                                            # do the expected definitions still return what we think?
node tools/nl-reports/eval.mjs --models qwen3:4b-instruct-2507-q4_K_M             # accuracy + latency
node tools/nl-reports/eval.mjs --models qwen3:4b-instruct-2507-q4_K_M --file tools/nl-reports/holdout.json
```

A question passes when the model's definition returns **exactly the same rows** as the
hand-written expected definition — not when it looks plausible. Questions whose expected
answer is empty on the test data are reported as weak, because a wrong definition can
return nothing too.

Two sets, and the difference matters:

- **`questions.json`** — the tuning set. Prompts, rules and examples were changed while
  looking at these, so a good score here is partly a score for our own fitting.
- **`chat.json`** — the conversation set: the questions people actually typed into the
  Teams bot and the Ask tab, in Dutch and in English, each pair sharing one expected
  answer. "I" and "my" mean whoever runs the evaluation (`@me`, resolved from the
  token), the person named is one that exists in the test directory, and some
  questions carry a follow-up asked in the same chat. Needs a signed-in stack
  (`--token-cmd`). Two entries are `pending`: the definition language cannot
  express them yet, and they say why.
- **`holdout.json`** — written before tuning and never used to improve anything. That is
  the number worth quoting.

Both sets expect a real tenant's data, so run them against a deployment that has some;
`--check` tells you whether the expected definitions still match what is there.

## One trap worth knowing

`--models` takes the server's `--alias`, and that alias is the only thing telling two model
*files* apart — the server exposes no checksum of the weights. Point the eval at different
weights under the same alias and the prompt cache saved for the old model is restored for
the new one: same name, wrong weights, no warning. Change the model, change the alias.

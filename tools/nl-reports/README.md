# Natural-language reports — prototype

**Status: experiment on branch `prototype/nl-reports`. Not on the backlog, not for merge as-is.**

Analysts describe a report in their own words ("guest accounts without a manager, or whose manager is
disabled"). A small model running locally on CPU turns that into a **report definition** (JSON). The API
validates the definition against a semantic catalog and compiles it to parameterised, read-only SQL. The
model never sees data — only the question, the catalog and the names of types that exist (e.g.
`Guest`, `ServicePrincipal`).

```
question ──► local model (Ollama, CPU) ──► JSON definition ──► validate (catalog) ──► compile ──► READ ONLY tx ──► rows
                  ▲   JSON-schema grammar: can only emit known entities/fields/relations
                  └── one repair round with the validator's error messages
```

## Where things are

| Piece | File |
|---|---|
| Vocabulary (entities, fields, relations, SQL templates) | `app/api/src/nlreports/catalog.js` |
| Validation / normalisation of model output | `app/api/src/nlreports/spec.js` |
| Definition → SQL | `app/api/src/nlreports/compile.js` |
| Definition → plain language (what the analyst checks) | `app/api/src/nlreports/explain.js` |
| Prompt + output grammar | `app/api/src/nlreports/prompt.js` |
| Ollama client, interpret/run service, routes | `ollama.js`, `service.js`, `app/api/src/routes/nlReports.js` |
| UI panel on the Reports page | `app/ui/src/components/reports/ask/` |
| Model server (isolated network, no egress) | `docker-compose.nl-reports.yml` |
| Evaluation | `tools/nl-reports/eval.mjs`, `questions.json` (tuning set), `holdout.json` (never tuned on) |

## Running it

```bash
# once: pull models into the shared volume (the model container itself has no internet)
docker volume create nlproto_llm_models
docker run -d --name ollama-pull -v nlproto_llm_models:/root/.ollama ollama/ollama:0.12.3
docker exec ollama-pull ollama pull qwen2.5-coder:3b   # etc.
docker rm -f ollama-pull

docker compose -f docker-compose.yml -f docker-compose.nl-reports.yml up -d --build
```

Then Reports → **Ask for a report**.

## Evaluating

```bash
node tools/nl-reports/eval.mjs --check                                  # expected definitions return what you think
node tools/nl-reports/eval.mjs --models qwen2.5-coder:3b,qwen3:4b       # accuracy + latency per model
node tools/nl-reports/eval.mjs --models qwen2.5-coder:3b --file tools/nl-reports/holdout.json
```

A question passes when the model's definition returns **exactly the same rows** as the hand-written
expected definition. Questions whose expected answer is empty on the test data are reported as weak —
a wrong definition can also return nothing.

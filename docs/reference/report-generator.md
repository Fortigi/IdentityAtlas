# Report Generator (local LLM)

!!! note "Experimental, and optional"
    The report generator is an extra container you choose to deploy. Without it, custom reports are
    still built by hand — see [Custom Reports](../ui/custom-reports.md). The feature as a whole is off
    until an operator enables it under **Admin → Experimental**.

## Why this exists

Every customer asks the same kind of question about their own environment: *guest accounts without a
manager*, *groups nobody owns*, *accounts that still sit in a licence group*. Each answer is a
different query. Shipping a built-in report for every one of them does not scale, and teaching
analysts a query builder covers only the people willing to learn it.

So the analyst describes the report and Identity Atlas builds it — but **the model never writes the
query**. It fills in a **report definition**: which kind of record, which conditions, which columns.
Identity Atlas validates that definition against its own catalog and compiles it to read-only SQL.

That split is the whole design, and it is what makes the feature defensible:

| | Because the model only fills in a definition |
|---|---|
| **The model never sees your data** | It gets the question, the list of fields it may use, and the type names that exist (e.g. `Guest`, `ServicePrincipal`). No rows, ever. |
| **It cannot do damage** | Unknown fields, unknown operators and unknown values are rejected. The query is parameterised, runs in a read-only transaction with a statement timeout, and touches only the tables the catalog names. |
| **You can check it** | The definition is shown back as editable criteria plus a plain-language sentence generated from what will actually run. |
| **It is repeatable** | A saved report is a definition, not a captured answer. It runs again after the next crawl and gives today's answer. |
| **It works without the model** | The same definitions can be built by hand, which is what every deployment without the extra container does. |

## The model

| | |
|---|---|
| Model | **Qwen3-4B-Instruct-2507**, 4-bit quantised (`Q4_K_M`), ~2.5 GB |
| Licence | **Apache 2.0** — commercial use permitted. The licence text ships inside the image at `/models/MODEL-LICENSE.txt` |
| Source | Pinned URL **and SHA-256** in `setup/docker/Dockerfile.report-generator`; the build fails if the file does not match |
| Runtime | `llama.cpp` server, CPU only. No GPU, no external API, no telemetry |
| Chosen by | The release. There is no model picker: **Admin → LLM** shows which model this version ships and whether it is answering |

The model is part of the release so that a given Identity Atlas version always behaves the same way
and we can state what it was measured at. Changing the model is a new release.

### Models we evaluated

Measured against a set of real analyst questions on a real tenant (Fortigi: ~1,150 accounts, 158
groups, 10 business roles), plus a **held-out** set written before tuning and never used to improve
prompts. A question counts as correct only when the generated report returns **exactly** the same rows
as a hand-written reference definition.

| Model | Licence | Tuning set | Held-out set | Notes |
|---|---|---|---|---|
| **Qwen3-4B-Instruct-2507 (shipped)** | Apache 2.0 | **30/39 (77%)** | **13/17 (76%)** | Best of every model tested, commercial use allowed |
| Qwen2.5-Coder 3B | ⛔ Qwen Research (non-commercial) | 28/32 (88%) at the time | 9/14 (64%) | Strongest early candidate; **cannot be shipped** |
| Qwen2.5-Coder 1.5B | Apache 2.0 | 21/36 (58%) | 8/14 (57%) | Runs on 1 CPU / 2 GB, but clearly weaker |
| Qwen2.5-Coder 0.5B | Apache 2.0 | 7/32 (22%) | 5/14 (36%) | Unusable: copies the examples |
| Phi-4-mini (3.8B) | MIT | 11/32 (34%) | — | |
| Gemma 3 4B | Gemma terms | run abandoned | — | ~80 s per question: its attention design defeated prompt caching |
| Qwen2.5-Coder 7B | Apache 2.0 | spot checks only | — | Too slow on 2 CPUs for the benefit |

The sets grew during development (32 → 39 tuning, 14 → 17 held-out), so the percentages above are
comparable within a row, not exactly across rows. The current figures for the shipped model are the
full sets. Re-run any time with `tools/nl-reports/eval.mjs` — see
[Measuring it yourself](#measuring-it-yourself).

### What the mistakes look like

Roughly one in four questions comes back wrong, so the point is not perfection but **visible**
mistakes. Typical failures, all of which show up in the plain-language reading:

- a condition dropped ("groups mostly like Sales, **not in a business role**" lost the second half);
- the wrong relation ("contains all members of business role X" read as "is part of business role X");
- a comparison replaced by a name filter.

Two failure modes are handled in code rather than left to the model:

- **"or" read as "and"** — if the question contains *or* but the definition has no any-group, the
  generator asks the model once to correct it, and keeps the original if the correction is no better.
- **Invented values** — a definition with an unknown field, operator or type value is rejected, the
  validator's own message is handed back to the model, and it gets one attempt to fix it.

## Privacy

- **Nothing leaves the deployment.** The model runs in a container next to Identity Atlas. There is no
  cloud model, no API key to a provider, and no telemetry in this path.
- **The model receives**: the analyst's question, the catalog (entity, field and relation names with
  their descriptions), the type values that exist in this deployment (account types, resource types,
  system names) and, while refining, the current report definition.
- **The model never receives**: rows, names of people, group names, or any query result. Name lookups
  ("did you mean…") are done by the database, not by the model.
- **On Docker** the container has no published port, sits on an internal network shared only with the
  web container, and has no route to the internet. It does not need one: the model is inside the image.
- **On Azure** there is no VNet in this deployment shape, so the Container App has public ingress
  protected by a per-deployment API key (generated by the template, never entered by hand), and
  narrowed to the web app's own outbound addresses. It holds no data and no credentials.
- **Audit**: every question is logged by the API with the user who asked, the model used and the
  outcome. Saved reports record who created and last changed them.
- **The audit line contains the question as typed**, which means it can contain a name an analyst
  typed ("groups like Jan de Vries"). That is deliberate — an audit trail of "someone asked
  something" is not worth keeping — but it is worth knowing when deciding how long to keep container
  logs. No query *result* is ever logged.

## Sizing and consumption

Measured on a 2-vCPU VM (shared Proxmox host, Intel Core Ultra 5), with the shipped model:

| | Value |
|---|---|
| CPU | **2** (works on 1, roughly twice as slow) |
| Memory | **5 GB** limit; ~2.9 GB actually in use with the model loaded |
| Disk | ~2.8 GB image + ~600 MB prompt cache |
| Cold start → first answer | **~70 s** (model load 3.5 s + prompt cache restore 0.1 s + the answer) |
| Question once warm | **20–60 s** (median 41 s, p90 100 s over the full question set) |
| One-time preparation | ~190–220 s, in the background, after an install or update |
| Idle | no CPU. Memory stays reserved while the container runs |

**It only costs while it is used** in the sense that matters for each platform:

- **Docker**: the container idles at essentially zero CPU. Memory stays allocated, so on a small host
  either accept ~3 GB or start the profile only when you need it.
- **Azure**: the Container App **scales to zero**. Azure bills per second of activity, so an idle
  generator costs nothing beyond its share of the file share holding the prompt cache. At list prices,
  2 vCPU + 4 GiB is roughly **€0.20–0.25 per active hour**, and Container Apps' monthly free grant
  covers light use. Check current pricing before quoting it. The trade-off is a slower first question
  after idle, because the container has to start (image pull included).

### How the cold start was made survivable

The expensive part is not loading the model, it is the model *reading its instructions* (~4,000
tokens) — minutes on a small CPU. Three things fix that:

1. **The instructions are the same for every deployment of a release.** Everything deployment-specific
   (your account types, resource types and system names) is sent with the question instead of being
   baked into them.
2. **The processed instructions are saved to disk** (llama.cpp slot cache) and restored in ~0.1 s on
   every later start — including after a scale-to-zero on Azure.
3. **Preparation runs in the background** at API startup, and the builder says "preparing" instead of
   blocking. `node tools/nl-reports/prepare-prompt-cache.mjs` does it on demand and verifies a restore
   actually works.

Before this, a cold start was ~6 minutes; it is now ~70 seconds on the same hardware.

## Deploying it

### Docker

The model server is an opt-in profile in `docker-compose.prod.yml`:

```bash
# in .env
COMPOSE_PROFILES=report-generator
FEATURE_CUSTOM_REPORTS=true        # or switch it on in Admin → Experimental

docker compose -f docker-compose.prod.yml up -d --pull always
```

Optional knobs (defaults shown): `REPORT_GENERATOR_CPUS=2`, `REPORT_GENERATOR_MEMORY=5g`.

Leave `COMPOSE_PROFILES` unset and nothing extra is pulled or started; the builder then reports the
generator as unavailable and the definition editor still works.

### Azure

The report generator is an **opt-in Container App**:

```powershell
./azure/deploy.ps1 -ResourceGroup my-rg -DeployReportGenerator
```

or set `deployReportGenerator=true` when deploying `azure/main.bicep` / the Deploy-to-Azure template.
The template then:

- creates the Container App with **minReplicas 0** (scale to zero) and 2 vCPU / 4 GiB;
- generates an API key per deployment and gives it to both sides — llama.cpp refuses every request
  without it;
- mounts an Azure Files share for the prompt cache, so a scaled-to-zero app restarts fast;
- sets `FEATURE_CUSTOM_REPORTS=true` on the web app, because a deployment that paid for the container
  wants the feature.

Everything else (App Service, Postgres, worker) is unchanged. Leaving the switch off deploys exactly
what it does today.

### Updating an existing installation

Custom reports arrive with a normal update; **the generator does not install itself.**

| | What the operator does |
|---|---|
| **Docker** | Re-download `docker-compose.prod.yml` (it gained the service, the internal network and the new env vars), then set `COMPOSE_PROFILES=report-generator` and pull. Without the new compose file the app updates as usual and the generator is simply absent. |
| **Docker, auto-update** | The [auto-update agent](../admin/auto-updates.md) updates the services in `IA_SERVICES` (`web worker` by default). Add `report-generator` there so the model image follows the channel too. |
| **Azure** | Re-run the deployment with `deployReportGenerator=true`. Existing resources are updated in place. |
| **Desktop (portable)** | Not supported — the portable launcher runs no extra containers. The definition editor works. |

In all cases the feature stays **off** until someone enables it in Admin → Experimental, and the first
warm-up after the update rebuilds the prompt cache in the background (a few minutes, once).

## Security notes

- The API surface answers **404** while the feature is off and **403** without the
  `data.write.reports` permission (checked first, so nobody learns which installs have the feature).
- Model output is treated as untrusted input: it is validated against the catalog before anything
  runs, and never interpolated into SQL.
- Reports execute in a `READ ONLY` transaction with a statement timeout and a row cap.
- The model server accepts no input except from the web container (Docker: internal network; Azure:
  API key), and it can neither reach the database nor the internet.
- Questions are logged; report definitions are stored with their author.
- The model server's monitoring endpoint is switched off (`--no-slots`). It would otherwise let any
  caller read the prompt currently being processed.
- The container runs as an unprivileged user (uid 1000), not root.

### If you deploy it on Azure

Two details are worth knowing, because getting them wrong is silent:

- **The API key is the control.** llama.cpp reads it from `LLAMA_API_KEY` and *only* that name — the
  `LLAMA_ARG_` prefix that every other option uses is ignored for this one, and a server started
  without a key answers everyone. The template sets the right name from a secret and a guard test
  keeps it that way; do not hand-edit it.
- **Ingress is narrowed on the second run.** `deploy.ps1 -DeployReportGenerator` adds the web app's
  outbound addresses to the ingress allow-list, but those addresses only exist once the web app does,
  so the *first* deployment is protected by the key alone. Re-run the script (or pass
  `reportGeneratorAllowedCallerIps`) to add the allow-list. Those are shared Azure addresses, so treat
  it as defence in depth rather than a boundary.

## Measuring it yourself

```bash
# the expected answers are still right for your data
node tools/nl-reports/eval.mjs --check

# accuracy + latency, per model
node tools/nl-reports/eval.mjs --models qwen3:4b-instruct-2507-q4_K_M
node tools/nl-reports/eval.mjs --models qwen3:4b-instruct-2507-q4_K_M --file tools/nl-reports/holdout.json
```

Questions live in `tools/nl-reports/questions.json` (used while tuning) and `holdout.json` (kept
untouched, so the number means something). Each question carries a hand-written reference definition;
a model's answer counts only if it returns the same rows.

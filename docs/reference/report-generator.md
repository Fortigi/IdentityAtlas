# Report Generator (local LLM)

!!! warning "Docker is measured; Azure is not"
    Everything measured on this page was measured on **Docker** (one 2-vCPU VM). The Azure templates
    compile and are wired up, but the report generator **has not yet been deployed to Azure**:
    scale-to-zero, the prompt cache on Azure Files, the request time limits described under
    [Azure](#azure) and both network modes are unproven there. Deploy it on Azure only to try it out.

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
| Licence | **Apache 2.0** — commercial use permitted. The licence text ships inside the image at `/models/MODEL-LICENSE.txt`, with an attribution notice. llama.cpp (MIT) ships its licence next to it |
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

Only the first row was measured on the setup that ships (llama.cpp, the final prompt, the bounded
grammar); its raw results are kept with the evaluation tools. The other rows were measured earlier, on
a different model runtime (Ollama) and an earlier version of the prompt, so read them as the reason each
model was dropped, not as a like-for-like ranking.

| Model | Licence | Tuning set | Held-out set | Notes |
|---|---|---|---|---|
| **Qwen3-4B-Instruct-2507 (shipped)** | Apache 2.0 | **34/42 (81%)** | **14/17 (82%)** | Best of every model tested, commercial use allowed |
| Qwen2.5-Coder 3B | ⛔ Qwen Research (non-commercial) | 28/32 (88%) at the time | 9/14 (64%) | Strongest early candidate; **cannot be shipped** |
| Qwen2.5-Coder 1.5B | Apache 2.0 | 21/36 (58%) | 8/14 (57%) | Runs on 1 CPU / 2 GB, but clearly weaker |
| Qwen2.5-Coder 0.5B | Apache 2.0 | 7/32 (22%) | 5/14 (36%) | Unusable: copies the examples |
| Phi-4-mini (3.8B) | MIT | 11/32 (34%) | — | |
| Gemma 3 4B | Gemma terms | run abandoned | — | ~80 s per question: its attention design defeated prompt caching |
| Qwen2.5-Coder 7B | Apache 2.0 | spot checks only | — | Too slow on 2 CPUs for the benefit |

The sets grew during development (32 → 42 tuning, 14 → 17 held-out), so the percentages above are
comparable within a row, not exactly across rows. The shipped model's figures are the full sets,
measured on the release image as it ships — llama.cpp, the saved prompt cache, and the bounded output
grammar described below. Before the sign-in fields were added, the same setup scored 34/39 and 14/17; the
larger prompt answers the new sign-in questions but moved two unrelated answers (33/41 and 13/17), and each
prompt variant tried since traded one question for another. Looking up the names a question mentions
(see [Privacy](#privacy)) won one held-out question back without losing a tuning question; the tuning
set's organisation question (42nd) was added with it and measured on its own. A run is repeatable — the
same prompt gives the same answers — so these differences are real, not noise; the sets are just too
small to tune further without fitting them. A few questions have an empty correct answer, which a wrong
definition can also produce; counting only questions with a non-empty answer, the shipped model scores
33/41 and 12/15. Re-run any time with `tools/nl-reports/eval.mjs` —
see [Measuring it yourself](#measuring-it-yourself).

### What the mistakes look like

About one question in seven comes back wrong, so the point is not perfection but **visible**
mistakes. Typical failures, all of which show up in the plain-language reading:

- a condition dropped ("groups mostly like Sales, **not in a business role**" lost the second half);
- the wrong relation ("contains all members of business role X" read as "is part of business role X");
- a guess instead of a question: "everyone with admin rights" came back as one kind of admin. It asked
  on **neither** of the two deliberately ambiguous questions.

**Comparisons are the weakest kind of question: 3 of 6 correct** across both sets. The one this feature
was demonstrated with ("groups with the same members as business role *Fortigi - Algemeen - Maten*,
not part of it") is among the three that pass. For a comparison that matters, build it with
**+ compare with…** in the editor — once built, a comparison is exact; only the translation from
words is uncertain.

Three failure modes are handled in code rather than left to the model:

- **"or" read as "and"** — if the question contains *or* but the definition has no any-group, the
  generator asks the model once to correct it, and keeps the original if the correction is no better.
- **Invented values** — a definition with an unknown field, operator or type value is rejected, the
  validator's own message is handed back to the model, and it gets one attempt to fix it. If the
  corrected definition is still invalid, the analyst gets an error — never a report quietly built from
  the conditions that did validate.
- **Repeating itself** — at temperature 0 a small model that starts repeating does not stop. Every list
  and every piece of free text in the reply has a hard length in the output grammar, so a loop ends
  where validation would have cut it anyway. Before that limit existed, one question listed the same ten
  columns until the token cap: 570 seconds and a reply that was no longer JSON. It now answers in 46.

## Privacy

- **Nothing leaves the deployment.** The model runs in a container next to Identity Atlas. There is no
  cloud model, no API key to a provider, and no telemetry in this path.
- **The model receives**: the analyst's question, the catalog (entity, field and relation names with
  their descriptions), the type values that exist in this deployment (account types, resource types,
  system names), while refining the current report definition, and — for a name the question
  mentions — **which fields that name occurs in**.
- **That last one is the only thing looked up in the data for the model, and it is deliberately
  narrow.** When a question names something ("guest accounts from Contoso"), the API checks, per name,
  whether it occurs as a whole word in a fixed set of text fields (name, email, company, department, job
  title, description) and in system names. The model is told the field names only —
  `"Contoso": user.companyName, user.email` — never a row, a value from the row, or a count. It
  learns that a word the analyst typed exists in the data, which the analyst already implied by asking.
  Without it, the model guessed where an organisation name lives and filtered on an unrelated system.
- **The model never receives**: rows, query results, counts, or any value it did not get from the
  analyst. Name lookups ("did you mean…") are done by the database, not by the model.
- **Names do reach it in one way, and it is worth being exact about it.** Whatever the analyst types is
  sent as typed, names included. And once an analyst confirms a "did you mean", the confirmed record's
  name is written into the definition — so if they then refine the report in words, that definition,
  with that name, goes back to the model. Nothing leaves the deployment either way; it is the model
  inside it that sees the name.
- **On Docker** the container has no published port, sits on an internal network shared only with the
  web container, and has no route to the internet. It does not need one: the model is inside the image.
- **On Azure** the Container App has public ingress, protected by a per-deployment API key (generated
  by the template, never entered by hand). In the default public network mode it is also narrowed to
  the web app's outbound addresses; in the private network mode it is protected by the key alone (see
  below). It holds no data and no credentials.
- **Audit**: every question is logged by the API twice — on arrival, with the user who asked, the model
  and the question; and when it is answered, with the outcome (report, clarification, "did you mean",
  error, or failed) and how long it took. The reply itself is not logged. Saved reports record who
  created and last changed them.
- **The audit line contains the question as typed**, which means it can contain a name an analyst
  typed ("groups like Jan de Vries"). That is deliberate — an audit trail of "someone asked
  something" is not worth keeping — but it is worth knowing when deciding how long to keep container
  logs. No query *result* is ever logged.

## Sizing and consumption

Measured on a 2-vCPU VM (shared Proxmox host, Intel Core Ultra 5), with the shipped model:

| | Value |
|---|---|
| CPU | **2**. Only 2 CPUs were measured; answer time scales roughly with CPUs, so fewer is slower |
| Memory | **3.2 GB** in use and not reclaimable after all 56 questions; 3.65 GB peak including file cache. Limit **4 GiB** on both Docker and Azure — the five heaviest questions were re-run at exactly 4 GiB with identical results and no out-of-memory kill. Lower is not measured |
| Disk | 2.76 GB image + 561 MB prompt cache |
| Restart → first answer | **76 s** measured for "guest accounts without a manager, or whose manager is disabled": prompt cache restored in 0.1 s, 203 of 4,000 prompt tokens actually read, the rest is the answer being written. On Azure add the container start |
| Question once warm | median **49 s**, p90 **107 s**, slowest **156 s** over the tuning set (held-out: median 48 s, p90 78 s). The slow ones are the questions that needed a correction round |
| One-time preparation | 193–205 s measured, in the background, after an install or update |
| Idle | **10.6 MB** once the model is unloaded — after 15 minutes unused by default. While it is loaded and idle: no CPU, ~3 GB |
| Unloaded → ready | **3.0 s** with the model file in the disk cache, **15.6 s** straight from disk. The builder shows "loading the model into memory" with a timer meanwhile, and the first question afterwards is as fast as ever (76 s measured, same prompt cache) |

Nearly all of an answer's time is the model *writing* the definition, at about 2.5 tokens a second on
2 CPUs; an average reply is ~105 tokens. More CPUs is what makes answers faster — more memory does
not.

**It only costs while it is used** in the sense that matters for each platform:

- **Docker**: the model is **loaded only while it is used**. Opening the report builder loads it (3–16 s);
  after `REPORT_GENERATOR_IDLE_SECONDS` without a question (900 by default) it is unloaded and the
  container drops to ~10 MB. A host running the generator therefore needs the 4 GB only while
  someone is building reports. Set the idle time to `0` to keep the model loaded all the time.
- **Azure**: the Container App **scales to zero**. Azure bills per second of activity, so an idle
  generator costs nothing beyond its share of the file share holding the prompt cache. At list prices,
  2 vCPU + 4 GiB active costs in the order of tens of euro cents an hour, and Container Apps' monthly
  free grant covers light use — an estimate from list prices, not a measured bill; check current
  pricing. The trade-off is a slower first question after idle, because the container has to start
  (a 2.76 GB image pull included).

### How the cold start was made survivable

The expensive part is not loading the model, it is the model *reading its instructions* (~4,000
tokens) — minutes on a small CPU. Three things fix that:

1. **The instructions are the same for every deployment of a release.** Everything deployment-specific
   (your account types, resource types and system names) is sent with the question instead of being
   baked into them.
2. **The processed instructions are saved to disk** (llama.cpp slot cache) and restored in ~0.1 s on
   every later start. That is measured on local disk; on Azure the 561 MB file lives on an Azure Files
   share, whose restore time has not been measured.
3. **Preparation runs in the background** at API startup, and the builder says "preparing" instead of
   blocking. `node tools/nl-reports/prepare-prompt-cache.mjs` does it on demand and verifies a restore
   actually works.

Measured on the same hardware: 266 seconds for the first answer without a restored cache, 76 seconds
with one.

One detail made the difference between this working and not: **the prompt cache is re-checked before
every question, never remembered.** The model server restarts on its own — Azure scales it to zero
between questions — and comes back empty. An earlier version remembered that it had warmed up, never
restored after such a restart, and answered the next question in 266 seconds.

## Deploying it

### Docker

The model server is an opt-in profile in `docker-compose.prod.yml`:

```bash
# in .env
COMPOSE_PROFILES=report-generator
FEATURE_CUSTOM_REPORTS=true        # or switch it on in Admin → Experimental

docker compose -f docker-compose.prod.yml up -d --pull always
```

Optional knobs (defaults shown): `REPORT_GENERATOR_CPUS=2`, `REPORT_GENERATOR_MEMORY=4g`,
`REPORT_GENERATOR_IDLE_SECONDS=900` (seconds unused before the model is unloaded; `0` = always loaded).

How the model is loaded on demand: a small supervisor is the container's main process. It starts the
model server (reachable only from inside the container) when a request needs it, passes every request
through unchanged, and stops it when idle. It needs no extra privileges — it never touches Docker — and it
checks the API key before it starts anything.

Leave `COMPOSE_PROFILES` unset and nothing extra is pulled or started; the builder then reports the
generator as unavailable and the definition editor still works.

**Behind a reverse proxy**, raise its read timeout for `/api/nl-reports/interpret`. A question is one
HTTP request that is answered when the model is done — a median of 49 s and up to several minutes — and
common defaults (nginx `proxy_read_timeout` 60 s) cut half of them off. The API itself waits up to
15 minutes (`NL_REPORTS_LLM_TIMEOUT_MS`).

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

**Known limits on Azure, not yet measured there:**

- **Request time limits.** A question is one blocking HTTP request, and Azure closes those: App Service
  at about 230 seconds for the browser's request, Container Apps ingress at 240 seconds for the web
  app's call to the generator. Measured on Docker, a warm question takes 49 s at the median and 165 s at
  the slowest, so most fit; but the one-time prompt-cache preparation took 193–205 s, close to the
  240 s limit, and Azure's vCPUs may be slower. If preparation is cut off, the cache is never saved and
  every question stays slow. Making questions asynchronous (submit, then poll) would remove this limit
  and is the fix if a deployment hits it.
- **Private network mode is not supported for the generator yet.** In that mode the web app routes all
  outbound traffic through the VNet without a NAT gateway, and whether it can then reach the
  generator's public address at all is untested. Deploy the generator only in the default public
  network mode until it can be made reachable from inside the VNet.

### Updating an existing installation

Custom reports arrive with a normal update; **the generator does not install itself.**

| | What the operator does |
|---|---|
| **Docker** | Re-download `docker-compose.prod.yml` (it gained the service, the internal network and the new env vars), then set `COMPOSE_PROFILES=report-generator` and pull. Without the new compose file the app updates as usual and the generator is simply absent. |
| **Docker, auto-update** | The [auto-update agent](../admin/auto-updates.md) updates the services in `IA_SERVICES` (`web worker` by default). Add `report-generator` there so the model image follows the channel too. |
| **Azure** | Re-run the deployment with `deployReportGenerator=true`. Existing resources are updated in place. |
| **Azure, auto-update** | Set `IA_REPORT_GENERATOR_APP=<prefix>-report-generator` for the Azure update agent, next to `IA_WORKER_APP`, so the model image follows the channel. Without it the generator keeps the previous release's model — it still works, but it is no longer the combination that was measured. |
| **Desktop (portable)** | Not supported — the portable launcher runs no extra containers. The definition editor works. |

In all cases the feature stays **off** until someone enables it in Admin → Experimental, and the first
warm-up after the update rebuilds the prompt cache in the background (a few minutes, once). An install
that does nothing keeps working exactly as before: a new, empty table is added, and nothing tries to
reach a model server while the feature is off.

**Grant the permission.** The **Build custom reports** permission (`data.write.reports`) is in the
built-in RoleMiner role, but only a deployment still on the default role mapping gets it from there. If
you have customised your role mapping, add the permission to the roles that should build reports under
Admin → Roles.

## Security notes

- The API surface answers **404** while the feature is off and **403** without the
  `data.write.reports` permission (checked first, so nobody learns which installs have the feature).
- Model output is treated as untrusted input: it is validated against the catalog before anything
  runs, and never interpolated into SQL.
- Reports execute in a `READ ONLY` transaction with a statement timeout and a row cap.
- The model server accepts no input except from the web container (Docker: internal network; Azure:
  API key) and cannot reach the database.
- **Outbound internet access differs per platform.** On Docker it has none (an `internal` network). On
  Azure it has unrestricted outbound access, like any Container App without a VNet and egress rules.
  llama.cpp makes no outbound calls and the model is inside the image, so nothing is sent — but on
  Azure that rests on the software, not on the network.
- **One question at a time per analyst**, and a conversation is capped at 10,000 characters. The model
  server works on one question at a time, so without these one person (or a script) could hold it for
  everyone. Anyone with `data.write.reports` can still keep it busy; grant that permission accordingly.
- **The generated SQL is shown to the analyst** in the builder, so table and column names are visible to
  anyone who can build reports. They are the same names documented for the data model.
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
- **In the private network mode the allow-list is not applied.** There the web app sends all outbound
  traffic through the VNet, so its calls do not come from the addresses on the list and the list would
  lock it out. The generator is protected by its API key alone. It still has public ingress in that
  mode — making it reachable only from inside the VNet is not done yet.

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

# LLM and Risk Scoring Internals

This page describes how risk profiling and risk scoring work inside the API: the LLM provider layer, the risk-profile wizard and its endpoints, and the scoring engine. All LLM calls go through the API container; the worker container has no LLM dependency. The secrets vault that holds the LLM API key has its own page: [Secrets and the Master Key](secrets-and-master-key.md).

## Big picture

```
                  ┌────────────────────┐
   user (UI) ───▶ │  Risk Profile       │ ── chat with LLM via the API
                  │  Wizard (React)     │ ── never touches API keys directly
                  └─────────┬──────────┘
                            │
                            ▼
                  ┌────────────────────┐    ┌──────────────────┐
                  │  /api/risk-profiles │───▶│ llm/service.js   │
                  │  /api/risk-class…   │    │ + providers.js    │
                  │  /api/risk-scoring  │    │ + scraper.js      │
                  └─────────┬──────────┘    └──────┬───────────┘
                            │                       │
                            ▼                       ▼
                  ┌────────────────────┐    ┌──────────────────┐
                  │  postgres tables    │    │ Anthropic / OpenAI│
                  │  RiskProfiles       │    │ Azure OpenAI     │
                  │  RiskClassifiers    │    │ (HTTPS)          │
                  │  RiskScores         │    └──────────────────┘
                  │  ScoringRuns        │
                  │  Secrets (vault)    │
                  └────────────────────┘
```

Risk scoring is started from the UI and runs inside the web container as a background job: the engine is a plain JavaScript module loaded by the same Node process that serves the API.

## Components

### 1. LLM provider abstraction — `app/api/src/llm/providers.js`

One small adapter per provider behind a single `chat({system, messages, model, temperature, maxTokens})` signature.

| Provider     | URL pattern                                                                                                | Auth header     |
|--------------|------------------------------------------------------------------------------------------------------------|-----------------|
| anthropic    | `https://api.anthropic.com/v1/messages`                                                                    | `x-api-key`     |
| openai       | `https://api.openai.com/v1/chat/completions`                                                               | `Authorization` |
| azure-openai | `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...`                              | `api-key`       |

The Azure adapter requires `endpoint`, `deployment`, and (optional) `apiVersion` in the config object. The endpoint must be an Azure OpenAI host (`*.openai.azure.com`, `.us` or `.cn`) over HTTPS. The deployment name is what appears in the `model` field when calling; Azure resolves it to the underlying model on its side.

Default models: Anthropic `claude-sonnet-4-6`, OpenAI `gpt-4o`. Azure OpenAI has no default: the deployment name must be supplied.

All adapters use Node's built-in `fetch`. Every call has a time limit (`LLM_TIMEOUT_MS`, default 120 seconds), reads at most 16 MB of response, and refuses to follow redirects.

### 2. LLM service — `app/api/src/llm/service.js`

Glue between the vault, the `WorkerConfig` table, and the providers module:

- `getLLMConfig()` / `saveLLMConfig({...})` / `clearLLMConfig()` persist the non-secret config (`provider`, `model`, `endpoint`, `deployment`, `apiVersion`) in `WorkerConfig` under key `LLM_CONFIG`. The API key goes into the vault under id `llm.apikey`, scope `llm`.
- `chatWithSavedConfig({system, messages})` makes a chat call with whatever the user has configured.
- `testLLMConfig({...})` does a round-trip test and returns `{ok, model, latencyMs, sample}` or `{ok:false, error}`.

### 3. URL scraper — `app/api/src/llm/scraper.js`

Fetches one or more URLs and returns plain text suitable for an LLM context window. The text is held in memory only as long as the profile-generation request that triggered it; nothing is indexed.

- Per-URL credentials: `{username, password}` → Basic, or `{bearer}` → Bearer. The credentials are stored in the vault.
- HTML stripping is intentionally crude (remove `<script>`, `<style>`, `<nav>`, decode entities, collapse whitespace). It only needs to give the LLM enough text to identify the organisation.
- Caps: 50 KB per URL, 15 seconds per request, at most 5 redirects.

### 4. Risk profile and classifier API — `app/api/src/routes/riskProfiles.js`

All endpoints require the `admin.llm` permission. The three generation endpoints are limited to 10 calls per minute per caller.

| Method | Path                                                | Purpose                                                  |
|--------|------------------------------------------------------|----------------------------------------------------------|
| POST   | `/api/risk-profiles/scrape`                          | Scrape URLs (with optional credentials), return per-URL status |
| POST   | `/api/risk-profiles/generate`                        | Run the LLM to produce an initial profile draft (no DB write) |
| POST   | `/api/risk-profiles/refine`                          | Conversational refinement turn (no DB write)             |
| POST   | `/api/risk-profiles`                                 | Save a finalised profile (creates a new version row)     |
| GET    | `/api/risk-profiles`                                 | List saved profiles                                      |
| GET    | `/api/risk-profiles/:id`                             | Get one profile (full body)                              |
| POST   | `/api/risk-profiles/:id/activate`                    | Mark as the active profile                               |
| DELETE | `/api/risk-profiles/:id`                             | Delete                                                   |
| GET    | `/api/risk-profiles/scraper-credentials`             | List per-URL credentials in the vault                    |
| POST   | `/api/risk-profiles/scraper-credentials`             | Create a credential (Basic or Bearer)                    |
| DELETE | `/api/risk-profiles/scraper-credentials/:id`         | Remove a credential                                      |
| POST   | `/api/risk-classifiers/generate`                     | Generate classifiers from a saved profile                |
| POST   | `/api/risk-classifiers`                              | Save a classifier set                                    |
| GET    | `/api/risk-classifiers`                              | List                                                     |
| GET    | `/api/risk-classifiers/:id`                          | Get one (full body)                                      |
| POST   | `/api/risk-classifiers/:id/activate`                 | Activate                                                 |
| DELETE | `/api/risk-classifiers/:id`                          | Delete                                                   |

The generation endpoints **do not write to the database**. Drafts live only in the wizard's React state until the user clicks Save. Discarding is trivial, and a half-finished refinement never pollutes the history.

### 5. Risk scoring engine — `app/api/src/riskscoring/engine.js`

The engine scores every account (`Principal`) and every resource (`Resource`, business roles included) in four layers:

- **Layer 1 — direct classifier match** (weight 0.50). The classifier patterns run against the display name, e-mail, job title, department, description, mail, external ID and the flattened extended attributes. The best match becomes the direct score; all matches are recorded for the UI. A group whose name looks like a non-production environment (acceptance, test, development and similar) gets a quarter of its direct score, at least 5.
- **Layer 2 — membership** (weight 0.20, capped at 40). Groups: +5 for 1 to 5 members, +5 for members but no owner. Accounts: up to +15 for membership of more than 15 groups, +15 for membership of a group whose direct score is 70 or more, +5 for owning more than 3 groups. When the manager hierarchy is known, managers also get points for a wide span of control, a large subtree and high-risk direct reports.
- **Layer 3 — structural hygiene** (weight 0.10, capped at 25). Groups: no description (+3), mail-enabled security group (+3), role-assignable group (+15), dynamic membership (+3). Accounts: disabled but still a member (+5), guest (+5), last sign-in more than 90 days ago (+10).
- **Layer 4 — propagation** (weight 0.20). One pass: an account inherits 30% of the pre-propagation score of its riskiest group, and a group 25% of its riskiest member's.

Final score = `min(100, round(0.50·direct + 0.20·membership + 0.10·structural + 0.20·propagated))`. Tier thresholds (`riskscoring/tiers.js`): 90+ Critical, 70+ High, 40+ Medium, 20+ Low, 1+ Minimal, 0 None.

Accounts whose `principalType` is `ServicePrincipal`, `ManagedIdentity`, `WorkloadIdentity` or `AIAgent` are matched against the `agentClassifiers` set instead of `userClassifiers` when one is present.

A run deletes every row in `RiskScores` and writes the new scores in one transaction. Analyst overrides are not carried over; see the [Risk Scores API](../api/risk-scores.md).

### 6. Scoring runs — `app/api/src/routes/riskScoringRuns.js`

| Method | Path                            | Purpose                                                |
|--------|----------------------------------|--------------------------------------------------------|
| POST   | `/api/risk-scoring/runs`         | Start a run (`admin.crawlers`); returns `202` and the row. The engine runs in the background. |
| GET    | `/api/risk-scoring/runs`         | The 50 most recent runs                                |
| GET    | `/api/risk-scoring/runs/:id`     | Progress of one run (polled by the UI)                 |

Runs are tracked in the `ScoringRuns` table with `status / step / pct / totalEntities / scoredEntities / errorMessage`. Only one run can be in progress at a time; a second start answers `409`. Status transitions: `pending → running → completed | failed`.

### 7. UI — `app/ui/src/components/RiskProfileWizard.jsx`

A multi-step modal launched from the **New profile** button on Admin → Risk Scoring. Steps:

1. **Sources** — domain, optional organisation name, hints, optional URLs (with credentials).
2. **Generate & Refine** — `POST /risk-profiles/generate`, then a chat panel for `/risk-profiles/refine` calls. The current profile JSON is shown next to the chat history.
3. **Save Profile** — name and activate toggle.
4. **Classifiers** — `POST /risk-classifiers/generate`, review the JSON, save.
5. **Run Scoring** — `POST /risk-scoring/runs`, polled every 2 seconds for progress.

All draft state lives in the browser. Refreshing the wizard mid-flow loses the draft.

The **LLM Settings** tab in Admin lets the operator pick the provider, the model, (Azure only) the endpoint, deployment and API version, and the API key. **Test connection** makes a single call with either the form values or the saved config, so you can check before saving. The API key is never returned by the server; the form only shows whether one is stored.

## Tests

- `app/api/src/secrets/vault.test.js` — vault round-trip
- `app/api/src/llm/providers.test.js` — adapter URL, headers and parsing for all three providers (mocked fetch)
- `app/api/src/llm/riskPrompts.test.js` — prompt builders and the JSON extractor (markdown fence stripping, leading/trailing prose, nested objects)
- `app/api/src/llm/scraper.test.js` — protocol/MIME validation, HTML stripping, Basic/Bearer header construction, error handling
- `app/api/src/riskscoring/engine.test.js`, `engine.passes.test.js`, `engine.helpers.test.js`, `tiers.test.js` — tier thresholds, the weighted formula, the scoring passes, regex compilation tolerance

Run them with `npm test` from `app/api/`. The runner is Vitest; no database is required.

## What is not built

- **A local model for risk profiles.** The provider list is Anthropic, OpenAI and Azure OpenAI. Identity Atlas does ship a local model, but it serves custom reports and the context assistant, not risk profiles; see [Report Generator](../reference/report-generator.md).
- **News-driven re-scoring** (mergers, security incidents). The classifier system is the right place for it: scheduled news ingestion could produce candidate adjustments for an operator to approve.
- **Retrieval over a long-term document index.** Profiles are built by scraping on creation. Retrieval (for example with `pgvector`) becomes worthwhile once there are hundreds of internal documents.
- **LLM account correlation.** Account correlation was built as the deterministic, dictionary-based [Account Linking](account-linking.md) engine instead: no prompts, no model calls.

## Master key rotation

Rotation, backups and the master key are described on [Secrets and the Master Key](secrets-and-master-key.md#rotating-the-master-key).

## Disabling the feature

The Risk Scoring tab in Admin has a feature toggle (the **Risk Scoring Feature** card). Switching it off hides the Risk Scores tab in the main navigation. The LLM config and the saved profiles and classifiers are kept.

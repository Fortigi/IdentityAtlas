# LLM, Secrets Vault, and Risk Scoring (v5)

This document covers the substrate added in the postgres rewrite for in-app
risk profiling and the surrounding plumbing (secrets vault, LLM provider
abstraction, scoring engine). It supersedes the v4 PowerShell-based risk
scoring docs — the worker no longer talks to an LLM directly. All LLM calls
go through the API container.

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

The worker container has **no** LLM dependency. Risk scoring is initiated from
the UI and runs inside the web container as a background job (the engine is a
plain JS module loaded by the same Node process that serves the API).

## Components

### 1. Secrets vault — `app/api/src/secrets/vault.js`

General-purpose envelope-encrypted secret store for any secret the app needs
(LLM API keys, scraper credentials, future Vault/AWS-SM-backed secrets all live
here).

- **Schema**: [`Secrets`](https://github.com/Fortigi/IdentityAtlas/blob/main/) — id, scope, label, ciphertext, iv, authTag + per-row encryptedKey/keyIv/keyAuthTag.
- **Encryption**: AES-256-GCM. Per-row 32-byte data key. The data key is wrapped by a master key from `IDENTITY_ATLAS_MASTER_KEY` (32 bytes, base64).
- **Master key bootstrap**:
  1. `IDENTITY_ATLAS_MASTER_KEY` env var (preferred — back this up like any other root secret)
  2. `/data/uploads/.master-key` file (auto-generated on first boot, persisted in the same docker volume as the worker key)
- **Public API**: `putSecret`, `getSecret`, `hasSecret`, `deleteSecret`, `listSecrets(scope)`, `selfTest()`.
- **Why envelope encryption**: per-row keys mean a single compromised secret doesn't expose the others; rotating the master key only re-encrypts the small data keys, not the (potentially large) ciphertexts; the same shape works for an HSM/KMS later by swapping the wrapping function.

For development, the bootstrap auto-generates and persists a master key on first
start. **For production deployments, always set `IDENTITY_ATLAS_MASTER_KEY`
explicitly** so the key can be backed up alongside other root secrets.

### 2. LLM provider abstraction — `app/api/src/llm/providers.js`

One small adapter per provider behind a single `chat({system, messages, model, temperature, maxTokens})` signature.

| Provider     | URL pattern                                                                                                | Auth header     |
|--------------|------------------------------------------------------------------------------------------------------------|-----------------|
| anthropic    | `https://api.anthropic.com/v1/messages`                                                                    | `x-api-key`     |
| openai       | `https://api.openai.com/v1/chat/completions`                                                               | `Authorization` |
| azure-openai | `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...`                              | `api-key`       |

The Azure adapter requires `endpoint`, `deployment`, and (optional) `apiVersion`
in the config object. The deployment name is what appears in the `model` field
when calling — Azure resolves it to the underlying model on its side.

Default models: Anthropic `claude-sonnet-4-20250514`, OpenAI `gpt-4o`,
Azure-OpenAI must be supplied per-tenant.

All adapters use Node 20+'s built-in `fetch` — no external dependencies.

### 3. LLM service — `app/api/src/llm/service.js`

Glue between the vault, the WorkerConfig table, and the providers module:

- `getLLMConfig()` / `saveLLMConfig({...})` / `clearLLMConfig()` — persist non-secret config (`provider`, `model`, `endpoint`, `deployment`, `apiVersion`) in `WorkerConfig` under key `LLM_CONFIG`. The API key goes into the vault under id `llm.apikey`, scope `llm`.
- `chatWithSavedConfig({system, messages})` — convenience for code that just wants to make a chat call using whatever the user has configured.
- `testLLMConfig({...})` — round-trip test, returns `{ok, model, latencyMs, sample}` or `{ok:false, error}`.

### 4. URL scraper — `app/api/src/llm/scraper.js`

Fetches one or more URLs and returns plain text suitable for stuffing into an LLM context window. Designed for *scrape-on-create* — the text is held in memory only as long as the profile-generation request that triggered it. No long-term indexing.

- Per-URL credentials: `{username, password}` → Basic, or `{bearer}` → Bearer
- HTML stripping is intentionally crude (remove `<script>`, `<style>`, `<nav>`, decode entities, collapse whitespace). Real HTML parsers were not worth the dependency for "give the LLM enough text to identify the org".
- Caps: 50 KB per URL, 15s per request, 20 URLs per scrape call.

### 5. Risk profile + classifier API — `app/api/src/routes/riskProfiles.js`

Endpoints (all behind the standard auth middleware):

| Method | Path                                                | Purpose                                                  |
|--------|------------------------------------------------------|----------------------------------------------------------|
| POST   | `/api/risk-profiles/scrape`                          | Scrape URLs (with optional credentials), return per-URL status |
| POST   | `/api/risk-profiles/generate`                        | Run the LLM to produce an initial profile draft (no DB write) |
| POST   | `/api/risk-profiles/refine`                          | Conversational refinement turn (no DB write)             |
| POST   | `/api/risk-profiles`                                 | Save a finalised profile (creates a new version row)     |
| GET    | `/api/risk-profiles`                                 | List saved profiles                                      |
| GET    | `/api/risk-profiles/:id`                             | Get one profile (full body)                              |
| POST   | `/api/risk-profiles/:id/activate`                    | Mark as the active profile (trigger enforces uniqueness) |
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

The generation endpoints **do not write to the database**. Drafts live only in
the wizard's React state. The user clicks "Save" to persist. This makes the
"discard" path trivial and means a half-finished refinement doesn't pollute
history.

### 6. Risk scoring engine — `app/api/src/riskscoring/engine.js`

Postgres-native port of the v4 PowerShell scoring logic. v1 implements two of
the four v4 layers; the formula stays the same shape so the others can be
filled in later.

- **Layer 1 — direct classifier match** (weight 0.60). For every Principal and Resource, run the classifier patterns against displayName / email / jobTitle / department / description. The best matching classifier's score becomes the `directScore`. Multiple matches are recorded for the UI.
- **Layer 2 — lightweight membership signal** (weight 0.25). Small groups (≤5 members) get +5. Membership analysis from v4 (PIM eligibility, owner concentration, downstream propagation) is a planned extension.
- **Layer 3 — structural** (weight 0.15) — placeholder, returns 0.
- **Layer 4 — propagated** (weight 0.00) — not yet implemented.

Final score = `min(100, round(0.60·direct + 0.25·membership + 0.15·structural))`.
Tier thresholds: 90+ Critical, 70+ High, 40+ Medium, 20+ Low, 1+ Minimal, 0 None.

Service-principal-style entities (`principalType` in
`ServicePrincipal/ManagedIdentity/WorkloadIdentity/AIAgent`) use the
`agentClassifiers` set instead of `userClassifiers` when one is present.

### 7. Scoring runs — `app/api/src/routes/riskScoringRuns.js`

| Method | Path                            | Purpose                                                |
|--------|----------------------------------|--------------------------------------------------------|
| POST   | `/api/risk-scoring/runs`         | Start a run, returns 202 + the row. Engine fires in the background. |
| GET    | `/api/risk-scoring/runs`         | List recent runs                                       |
| GET    | `/api/risk-scoring/runs/:id`     | Single-run progress (used by polling UI)               |

Runs are tracked in the `ScoringRuns` table with `status / step / pct /
totalEntities / scoredEntities / errorMessage`. The wizard polls every 2
seconds. Status transitions: `pending → running → completed | failed`.

### 8. UI — `app/ui/src/components/RiskProfileWizard.jsx`

Multi-step modal launched from the "New profile" button on Admin → Risk
Scoring. Steps:

1. **Sources** — domain, optional org name, hints, optional URLs (with credentials).
2. **Generate & Refine** — POST `/risk-profiles/generate`, then a chat panel for `/risk-profiles/refine` calls. The current profile JSON is shown side-by-side with the chat history.
3. **Save Profile** — name + activate toggle.
4. **Classifiers** — POST `/risk-classifiers/generate`, review JSON, save.
5. **Run Scoring** — POST `/risk-scoring/runs`, poll for progress.

All draft state lives client-side. Refreshing the wizard mid-flow loses the
draft — that's the v1 trade-off. Persisting drafts is a future improvement.

The **LLM Settings** sub-tab on Admin lets the operator pick provider, model,
(Azure-only) endpoint/deployment/apiVersion, and API key. The "Test connection"
button does a single ping using either the form values or the saved config so
you can verify before clicking Save. The API key is never returned by the
server; the form shows `apiKeySet: true|false` and a placeholder.

## Tests

Coverage added in this work:

- `app/api/src/secrets/vault.test.js` — selfTest round-trip
- `app/api/src/llm/providers.test.js` — adapter URL/headers/parsing for all three providers (mocked fetch)
- `app/api/src/llm/riskPrompts.test.js` — prompt builders + JSON extractor (markdown fence stripping, leading/trailing prose, nested objects)
- `app/api/src/llm/scraper.test.js` — protocol/MIME validation, HTML stripping, Basic/Bearer auth header construction, error handling
- `app/api/src/riskscoring/engine.test.js` — tier thresholds, weighted formula, regex compilation tolerance

Run with `npm test` from `app/api/`. The test runner is vitest; no DB required
(database-backed code paths are exercised by the smoke tests against a real
postgres in the docker stack).

## What's intentionally not in v1

- **Local LLM** (Ollama / Llama / Mistral container). Easy add later — the provider abstraction is the right substrate. Quality on a no-GPU CPU box: Qwen 2.5 14B or Mistral Small 22B will be acceptable for the structured-JSON tasks but noticeably worse than Claude/GPT-4 on industry-specific nuance.
- **News-feed-driven re-scoring** (M&A events, security incidents). The classifier system is the right substrate for this — Phase 3 would add scheduled news-source ingestion that produces "candidate adjustments" for the operator to approve.
- **RAG over a long-term wiki/ISMS index**. Current approach is scrape-on-create. RAG (e.g. with `pgvector`) is the right answer once you have hundreds of internal docs.
- **Account correlation wizard**. Same wizard shape, different prompts and engine. Will reuse the components added here.
- **Layers 2/3/4 of the scoring engine**. Membership analysis (PIM eligibility, owner concentration), structural hygiene (orphan groups, never-signed-in users), and cross-entity propagation. The formula stays the same shape, so adding these is additive rather than a rewrite.

## Operational notes

### Master key rotation

Currently a manual operation:

```bash
# 1. Decrypt all secrets with the old key
docker compose exec web node -e "
  const v = require('./src/secrets/vault.js');
  v.listSecrets('llm').then(async ss => {
    for (const s of ss) console.log(s.id, await v.getSecret(s.id));
  });
"

# 2. Set the new IDENTITY_ATLAS_MASTER_KEY in compose
# 3. Restart web
# 4. Re-save each secret (the wizard's "Save" button does this end-to-end)
```

A `POST /api/admin/secrets/rotate-master-key` endpoint is a planned future
addition. It would rewrap each row's `encryptedKey` rather than re-encrypt the
ciphertexts.

### Backups

Back up the postgres database **and** `/data/uploads/.master-key` (if you used
the auto-generated key) **and** the `IDENTITY_ATLAS_MASTER_KEY` env var (if you
set it explicitly). Without the master key, every secret in the vault is
unrecoverable.

### Disabling the feature

The Risk Scoring sub-tab has a feature toggle (the "Risk Scoring Feature" card).
Disabling it hides the Risk Scores main-nav tab and skips scoring during sync
runs. The LLM config and saved profiles/classifiers are preserved.

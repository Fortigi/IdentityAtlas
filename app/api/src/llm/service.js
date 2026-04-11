// Identity Atlas v5 — LLM service.
//
// Wraps the provider abstraction with config persistence. The flow is:
//   1. Admin saves the LLM config from the UI (provider + model + key + optional
//      endpoint/deployment for Azure). The api key goes through the secrets vault;
//      the rest is plain WorkerConfig JSON.
//   2. Anything that needs to call the LLM (risk profile generation, classifier
//      generation, conversational refinement) calls `chatWithSavedConfig({system, messages})`
//      which loads the config and dispatches via providers.js.
//
// One config is "active" at a time. Future work: per-feature configs (cheap model
// for chat refinement, big model for classifier generation) — the schema already
// supports it via the WorkerConfig key, just expose multiple slots in the UI.

import * as db from '../db/connection.js';
import { putSecret, getSecret, hasSecret, deleteSecret } from '../secrets/vault.js';
import { chat, SUPPORTED_PROVIDERS, DEFAULT_MODELS } from './providers.js';

const CONFIG_KEY    = 'LLM_CONFIG';
const SECRET_ID     = 'llm.apikey';
const SECRET_SCOPE  = 'llm';

// Load the saved LLM config (without the API key — that's separate). Returns
// null when nothing has been configured yet.
export async function getLLMConfig() {
  const r = await db.queryOne(
    `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
    [CONFIG_KEY]
  );
  if (!r) return null;
  try { return JSON.parse(r.configValue); }
  catch { return null; }
}

export async function isLLMConfigured() {
  const cfg = await getLLMConfig();
  if (!cfg || !cfg.provider) return false;
  return await hasSecret(SECRET_ID);
}

// Save the config. apiKey is encrypted into the secrets vault, the rest goes
// into WorkerConfig as JSON. Pass apiKey: null/undefined to update the config
// without touching the stored key (used when the user re-saves to change model
// without re-typing the secret).
export async function saveLLMConfig({ provider, model, endpoint, deployment, apiVersion, apiKey }) {
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const cfg = {
    provider,
    model:      model      || null,
    endpoint:   endpoint   || null,
    deployment: deployment || null,
    apiVersion: apiVersion || null,
    updatedAt:  new Date().toISOString(),
  };

  await db.query(
    `INSERT INTO "WorkerConfig" ("configKey", "configValue")
     VALUES ($1, $2)
     ON CONFLICT ("configKey") DO UPDATE
       SET "configValue" = EXCLUDED."configValue",
           "updatedAt"   = now() AT TIME ZONE 'utc'`,
    [CONFIG_KEY, JSON.stringify(cfg)]
  );

  if (apiKey) {
    await putSecret(SECRET_ID, SECRET_SCOPE, apiKey, `${provider} API key`);
  }
  return cfg;
}

export async function clearLLMConfig() {
  await db.query(`DELETE FROM "WorkerConfig" WHERE "configKey" = $1`, [CONFIG_KEY]);
  await deleteSecret(SECRET_ID);
}

// Return a config object ready to pass to providers.js `chat()`. Throws when
// nothing is configured. Internal — callers should use chatWithSavedConfig().
async function loadFullConfig() {
  const cfg = await getLLMConfig();
  if (!cfg) throw new Error('No LLM provider configured. Set one in Admin → LLM Settings.');
  const apiKey = await getSecret(SECRET_ID);
  if (!apiKey) throw new Error('LLM API key missing from secrets vault. Re-save the config.');
  return { ...cfg, apiKey };
}

// One-shot chat using the active config.
export async function chatWithSavedConfig(args) {
  const cfg = await loadFullConfig();
  return chat(cfg, args);
}

// Test the configuration with a tiny request. Used by the "Test" button in the
// admin UI. Returns { ok: true, model, latencyMs } or { ok: false, error }.
export async function testLLMConfig({ provider, model, endpoint, deployment, apiVersion, apiKey }) {
  try {
    const cfg = {
      provider,
      apiKey,
      model:      model      || DEFAULT_MODELS[provider] || null,
      endpoint:   endpoint   || null,
      deployment: deployment || null,
      apiVersion: apiVersion || null,
    };
    const start = Date.now();
    const r = await chat(cfg, {
      system: 'You are a connectivity test. Reply with the single word OK.',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
      temperature: 0,
    });
    return { ok: true, model: r.model, latencyMs: Date.now() - start, sample: r.text.slice(0, 80) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export { SUPPORTED_PROVIDERS, DEFAULT_MODELS };

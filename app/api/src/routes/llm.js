// Identity Atlas v5 — LLM admin routes.
//
// Surface for the Admin → LLM Settings page. CRUD on the active LLM config and
// a test endpoint that runs a tiny chat call to verify credentials. The API key
// itself never leaves the server — the GET endpoint reports `apiKeySet: true|false`
// without exposing the secret.
//
// All endpoints are admin-only via the standard auth middleware applied at the
// router-mount level (see index.js).

import { Router } from 'express';
import {
  getLLMConfig,
  saveLLMConfig,
  clearLLMConfig,
  testLLMConfig,
  isLLMConfigured,
  listModelsForConfig,
  SUPPORTED_PROVIDERS,
  DEFAULT_MODELS,
} from '../llm/service.js';
import { hasSecret } from '../secrets/vault.js';

const router = Router();

// GET /api/admin/llm/config — current settings (no API key)
router.get('/admin/llm/config', async (_req, res) => {
  try {
    const cfg = await getLLMConfig();
    const apiKeySet = await hasSecret('llm.apikey');
    res.json({
      providers: SUPPORTED_PROVIDERS,
      defaultModels: DEFAULT_MODELS,
      config: cfg,
      apiKeySet,
      configured: !!(cfg && apiKeySet),
    });
  } catch (err) {
    console.error('GET /admin/llm/config failed:', err.message);
    res.status(500).json({ error: 'Failed to load LLM config' });
  }
});

// PUT /api/admin/llm/config — replace settings
//
// body: { provider, model?, endpoint?, deployment?, apiVersion?, apiKey? }
// apiKey is optional — omit to update other fields without re-typing the secret.
router.put('/admin/llm/config', async (req, res) => {
  try {
    const { provider, model, endpoint, deployment, apiVersion, apiKey } = req.body || {};
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}` });
    }
    if (provider === 'azure-openai') {
      if (!endpoint)   return res.status(400).json({ error: 'azure-openai requires an endpoint' });
      if (!deployment) return res.status(400).json({ error: 'azure-openai requires a deployment name' });
    }
    const saved = await saveLLMConfig({ provider, model, endpoint, deployment, apiVersion, apiKey });
    res.json({ ok: true, config: saved });
  } catch (err) {
    console.error('PUT /admin/llm/config failed:', err.message);
    res.status(500).json({ error: err.message || 'Failed to save LLM config' });
  }
});

// DELETE /api/admin/llm/config — wipe both the config and the API key
router.delete('/admin/llm/config', async (_req, res) => {
  try {
    await clearLLMConfig();
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /admin/llm/config failed:', err.message);
    res.status(500).json({ error: 'Failed to clear LLM config' });
  }
});

// POST /api/admin/llm/test — try a one-shot ping with the supplied (or saved) config
//
// If the body includes an apiKey, the test uses that without saving. Otherwise it
// loads the saved config from the database. This lets the UI run "Test" before
// the user clicks Save.
router.post('/admin/llm/test', async (req, res) => {
  try {
    let { provider, model, endpoint, deployment, apiVersion, apiKey } = req.body || {};

    // If no key was supplied, load the saved one (test the live config)
    if (!apiKey) {
      const saved = await getLLMConfig();
      if (!saved) return res.status(400).json({ ok: false, error: 'No saved config and no apiKey provided' });
      const { getSecret } = await import('../secrets/vault.js');
      apiKey = await getSecret('llm.apikey');
      if (!apiKey) return res.status(400).json({ ok: false, error: 'API key not in vault — re-save the config' });
      provider   = provider   || saved.provider;
      model      = model      || saved.model;
      endpoint   = endpoint   || saved.endpoint;
      deployment = deployment || saved.deployment;
      apiVersion = apiVersion || saved.apiVersion;
    }
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      return res.status(400).json({ ok: false, error: `Unknown provider: ${provider}` });
    }
    const result = await testLLMConfig({ provider, model, endpoint, deployment, apiVersion, apiKey });
    res.json(result);
  } catch (err) {
    console.error('POST /admin/llm/test failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/llm/models — discover available models for the given
// provider + credentials. If the body omits `apiKey`, the saved vault key is
// used (so the user can refresh the list after saving). Returns
// `{ ok: true, models: [{id, label}] }` or `{ ok: false, error }`.
//
// Used by the LLM Settings page to populate the model dropdown instead of
// making the user type the exact model ID.
router.post('/admin/llm/models', async (req, res) => {
  try {
    const { provider, apiKey, endpoint, apiVersion } = req.body || {};
    if (!provider || !SUPPORTED_PROVIDERS.includes(provider)) {
      return res.status(400).json({ ok: false, error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}` });
    }
    const result = await listModelsForConfig({ provider, apiKey, endpoint, apiVersion });
    res.json(result);
  } catch (err) {
    console.error('POST /admin/llm/models failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/llm/status — quick "is it configured at all" probe used by the
// Risk Profile wizard to gate its UI without exposing the config details.
router.get('/admin/llm/status', async (_req, res) => {
  try {
    const configured = await isLLMConfigured();
    res.json({ configured });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

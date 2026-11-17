// Unit tests for routes/llm.js — provider/config validation. Service + vault mocked.

import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

// Risk scoring is an experimental flag (off on a fresh install); these tests
// exercise the feature itself, so it starts on. Its OFF behaviour is asserted below.
const flags = vi.hoisted(() => ({ riskScoring: true }));
vi.mock('../featureFlags.js', async (orig) =>
  (await import('../../test-utils/featureFlagMock.js')).steeredFeatureFlags(await orig(), flags));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
vi.mock('../llm/service.js', () => ({
  SUPPORTED_PROVIDERS: ['openai', 'azure-openai', 'anthropic'],
  DEFAULT_MODELS: {},
  getLLMConfig: vi.fn(), saveLLMConfig: vi.fn(), clearLLMConfig: vi.fn(),
  testLLMConfig: vi.fn(), isLLMConfigured: vi.fn(), listModelsForConfig: vi.fn(),
}));
vi.mock('../secrets/vault.js', () => ({ hasSecret: vi.fn(), getSecret: vi.fn() }));

const { default: router } = await import('./llm.js');
const vault = await import('../secrets/vault.js');
const service = await import('../llm/service.js');
const app = mountRouter(router);

describe('PUT /admin/llm/config — validation', () => {
  it('400 on an unsupported provider', async () => {
    const res = await request(app).put('/api/admin/llm/config').send({ provider: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400 when azure-openai is missing its endpoint', async () => {
    const res = await request(app).put('/api/admin/llm/config').send({ provider: 'azure-openai' });
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/llm/test — validation', () => {
  it('400 on an unknown provider', async () => {
    const res = await request(app).post('/api/admin/llm/test').send({ provider: 'nope' });
    expect(res.status).toBe(400);
  });
});

// SEC-2026-09 H-01: the LLM key is addressed through its own vault scope.
describe('LLM key lookups use the llm vault scope', () => {
  it('GET /admin/llm/config checks the key in the llm scope', async () => {
    service.getLLMConfig.mockResolvedValueOnce({ provider: 'openai' });
    vault.hasSecret.mockResolvedValueOnce(true);
    const res = await request(app).get('/api/admin/llm/config');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(vault.hasSecret).toHaveBeenCalledWith('llm.apikey', 'llm');
  });

  it('POST /admin/llm/test without a key loads the saved key from the llm scope', async () => {
    service.getLLMConfig.mockResolvedValueOnce({ provider: 'openai', model: 'm' });
    vault.getSecret.mockResolvedValueOnce(null);
    const res = await request(app).post('/api/admin/llm/test').send({});
    expect(res.status).toBe(400);
    expect(vault.getSecret).toHaveBeenCalledWith('llm.apikey', 'llm');
  });
});

// The provider configured here is used only by risk scoring, so while that
// experimental flag is off this page does not exist: every endpoint 404s before
// the config, the provider or the key vault is touched.
describe('with the riskScoring flag off', () => {
  afterEach(() => { flags.riskScoring = true; vi.clearAllMocks(); });
  const calls = [
    ['GET config', a => request(a).get('/api/admin/llm/config')],
    ['PUT config', a => request(a).put('/api/admin/llm/config').send({ provider: 'openai', model: 'm', apiKey: 'k' })],
    ['DELETE config', a => request(a).delete('/api/admin/llm/config')],
    ['POST test', a => request(a).post('/api/admin/llm/test').send({ provider: 'openai', apiKey: 'k' })],
    ['POST models', a => request(a).post('/api/admin/llm/models').send({ provider: 'openai', apiKey: 'k' })],
    ['GET status', a => request(a).get('/api/admin/llm/status')],
  ];

  it.each(calls)('%s answers 404 without touching the provider or the vault', async (_name, call) => {
    vi.clearAllMocks();
    flags.riskScoring = false;
    const res = await call(app);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'This feature is not enabled' });
    for (const fn of [service.getLLMConfig, service.saveLLMConfig, service.clearLLMConfig, service.testLLMConfig,
      service.isLLMConfigured, service.listModelsForConfig, vault.hasSecret, vault.getSecret]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('the same status probe answers once the flag is on', async () => {
    service.isLLMConfigured.mockResolvedValueOnce(true);
    const res = await request(app).get('/api/admin/llm/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true });
  });

  it('gates only /admin/llm, not the rest of the shared /api mount', async () => {
    flags.riskScoring = false;
    const a = mountRouter(router);
    a.get('/api/admin/other', (_req, res) => res.json({ ok: true }));
    const res = await request(a).get('/api/admin/other');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

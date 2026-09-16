// Unit tests for routes/llm.js — provider/config validation. Service + vault mocked.

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

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

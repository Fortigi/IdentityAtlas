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
vi.mock('../secrets/vault.js', () => ({ hasSecret: vi.fn() }));

const { default: router } = await import('./llm.js');
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

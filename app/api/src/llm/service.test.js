// Unit tests for the LLM service layer — focused on M-2 (don't leak upstream
// provider error bodies to the client). db, vault, and the provider dispatcher
// are mocked so these run offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockChat, mockListModels } = vi.hoisted(() => ({ mockChat: vi.fn(), mockListModels: vi.fn() }));

vi.mock('../db/connection.js', () => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../secrets/vault.js', () => ({
  putSecret: vi.fn(), getSecret: vi.fn(), hasSecret: vi.fn(), deleteSecret: vi.fn(),
}));
vi.mock('./providers.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, chat: mockChat, listModels: mockListModels };
});

const { testLLMConfig } = await import('./service.js');

beforeEach(() => {
  mockChat.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('testLLMConfig — client-safe errors (M-2)', () => {
  it('strips the raw upstream body from a provider error, keeping provider + status', async () => {
    mockChat.mockRejectedValueOnce(
      new Error('Anthropic API error 401: {"error":{"message":"invalid x-api-key sk-leakedsecret"}}')
    );
    const r = await testLLMConfig({ provider: 'anthropic', apiKey: 'k' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Anthropic API error 401');
    expect(r.error).not.toMatch(/sk-leakedsecret|invalid x-api-key/);
  });

  it('passes our own (non-upstream) error messages through unchanged', async () => {
    mockChat.mockRejectedValueOnce(new Error('LLM request timed out after 120s'));
    const r = await testLLMConfig({ provider: 'openai', apiKey: 'k' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('LLM request timed out after 120s');
  });

  it('returns ok:true with the model on success', async () => {
    mockChat.mockResolvedValueOnce({ text: 'OK', model: 'claude-x', usage: null });
    const r = await testLLMConfig({ provider: 'anthropic', apiKey: 'k' });
    expect(r.ok).toBe(true);
    expect(r.model).toBe('claude-x');
  });
});

// Unit tests for the LLM provider dispatcher.
//
// We mock global fetch and assert each provider's adapter calls the right URL,
// uses the right headers, and parses the response shape correctly. Real network
// calls are intentionally avoided so the test suite stays fast and runs offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chat, SUPPORTED_PROVIDERS, DEFAULT_MODELS } from './providers.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(responseJson, { ok = true, status = 200 } = {}) {
  global.fetch = vi.fn(async () => ({
    ok,
    status,
    json: async () => responseJson,
    text: async () => JSON.stringify(responseJson),
  }));
}

describe('SUPPORTED_PROVIDERS', () => {
  it('exposes all three providers', () => {
    expect(SUPPORTED_PROVIDERS).toEqual(['anthropic', 'openai', 'azure-openai']);
  });
  it('exposes default models for cloud providers', () => {
    expect(DEFAULT_MODELS.anthropic).toMatch(/claude/);
    expect(DEFAULT_MODELS.openai).toMatch(/gpt/);
  });
});

describe('chat: anthropic', () => {
  it('hits the messages endpoint with x-api-key and parses the text content', async () => {
    mockFetch({
      content: [{ type: 'text', text: 'hello world' }],
      model: 'claude-3-5-sonnet',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const result = await chat(
      { provider: 'anthropic', apiKey: 'sk-test' },
      { system: 'be helpful', messages: [{ role: 'user', content: 'hi' }] }
    );
    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-test');
    expect(init.headers['anthropic-version']).toBeDefined();
    const body = JSON.parse(init.body);
    expect(body.system).toBe('be helpful');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('hello world');
    expect(result.usage.inputTokens).toBe(10);
  });

  it('throws on non-2xx', async () => {
    mockFetch({ error: 'bad' }, { ok: false, status: 401 });
    await expect(
      chat({ provider: 'anthropic', apiKey: 'k' }, { system: 's', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/Anthropic API error 401/);
  });
});

describe('chat: openai', () => {
  it('hits chat/completions with bearer auth and embeds system in messages', async () => {
    mockFetch({
      choices: [{ message: { content: 'pong' } }],
      model: 'gpt-4o',
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const result = await chat(
      { provider: 'openai', apiKey: 'sk-x' },
      { system: 'sys', messages: [{ role: 'user', content: 'ping' }] }
    );
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers['authorization']).toBe('Bearer sk-x');
    const body = JSON.parse(init.body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'ping' });
    expect(result.text).toBe('pong');
    expect(result.usage.outputTokens).toBe(3);
  });
});

describe('chat: azure-openai', () => {
  it('builds the deployment URL and uses api-key header', async () => {
    mockFetch({
      choices: [{ message: { content: 'azure ok' } }],
      model: 'gpt-4o',
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const result = await chat(
      {
        provider: 'azure-openai',
        apiKey: 'azkey',
        endpoint: 'https://my.openai.azure.com/',
        deployment: 'gpt-4o-prod',
        apiVersion: '2024-08-01-preview',
      },
      { system: 'sys', messages: [{ role: 'user', content: 'hi' }] }
    );
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('https://my.openai.azure.com/openai/deployments/gpt-4o-prod/chat/completions');
    expect(url).toContain('api-version=2024-08-01-preview');
    expect(init.headers['api-key']).toBe('azkey');
    expect(result.text).toBe('azure ok');
  });

  it('rejects when endpoint or deployment is missing', async () => {
    await expect(
      chat({ provider: 'azure-openai', apiKey: 'k' }, { system: '', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/endpoint is required/);
    await expect(
      chat({ provider: 'azure-openai', apiKey: 'k', endpoint: 'https://x' }, { system: '', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/deployment is required/);
  });
});

describe('chat dispatch errors', () => {
  it('rejects an unknown provider', async () => {
    await expect(
      chat({ provider: 'gemini', apiKey: 'k' }, { system: '', messages: [] })
    ).rejects.toThrow(/Unknown LLM provider/);
  });
  it('rejects missing config', async () => {
    await expect(chat(null, {})).rejects.toThrow(/missing provider/);
    await expect(chat({ provider: 'openai' }, {})).rejects.toThrow(/missing apiKey/);
  });
});

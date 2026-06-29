// Unit tests for the LLM provider dispatcher.
//
// We mock global fetch and assert each provider's adapter calls the right URL,
// uses the right headers, and parses the response shape correctly. Real network
// calls are intentionally avoided so the test suite stays fast and runs offline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chat, llmFetch, SUPPORTED_PROVIDERS, DEFAULT_MODELS } from './providers.js';

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
      chat({ provider: 'azure-openai', apiKey: 'k', endpoint: 'https://myresource.openai.azure.com' }, { system: '', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow(/deployment is required/);
  });
});

// M-1 — every outbound provider call goes through llmFetch, which bounds the
// call with an AbortController timeout and caps the response body size.
describe('llmFetch hardening (M-1)', () => {
  it('passes an AbortSignal so the call is time-bounded, and returns {ok,status,bodyText}', async () => {
    let sawSignal = false;
    global.fetch = vi.fn(async (_url, opts) => {
      sawSignal = opts.signal instanceof AbortSignal;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"x":1}' };
    });
    const r = await llmFetch('https://api.example/v1');
    expect(sawSignal).toBe(true);
    expect(r).toEqual({ ok: true, status: 200, bodyText: '{"x":1}' });
  });

  it('maps an AbortError (timeout) to a clear "timed out" error, not the raw abort', async () => {
    global.fetch = vi.fn(async () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      throw e;
    });
    await expect(llmFetch('https://api.example/v1')).rejects.toThrow(/timed out/i);
  });

  it('rejects a response whose Content-Length exceeds the cap (no unbounded read)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k) => (k === 'content-length' ? String(64 * 1024 * 1024) : null) },
      text: async () => 'should-not-be-read',
    }));
    await expect(llmFetch('https://api.example/v1')).rejects.toThrow(/too large/i);
  });
});

// M-3 — llmFetch must never auto-follow a redirect (a 3xx to an internal host
// would carry the provider api-key with it).
describe('llmFetch redirect refusal (M-3 SSRF)', () => {
  it('refuses an opaque redirect instead of following it', async () => {
    global.fetch = vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0, headers: { get: () => null }, text: async () => '' }));
    await expect(llmFetch('https://api.example/v1')).rejects.toThrow(/redirect/i);
  });
  it('refuses a 3xx redirect status', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 302, headers: { get: () => null }, text: async () => '' }));
    await expect(llmFetch('https://api.example/v1')).rejects.toThrow(/redirect/i);
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

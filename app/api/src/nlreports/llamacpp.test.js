import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';

// A local HTTP server plays llama-server, recording what the client sends.
let server;
let port;
let calls;
let routes;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      calls.push({ method: req.method, url: req.url, body: parsed });
      const route = routes[`${req.method} ${req.url}`];
      const [status, payload] = route ? route(parsed) : [404, { error: { message: 'no route' } }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => new Promise(r => server.close(r)));

beforeEach(() => {
  calls = [];
  routes = {
    'GET /v1/models': () => [200, { data: [{ id: 'qwen3-4b-instruct' }] }],
    'GET /props': () => [200, {
      model_alias: 'qwen3-4b-instruct', model_path: '/models/model.gguf',
      model_ftype: 'Q4_K_M', build_info: 'b10975', chat_template: '{{ jinja }}',
    }],
    'POST /v1/chat/completions': () => [200, {
      choices: [{ message: { content: '{"kind":"report"}' } }],
      timings: { prompt_n: 15, cache_n: 4193, prompt_ms: 3900.4, predicted_n: 125, predicted_ms: 49800.6 },
    }],
  };
});

async function client() {
  vi.resetModules();
  process.env.NL_REPORTS_LLM_URL = `http://127.0.0.1:${port}`;
  return import('./llamacpp.js');
}

describe('llama.cpp client', () => {
  it('asks for schema-constrained output and reports how much of the prompt came from the cache', async () => {
    const { chat } = await client();
    const r = await chat({ messages: [{ role: 'user', content: 'q' }], schema: { type: 'object' } });
    expect(calls[0].body).toEqual({
      messages: [{ role: 'user', content: 'q' }], temperature: 0, max_tokens: 1200, cache_prompt: true,
      response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } },
    });
    expect(r).toEqual({
      content: '{"kind":"report"}',
      timing: { totalMs: 53701, loadMs: 0, promptTokens: 15, cachedTokens: 4193, promptMs: 3900, outputTokens: 125, outputMs: 49801 },
    });
  });

  it('warm-up restores a saved prompt cache without reading the prompt again', async () => {
    routes['POST /slots/0?action=restore'] = () => [200, { n_restored: 4200 }];
    const { warm, cacheFileName } = await client();
    const r = await warm('ignored', 'SYSTEM PROMPT');
    expect(r).toMatchObject({ model: 'qwen3-4b-instruct', restored: true });
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['GET /v1/models', 'GET /props', 'POST /slots/0?action=restore']);
    // Keyed on what the server is actually running, not just the model's name.
    expect(calls.at(-1).body.filename).toBe(cacheFileName(
      ['qwen3-4b-instruct', '/models/model.gguf', 'Q4_K_M', 'b10975', '{{ jinja }}'].join('\u0000'),
      'SYSTEM PROMPT',
    ));
  });

  it('warm-up reads the prompt once and saves it when there is no usable cache', async () => {
    routes['POST /slots/0?action=restore'] = () => [400, { error: { message: 'failed to open file' } }];
    routes['POST /slots/0?action=save'] = () => [200, { n_saved: 4200 }];
    const { warm } = await client();
    const r = await warm('ignored', 'SYSTEM PROMPT');
    expect(r.restored).toBe(false);
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/models', 'GET /props', 'POST /slots/0?action=restore', 'POST /v1/chat/completions', 'POST /slots/0?action=save',
    ]);
    expect(calls[3].body).toMatchObject({ max_tokens: 1, messages: [{ role: 'system', content: 'SYSTEM PROMPT' }, { role: 'user', content: 'ready?' }] });
    expect(calls[3].body).not.toHaveProperty('response_format');
    expect(calls[4].body).toEqual(calls[2].body); // saved under the name the next restore will look for
  });

  it('gives every server + model + prompt combination its own cache file', async () => {
    const { cacheFileName, serverFingerprint } = await client();
    const a = cacheFileName('m1', 'prompt');
    expect(a).toMatch(/^prompt-[0-9a-f]{24}\.bin$/);
    expect(cacheFileName('m1', 'prompt')).toBe(a);
    expect(cacheFileName('m2', 'prompt')).not.toBe(a);
    expect(cacheFileName('m1', 'prompt changed')).not.toBe(a);

    // A server upgrade, a different quantisation or a changed chat template all
    // change the fingerprint, so none of them can reuse another's cache.
    const base = await serverFingerprint();
    routes['GET /props'] = () => [200, {
      model_alias: 'qwen3-4b-instruct', model_path: '/models/model.gguf',
      model_ftype: 'Q4_K_M', build_info: 'b11000', chat_template: '{{ jinja }}',
    }];
    expect(await serverFingerprint()).not.toBe(base);
  });

  it('reads from the supervisor whether the model is in memory, without waking it', async () => {
    const { listModels, modelState } = await client();
    // Plain llama-server: no loaded flag, no model state — it is loaded, it is ready.
    routes['GET /health'] = () => [200, { status: 'ok' }];
    expect(await listModels()).toEqual([{ name: 'qwen3-4b-instruct', loaded: true }]);
    expect(await modelState()).toBe('ready');

    // The supervisor, with the model unloaded, then starting.
    routes['GET /v1/models'] = () => [200, { data: [{ id: 'qwen3-4b-instruct', loaded: false, state: 'unloaded' }] }];
    routes['GET /health'] = () => [200, { status: 'ok', model: 'unloaded' }];
    expect(await listModels()).toEqual([{ name: 'qwen3-4b-instruct', loaded: false }]);
    expect(await modelState()).toBe('unloaded');
    routes['GET /health'] = () => [200, { status: 'ok', model: 'starting' }];
    expect(await modelState()).toBe('starting');
    // Neither question may reach anything that loads the model.
    expect(calls.map(c => c.url)).not.toContain('/props');

    // An unrecognised answer is not trusted as a state.
    routes['GET /health'] = () => [200, { status: 'ok', model: 'exploded' }];
    expect(await modelState()).toBe('ready');
  });

  it('surfaces server errors and a server without a model', async () => {
    routes['POST /v1/chat/completions'] = () => [500, { error: { message: 'context size exceeded' } }];
    routes['GET /v1/models'] = () => [200, { data: [] }];
    const { chat, listModels } = await client();
    await expect(chat({ messages: [] })).rejects.toThrow('LLM server returned 500: context size exceeded');
    await expect(listModels()).rejects.toThrow('reports no model');
  });
});

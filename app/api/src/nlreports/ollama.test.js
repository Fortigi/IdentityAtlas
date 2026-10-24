import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';

// A real local HTTP server stands in for the model server, so the client's
// transport (status handling, JSON parsing, timeouts) is exercised end to end.
let server;
let port;
let handler = () => {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(() => new Promise(r => server.close(r)));

async function client(timeoutMs) {
  vi.resetModules();
  process.env.NL_REPORTS_LLM_URL = `http://127.0.0.1:${port}`;
  if (timeoutMs) process.env.NL_REPORTS_LLM_TIMEOUT_MS = String(timeoutMs);
  else delete process.env.NL_REPORTS_LLM_TIMEOUT_MS;
  return import('./ollama.js');
}

describe('model server client', () => {
  it('waits for a slow answer that arrives in one piece, and reports the timings', async () => {
    handler = (req, res, body) => {
      const sent = JSON.parse(body);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: { content: `{"model":"${sent.model}","think":${sent.think}}` },
          total_duration: 2_500_000_000, load_duration: 1e6, prompt_eval_count: 3000, prompt_eval_duration: 2e9, eval_count: 80, eval_duration: 5e8,
        }));
      }, 150);
    };
    const { chat } = await client();
    const r = await chat({ model: 'qwen3:4b-instruct', messages: [], schema: {} });
    expect(JSON.parse(r.content)).toEqual({ model: 'qwen3:4b-instruct', think: false });
    expect(r.timing).toEqual({ totalMs: 2500, loadMs: 1, promptTokens: 3000, promptMs: 2000, outputTokens: 80, outputMs: 500 });
  });

  it('turns an error status into an error that carries the server message', async () => {
    handler = (req, res) => { res.writeHead(404); res.end('model "nope" not found'); };
    const { chat } = await client();
    await expect(chat({ model: 'nope', messages: [], schema: {} })).rejects.toThrow('LLM server returned 404: model "nope" not found');
  });

  it('gives up after its own timeout, not before', async () => {
    handler = () => {}; // never answers
    const { listModels } = await client(200);
    const started = Date.now();
    await expect(listModels()).rejects.toThrow(/timed out after 0.2s/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('rejects a body that is not JSON', async () => {
    handler = (req, res) => { res.writeHead(200); res.end('<html>proxy error</html>'); };
    const { warm } = await client();
    await expect(warm('m', 'system')).rejects.toThrow('invalid JSON');
  });
});

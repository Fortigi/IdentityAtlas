// Natural-language reports (PROTOTYPE) — minimal Ollama client.
//
// Uses Ollama's native API rather than its OpenAI-compatible one because the
// prototype needs three things only the native API exposes: a JSON schema as a
// decoding grammar (`format`), per-request timings (load / prompt / output) for
// measuring whether a CPU-only model is fast enough, and model listing/warm-up.
// A production version would sit behind the shared provider abstraction.

import http from 'node:http';
import https from 'node:https';

const BASE_URL = (process.env.NL_REPORTS_LLM_URL || 'http://llm:11434').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.NL_REPORTS_LLM_TIMEOUT_MS) || 900_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MODEL = process.env.NL_REPORTS_DEFAULT_MODEL || 'qwen2.5-coder:7b';
const KEEP_ALIVE = process.env.NL_REPORTS_KEEP_ALIVE || '10m';

const THINKING_MODEL = /^(qwen3|deepseek-r1|gpt-oss)/i;

// node:http rather than fetch(): fetch gives up when response headers take longer
// than 5 minutes, and a non-streaming model call only answers once it has read the
// whole prompt — which on a cold 2-CPU start takes longer than that. Our own
// timeout (TIMEOUT_MS) is the only limit. Redirects are never followed.
function call(path, body, method = 'POST') {
  const url = new URL(`${BASE_URL}${path}`);
  const payload = body ? JSON.stringify(body) : null;
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error('LLM response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`LLM server returned ${res.statusCode}: ${text.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch { reject(new Error('LLM server returned invalid JSON')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`LLM request timed out after ${TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ms = (ns) => Math.round((ns || 0) / 1e6);

/**
 * @returns {Promise<{ content: string, timing: object }>}
 */
export async function chat({ model, messages, schema }) {
  const body = {
    model,
    messages,
    stream: false,
    format: schema,
    keep_alive: KEEP_ALIVE,
    options: { temperature: 0, num_ctx: 8192, num_predict: 1200 },
  };
  if (THINKING_MODEL.test(model)) body.think = false;
  const r = await call('/api/chat', body);
  return {
    content: r.message?.content ?? '',
    timing: {
      totalMs: ms(r.total_duration),
      loadMs: ms(r.load_duration),
      promptTokens: r.prompt_eval_count ?? 0,
      promptMs: ms(r.prompt_eval_duration),
      outputTokens: r.eval_count ?? 0,
      outputMs: ms(r.eval_duration),
    },
  };
}

export async function listModels() {
  const [tags, ps] = await Promise.all([call('/api/tags', null, 'GET'), call('/api/ps', null, 'GET')]);
  const loaded = new Set((ps.models || []).map(m => m.name));
  return (tags.models || [])
    .map(m => ({ name: m.name, sizeBytes: m.size, parameterSize: m.details?.parameter_size, quantization: m.details?.quantization_level, loaded: loaded.has(m.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load a model and pre-process the system prompt, so the first real question
 * only pays for its own tokens. On CPU, reading a ~2k-token prompt is the slow
 * part (minutes on a small shared VM); the server keeps it in its prompt cache.
 */
export async function warm(model, systemPrompt) {
  const started = Date.now();
  const body = {
    model,
    stream: false,
    keep_alive: KEEP_ALIVE,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'ready?' }],
    options: { temperature: 0, num_ctx: 8192, num_predict: 1 },
  };
  if (THINKING_MODEL.test(model)) body.think = false;
  await call('/api/chat', body);
  return { model, ms: Date.now() - started };
}

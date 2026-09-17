// Natural-language reports (PROTOTYPE) — minimal Ollama client.
//
// Uses Ollama's native API rather than its OpenAI-compatible one because the
// prototype needs three things only the native API exposes: a JSON schema as a
// decoding grammar (`format`), per-request timings (load / prompt / output) for
// measuring whether a CPU-only model is fast enough, and model listing/warm-up.
// A production version would sit behind the shared provider abstraction.

import { httpJson } from '../lib/httpJson.js';

const BASE_URL = (process.env.NL_REPORTS_LLM_URL || 'http://llm:11434').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.NL_REPORTS_LLM_TIMEOUT_MS) || 900_000;
export const DEFAULT_MODEL = process.env.NL_REPORTS_DEFAULT_MODEL || 'qwen2.5-coder:7b';
const KEEP_ALIVE = process.env.NL_REPORTS_KEEP_ALIVE || '10m';

const THINKING_MODEL = /^(qwen3|deepseek-r1|gpt-oss)/i;

async function call(path, body, method = 'POST') {
  const { status, json, text } = await httpJson({ url: `${BASE_URL}${path}`, method, body: body ?? undefined, timeoutMs: TIMEOUT_MS });
  if (status < 200 || status >= 300) throw new Error(`LLM server returned ${status}: ${text.slice(0, 300)}`);
  if (!json) throw new Error('LLM server returned invalid JSON');
  return json;
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

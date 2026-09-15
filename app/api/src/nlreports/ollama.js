// Natural-language reports (PROTOTYPE) — minimal Ollama client.
//
// Uses Ollama's native API rather than its OpenAI-compatible one because the
// prototype needs three things only the native API exposes: a JSON schema as a
// decoding grammar (`format`), per-request timings (load / prompt / output) for
// measuring whether a CPU-only model is fast enough, and model listing/warm-up.
// A production version would sit behind the shared provider abstraction.

const BASE_URL = (process.env.NL_REPORTS_LLM_URL || 'http://llm:11434').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.NL_REPORTS_LLM_TIMEOUT_MS) || 300_000;
export const DEFAULT_MODEL = process.env.NL_REPORTS_DEFAULT_MODEL || 'qwen2.5-coder:7b';
const KEEP_ALIVE = process.env.NL_REPORTS_KEEP_ALIVE || '10m';

const THINKING_MODEL = /^(qwen3|deepseek-r1|gpt-oss)/i;

async function call(path, body, method = 'POST') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`LLM server returned ${resp.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`LLM request timed out after ${TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
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

/** Load a model into memory without generating anything. */
export async function warm(model) {
  const started = Date.now();
  await call('/api/generate', { model, prompt: '', keep_alive: KEEP_ALIVE });
  return { model, ms: Date.now() - started };
}

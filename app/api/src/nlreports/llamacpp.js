// Natural-language reports (PROTOTYPE) — llama.cpp server client.
//
// The report generator runs ONE model, chosen per release and started by the
// deployment (llama-server -m <model.gguf> --alias <name>). There is nothing to
// pick at runtime.
//
// Cold start: the fixed system prompt (~4k tokens) is the expensive part — reading
// it takes minutes on a small CPU box. llama-server can save a slot's processed
// prompt (its KV cache) to disk and restore it in well under a second, so warm():
//
//   1. restores the saved prompt cache for this exact model + prompt, when present
//   2. otherwise reads the prompt once and saves the cache for next time
//
// The cache file name is a hash of model name + prompt text, so any change to
// either (new release, new catalog values) automatically gets a fresh cache.

import { createHash } from 'node:crypto';
import { httpJson } from '../lib/httpJson.js';

const BASE_URL = (process.env.NL_REPORTS_LLM_URL || 'http://llm:8080').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.NL_REPORTS_LLM_TIMEOUT_MS) || 900_000;
// Set where the model server is reachable over a network the deployment does not
// control (Azure: no VNet, so the Container App has public ingress).
const API_KEY = process.env.NL_REPORTS_LLM_API_KEY || '';
const SLOT = 0;

const call = (method, path, body) => httpJson({
  url: `${BASE_URL}${path}`,
  method,
  body,
  headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  timeoutMs: TIMEOUT_MS,
});

async function ok(method, path, body) {
  const r = await call(method, path, body);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`LLM server returned ${r.status}: ${(r.json?.error?.message || r.text).slice(0, 300)}`);
  }
  if (!r.json) throw new Error('LLM server returned invalid JSON');
  return r.json;
}

/** The model the server was started with (its --alias). */
export async function servedModel() {
  const j = await ok('GET', '/v1/models');
  const m = (j.data || j.models || [])[0];
  if (!m) throw new Error('LLM server reports no model');
  return m.id || m.name || m.model;
}

export async function listModels() {
  const name = await servedModel();
  return [{ name, loaded: true }];
}

export function cacheFileName(model, systemPrompt) {
  return `prompt-${createHash('sha256').update(`${model}\n${systemPrompt}`).digest('hex').slice(0, 24)}.bin`;
}

function completionBody(messages, { schema, maxTokens }) {
  const body = { messages, temperature: 0, max_tokens: maxTokens, cache_prompt: true };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { schema } };
  return body;
}

/**
 * @returns {Promise<{ content: string, timing: object }>}
 */
export async function chat({ messages, schema }) {
  const j = await ok('POST', '/v1/chat/completions', completionBody(messages, { schema, maxTokens: 1200 }));
  const t = j.timings || {};
  return {
    content: j.choices?.[0]?.message?.content ?? '',
    timing: {
      totalMs: Math.round((t.prompt_ms || 0) + (t.predicted_ms || 0)),
      loadMs: 0,
      promptTokens: t.prompt_n ?? 0,     // tokens actually read — small when the prompt came from the cache
      cachedTokens: t.cache_n ?? 0,
      promptMs: Math.round(t.prompt_ms || 0),
      outputTokens: t.predicted_n ?? 0,
      outputMs: Math.round(t.predicted_ms || 0),
    },
  };
}

/**
 * Make the next question fast: restore the processed system prompt, or read it once and save it.
 * @returns {Promise<{ model: string, ms: number, restored: boolean }>}
 */
export async function warm(_model, systemPrompt) {
  const started = Date.now();
  const model = await servedModel();
  const filename = cacheFileName(model, systemPrompt);

  const restore = await call('POST', `/slots/${SLOT}?action=restore`, { filename });
  if (restore.status === 200) return { model, ms: Date.now() - started, restored: true };

  await ok('POST', '/v1/chat/completions', completionBody(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'ready?' }],
    { maxTokens: 1 },
  ));
  await ok('POST', `/slots/${SLOT}?action=save`, { filename });
  return { model, ms: Date.now() - started, restored: false };
}

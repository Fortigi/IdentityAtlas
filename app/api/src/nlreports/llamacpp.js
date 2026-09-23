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

async function firstModel() {
  const j = await ok('GET', '/v1/models');
  const m = (j.data || j.models || [])[0];
  if (!m) throw new Error('LLM server reports no model');
  return m;
}

/** The model the server was started with (its --alias). */
export async function servedModel() {
  const m = await firstModel();
  return m.id || m.name || m.model;
}

/**
 * The model, and whether it is in memory right now. The report generator's
 * supervisor answers this without loading the model and says `loaded: false` while
 * it is unloaded; a plain llama-server does not say, and is loaded by definition.
 */
export async function listModels() {
  const m = await firstModel();
  return [{ name: m.id || m.name || m.model, loaded: m.loaded !== false }];
}

/**
 * 'unloaded' | 'starting' | 'ready', from the supervisor's /health — which never
 * wakes the model. A server that does not report it (plain llama-server) is 'ready'.
 */
export async function modelState() {
  const r = await call('GET', '/health');
  const state = r.json?.model;
  return ['unloaded', 'starting', 'ready'].includes(state) ? state : 'ready';
}

/**
 * What the server is running, as far as it will tell us: model alias, model file
 * path and quantisation, its own build, and the chat template. All of it changes
 * the meaning of a saved prompt cache, so all of it keys the cache file name.
 */
export async function serverFingerprint() {
  const p = await ok('GET', '/props');
  return [p.model_alias, p.model_path, p.model_ftype, p.build_info, p.chat_template]
    .map(v => String(v ?? '')).join('\u0000');
}

/**
 * A saved prompt cache is only valid for the exact server, model and prompt that
 * produced it — restoring one written by a different model would answer from the
 * wrong weights without saying so. Everything that identifies those goes into the
 * name, so a mismatch simply misses and the prompt is read once more.
 *
 * NOTE for whoever changes the model: give it a new `--alias` as well. The alias
 * is the part of this key that tells two model FILES apart, because the server
 * exposes no checksum of the weights.
 */
export function cacheFileName(fingerprint, systemPrompt) {
  return `prompt-${createHash('sha256').update(`${fingerprint}\n${systemPrompt}`).digest('hex').slice(0, 24)}.bin`;
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
 * Make the next question fast: restore the processed prompt, or read it once and save it.
 *
 * Two cache files, one derived from the other:
 *
 *   - the SYSTEM PROMPT alone — release-stable, so it can be prepared when the
 *     image is built and restored on every install;
 *   - the system prompt plus `userPrefix`, the start of every user message on
 *     this deployment (its value lists). Prepared here by restoring the first
 *     file and reading the prefix on top of it — a few hundred tokens, seconds,
 *     not the minutes the whole prompt costs.
 *
 * Every question then starts from the second file, and the server reads only
 * what follows the prefix: the caller block, the name hints, the question. On
 * a CPU box that reads about thirteen tokens a second, the prefix alone was
 * twenty seconds of every answer. A prefix that no longer matches (a new
 * department appeared) is not a failure: the server reuses what does match,
 * which is the system prompt, and the next warm-up writes a fresh file.
 *
 * @returns {Promise<{ model: string, ms: number, restored: boolean, prepared?: 'system'|'prefix' }>}
 */
export async function warm(_model, systemPrompt, userPrefix = '') {
  const started = Date.now();
  const model = await servedModel();
  const fingerprint = await serverFingerprint();
  const systemFile = cacheFileName(fingerprint, systemPrompt);
  const prefixFile = userPrefix ? cacheFileName(fingerprint, `${systemPrompt}\n\n${userPrefix}`) : null;
  const restore = (filename) => call('POST', `/slots/${SLOT}?action=restore`, { filename });
  const save = (filename) => ok('POST', `/slots/${SLOT}?action=save`, { filename });
  const read = (userContent) => ok('POST', '/v1/chat/completions', completionBody(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
    { maxTokens: 1 },
  ));
  const done = (restored, prepared) => ({ model, ms: Date.now() - started, restored, ...(prepared ? { prepared } : {}) });

  if (prefixFile && (await restore(prefixFile)).status === 200) return done(true);
  const hadSystem = (await restore(systemFile)).status === 200;
  if (!hadSystem) {
    await read('ready?');
    await save(systemFile);
  }
  if (!prefixFile) return done(hadSystem, hadSystem ? undefined : 'system');
  // "Request:" is what follows the prefix in a real question, so the boundary
  // tokenises the same way and the whole prefix is reused.
  await read(`${userPrefix}\n\nRequest: ready?`);
  await save(prefixFile);
  return done(false, hadSystem ? 'prefix' : 'system');
}

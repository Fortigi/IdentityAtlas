// Organisation knowledge extraction — the local model, one constrained question at a time.
//
//   modelUrl()                          → the model server, or '' when none is configured
//   modelStatus()                       → { configured, reachable, model, state }   never throws
//   ask({ user, schema, check, maxTokens, timeoutMs }) → { ok, value, errors, rounds, timing }
//
// The server is the deployment's report generator (NL_REPORTS_LLM_URL); a test or
// CI run can point extraction alone at a double with ORG_KNOWLEDGE_LLM_URL. There is
// no fallback to any other model: with no server configured extraction refuses to
// start and says so. Every reply is JSON-schema constrained by the server AND checked
// by the stage's validator here; an invalid reply gets ONE repair round.
import { chat } from '../../nlreports/llamacpp.js';
import { httpJson } from '../../lib/httpJson.js';
import { SYSTEM_PROMPT } from './prompts.js';

export const DEFAULT_TIMEOUT_MS = 600_000;

export function modelUrl() {
  return (process.env.ORG_KNOWLEDGE_LLM_URL || process.env.NL_REPORTS_LLM_URL || '').replace(/\/$/, '');
}

async function getJson(path) {
  const r = await httpJson({ url: `${modelUrl()}${path}`, method: 'GET', timeoutMs: 10_000 });
  if (r.status < 200 || r.status >= 300 || !r.json) throw new Error(`model server answered ${r.status} on ${path}`);
  return r.json;
}

export async function modelStatus() {
  if (!modelUrl()) return { configured: false, reachable: false, model: null, state: null };
  try {
    const models = await getJson('/v1/models');
    const m = (models.data || models.models || [])[0] ?? {};
    let state = 'ready';
    try { state = (await getJson('/health')).model ?? 'ready'; } catch { /* plain llama-server has no supervisor state */ }
    return { configured: true, reachable: true, model: m.id || m.name || m.model || null, state };
  } catch (err) {
    return { configured: true, reachable: false, model: null, state: null, error: err.message };
  }
}

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * A reply cut off at the token cap ends mid-object: `{"claims":[{…},{…},{"subj`.
 * Keep every COMPLETE item: cut after the last closing brace and close the array
 * and object. Measured (2026-10-11): a passage with fourteen statements ran past
 * the cap and lost all of them, twice.
 */
export function salvage(content) {
  const whole = tryParse(content);
  if (whole !== null) return whole;
  let end = content.lastIndexOf('}');
  while (end > 0) {
    const head = content.slice(0, end + 1);
    for (const tail of [']}', '}', ']}}']) {
      const parsed = tryParse(head + tail);
      if (parsed !== null) return parsed;
    }
    end = content.lastIndexOf('}', end - 1);
  }
  return null;
}

const parse = (content) => salvage(String(content ?? ''));

export const repairMessage = (errors) =>
  `Your reply cannot be used:\n${errors.slice(0, 8).map(e => `- ${e}`).join('\n')}\nReply again with the whole corrected JSON.`;

function addTiming(total, t) {
  for (const k of ['totalMs', 'promptTokens', 'cachedTokens', 'outputTokens']) total[k] = (total[k] ?? 0) + (t?.[k] ?? 0);
  return total;
}

// MEASURED (2026-10-11, sidekick-1): the report generator's model process was
// OOM-killed mid-run (4 GB container limit); its supervisor reloads it on the next
// request, which first answers 502. A transient server error is retried after a
// pause long enough for the reload, instead of failing the whole extraction.
export const RETRY_DELAYS_MS = [30_000, 90_000];
const TRANSIENT = /returned 50[234]|ECONNRESET|ECONNREFUSED|socket hang up|EPIPE/;

export async function chatWithRetry(args, { delays = RETRY_DELAYS_MS, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chat(args);
    } catch (err) {
      if (attempt >= delays.length || !TRANSIENT.test(err.message)) throw err;
      console.warn(`org-knowledge: model call failed (${err.message}); retrying in ${Math.round(delays[attempt] / 1000)} s`);
      await sleep(delays[attempt]);
    }
  }
}

/**
 * One stage question. `check(reply)` is the stage validator from contracts.js.
 * @returns {Promise<{ ok: boolean, value?: any, errors: string[], rounds: number, timing: object }>}
 */
export async function ask({ user, schema, check, maxTokens = 450, timeoutMs = DEFAULT_TIMEOUT_MS, retry = {} }) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }];
  const timing = {};
  let errors = [];
  for (let round = 1; round <= 2; round++) {
    const { content, timing: t } = await withTimeout(
      chatWithRetry({ messages, schema, maxTokens, baseUrl: modelUrl() || undefined }, retry), timeoutMs,
      `the local model did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
    addTiming(timing, t);
    const reply = parse(content);
    const result = reply === null ? { ok: false, errors: ['The reply was not valid JSON.'] } : check(reply);
    if (result.ok) return { ok: true, value: result.value, errors: result.errors ?? [], rounds: round, timing };
    errors = result.errors;
    messages.push({ role: 'assistant', content }, { role: 'user', content: repairMessage(errors) });
  }
  return { ok: false, errors, rounds: 2, timing };
}

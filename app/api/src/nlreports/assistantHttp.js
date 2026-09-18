// HTTP helpers shared by the routes of every assistant on the report generator
// (routes/nlReports.js, routes/contextAssistant.js).

import { listModels, modelState } from './llm.js';
import { getReportModel } from './settings.js';

// Values written into a log line. Questions and user labels are free text (a token's
// name claim is not validated), so line breaks — which would let a caller forge extra
// log lines — are removed, other control characters are replaced, and the length is
// capped. Line breaks are removed rather than replaced: that is the form CodeQL's log
// injection check recognises as a sanitiser, and the check blocks merges.
export const forLog = (value, max = 300) => String(value ?? '')
  .slice(0, max)
  .replace(/\n/g, '')
  .replace(/\r/g, '')
  .replace(/[\u2028\u2029\p{Cc}]/gu, ' ');

export const MAX_QUESTION = 2000;
export const MAX_HISTORY = 12;
// The model's context is 8,192 tokens: ~4,000 go to the system prompt, ~1,200 are kept for
// the reply, a question is at most ~500. That leaves ~2,500 tokens — about 10,000
// characters — for the conversation. Anything longer would not fit anyway, and would cost
// minutes of prompt reading before failing.
export const MAX_HISTORY_CHARS = 10_000;
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,100}$/;

const isHistoryTurn = (h) => !!h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string' && h.content.length <= 20000;

/**
 * Check a request that asks the model something: a question plus the conversation so far.
 * Shared by both assistants.
 * @returns {{ error: string } | { question: string, history: {role:string, content:string}[] }}
 */
export function parseInterpretRequest(body) {
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  const history = Array.isArray(body?.history) ? body.history : [];
  if (!question || question.length > MAX_QUESTION) return { error: `Question is required (max ${MAX_QUESTION} characters)` };
  if (history.length > MAX_HISTORY) return { error: 'Conversation is too long — start a new question' };
  // `model` in the body is an evaluation override (tools/nl-reports/eval.mjs); the UI never sends it.
  if (body?.model !== undefined && !MODEL_NAME.test(String(body.model))) return { error: 'Invalid model name' };
  if (!history.every(isHistoryTurn)) return { error: 'Invalid conversation history' };
  const cleanHistory = history.map(h => ({ role: h.role, content: h.content }));
  if (cleanHistory.reduce((n, h) => n + h.content.length, 0) > MAX_HISTORY_CHARS) {
    return { error: 'Conversation is too long — start a new question' };
  }
  return { question, history: cleanHistory };
}

export const userOf = (req) => (req.user && (req.user.email || req.user.upn || req.user.preferred_username || req.user.name)) || 'unknown';

/**
 * Is the model server reachable, and is the model loaded — for one assistant's warm-up.
 * @param {() => string} warmupState
 */
export async function generatorStatus(warmupState) {
  const model = await getReportModel().catch(() => null);
  try {
    const models = await listModels();
    const found = models.find(m => m.name === model);
    return { available: !!found, model, loaded: !!found?.loaded, promptCache: warmupState(), reason: found ? null : 'model-not-installed' };
  } catch {
    return { available: false, model, loaded: false, promptCache: warmupState(), reason: 'server-unreachable' };
  }
}

// Never blocks for minutes: the first warm-up after an install or update prepares the
// prompt cache in the background, and this answers `state: "preparing"` meanwhile.
export const WARM_WAIT_MS = 3000;

/**
 * The answer to a warm request: ready, the model loading into memory ('starting',
 * seconds), or the one-off prompt-cache preparation ('preparing', minutes).
 * @param {{ ensureWarm: Function, warmupState: Function }} warmup
 * @returns {Promise<object|null>} null when the warm-up failed
 */
export async function warmResponse({ ensureWarm, warmupState }, waitMs = WARM_WAIT_MS) {
  // No `force`: every call re-checks the running server, so there is nothing to force.
  const entry = ensureWarm();
  const ready = await Promise.race([
    entry.promise.then(r => r, () => null),
    new Promise(resolve => setTimeout(() => resolve(undefined), waitMs)),
  ]);
  if (ready) return { ...ready, state: 'ready' };
  if (warmupState() === 'failed') return null;
  // The two waits look the same from here; the server knows which.
  if (await modelState().catch(() => 'ready') === 'starting') {
    return { state: 'starting', message: 'The model is being loaded. This usually takes less than a minute.' };
  }
  return { state: 'preparing', message: 'The model is preparing its prompt cache. The first time after an install or update this takes a few minutes; questions asked now will be slow.' };
}

/**
 * The warm endpoint both assistants expose: restore this assistant's prompt into the
 * generator's single slot, answering what state it is in rather than blocking on a
 * preparation that takes minutes.
 * @param {{ ensureWarm: Function, warmupState: Function }} warmup
 * @param {Function} fail  the router's error responder — (res, route, err, status)
 * @returns {(req, res) => Promise<void>} an express handler
 */
export function warmHandler(warmup, fail) {
  return async (_req, res) => {
    try {
      const answer = await warmResponse(warmup);
      if (!answer) return fail(res, 'warm', new Error('the model server did not answer'), 502);
      res.json(answer);
    } catch (err) {
      fail(res, 'warm', err, 502);
    }
  };
}

/**
 * One question at a time per analyst. The model server has a single slot, so a second
 * request from the same person only queues behind the first — and a script looping on
 * an endpoint would hold the generator for everyone.
 * @returns {(req, res) => string|null} claims a slot for the caller, or answers 429 and returns null
 */
export function oneQuestionAtATime() {
  const inFlight = new Set();
  return (req, res) => {
    const who = `user=${forLog(userOf(req), 200)}`;
    if (inFlight.has(who)) {
      res.status(429).json({ error: 'Your previous question is still being answered — wait for it to finish' });
      return null;
    }
    inFlight.add(who);
    res.on('close', () => inFlight.delete(who));
    return who;
  };
}

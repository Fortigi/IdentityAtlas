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

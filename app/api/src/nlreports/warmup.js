// Prompt-cache warm-up for one system prompt — shared by every assistant that talks to
// the report generator (custom reports, the context assistant).
//
// Two very different costs hide behind a warm-up:
//
//   • PREPARING the cache file — the model reads the whole system prompt, which is
//     minutes on a small CPU box. Needed once per release, per prompt.
//   • RESTORING that file into the running server — ~0.1 s. Needed again every time
//     the model server starts, AND every time another prompt was restored in between:
//     the generator has one slot, so the assistants take turns holding it.
//
// So a warm-up that succeeded earlier is NOT proof the server still holds the prompt.
// The generator is a separate container with its own lifecycle (scaled to zero on
// Azure, restarted with the host on Docker), and another assistant may have swapped
// its own prompt in. Remembering "ready" across that is how the prompt cache once came
// to do nothing in exactly the case it was built for.
//
// This therefore never short-circuits on an earlier result: every call restores again,
// which is cheap, and only a missing cache file pays to read the prompt. Concurrent
// callers share the attempt in flight.

import { warm } from './llm.js';
import { getReportModel } from './settings.js';

/**
 * @param {() => string} buildPrompt  the system prompt this warm-up keeps in the slot
 * @returns {{ ensureWarm: () => { state: string, promise: Promise<object> }, warmupState: () => string }}
 */
export function createWarmup(buildPrompt) {
  let current = null;

  function ensureWarm() {
    if (current?.state === 'warming') return current;
    const entry = { state: 'warming', promise: null };
    entry.promise = (async () => {
      try {
        const result = await warm(await getReportModel(), buildPrompt());
        entry.state = 'ready';
        return result;
      } catch (err) {
        entry.state = 'failed';
        throw err;
      }
    })();
    current = entry;
    return entry;
  }

  return { ensureWarm, warmupState: () => (current ? current.state : 'cold') };
}

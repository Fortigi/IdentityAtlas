// Organisation truth — the recipe proposal: the heuristic, or the local model when it is there.
//
//   propose({ fileName, columns, rowCount, probes?, template? }) → { recipe, linkRules, notes, origin, timing, template }
//
// The heuristic always runs first and is always the fallback. The model (the report
// generator custom reports and the context assistant use) is asked only when a model
// server is configured and answers its health check. Its reply is checked with the shared
// contracts; a reply that fails gets ONE repair round with the error sentences, and a
// reply that still fails — or a model that is slow or unreachable — yields the heuristic
// proposal with `origin: 'heuristic'` and a note saying why. The proposal is interpretive
// (decision principle B3): the analyst's confirmation in the wizard is the record.
//
// Decisions made here, not in the handover:
//   - modelState() rejecting is "the model is unreachable"; any state it answers
//     (unloaded / starting / ready) is worth a try, because the call is time-boxed.
//   - The warm-up (restoring this prompt into the generator's single slot) is awaited for
//     at most WARM_WAIT_MS. The first preparation after an install takes minutes; the
//     analyst is not kept waiting for it — the call then simply times out to the heuristic.
//   - chat() has no per-call timeout of its own (llamacpp.js uses the generator-wide one),
//     so CHAT_TIMEOUT_MS is a race here. A request that loses the race keeps running on
//     the server until it finishes; the analyst already has the heuristic answer.

import { chat, modelState } from '../../nlreports/llm.js';
import { createWarmup, prepareAtStartup } from '../../nlreports/warmup.js';
import { getReportModel } from '../../nlreports/settings.js';
import { isFeatureEnabled } from '../../featureFlags.js';
import { normalizeLinkRules, normalizeRecipe, validateLinkRules, validateRecipe } from '../contracts.js';
import { FEATURE } from '../http/gates.js';
import { heuristicProposal, MAX_NOTES, usableColumns } from './heuristic.js';
import { buildPrompt, buildUserMessage, MAX_NOTE, RESPONSE_SCHEMA } from './prompt.js';
import { chooseTemplate } from './template.js';
import { templateProposal } from './templateRecipes.js';

export const CHAT_TIMEOUT_MS = 20_000;
export const WARM_WAIT_MS = 10_000;

export const { ensureWarm, warmupState } = createWarmup(buildPrompt);

/**
 * Prepare this prompt's cache when the API starts (bootstrap.js runs the assistants one
 * after the other: the generator has one slot). Skipped unless orgTruth is on and a model
 * server is configured.
 * @returns {Promise<'skipped'|'ready'|'failed'>}
 */
export async function warmAtStartup(options = {}) {
  return prepareAtStartup({ ensureWarm, enabled: () => isFeatureEnabled(FEATURE), label: 'Organisation truth proposal', ...options });
}

/** Resolve with `promise`, or reject with `message` after `ms`. */
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseReply(content) {
  try { return JSON.parse(content); } catch { return null; }
}

/**
 * Check a parsed model reply against the contracts.
 * @returns {{ ok: true, recipe, linkRules, notes } | { ok: false, errors: string[] }}
 */
export function checkReply(reply, columnNames) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    return { ok: false, errors: ['The reply must be one JSON object with "recipe", "linkRules" and "notes".'] };
  }
  const r = validateRecipe(reply.recipe, columnNames);
  if (!r.ok) return { ok: false, errors: r.errors };
  const recipe = normalizeRecipe(reply.recipe);
  const rules = reply.linkRules ?? [];
  const l = validateLinkRules(rules, recipe);
  if (!l.ok) return { ok: false, errors: l.errors };
  const notes = (Array.isArray(reply.notes) ? reply.notes : [])
    .filter(n => typeof n === 'string' && n.trim()).slice(0, MAX_NOTES).map(n => n.trim().slice(0, MAX_NOTE));
  return { ok: true, recipe, linkRules: normalizeLinkRules(rules), notes };
}

export function repairMessage(errors) {
  return `Your reply cannot be used:\n${errors.slice(0, 10).map(e => `- ${e}`).join('\n')}\nReply again with the whole corrected JSON.`;
}

async function ask(messages, timeoutMs) {
  const model = await getReportModel().catch(() => undefined);
  const { content, timing } = await withTimeout(chat({ model, messages, schema: RESPONSE_SCHEMA }), timeoutMs,
    `the local model did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
  return { content, reply: parseReply(content), timing };
}

const invalid = (answer, columnNames) => (answer.reply === null
  ? { ok: false, errors: ['The reply was not valid JSON.'] }
  : checkReply(answer.reply, columnNames));

/**
 * Ask the model, with one repair round.
 * @returns {Promise<{ ok: true, recipe, linkRules, notes, rounds, timing } | { ok: false, reason: string, rounds }>}
 */
export async function askModel({ fileName, columns }, { timeoutMs = CHAT_TIMEOUT_MS, warmWaitMs = WARM_WAIT_MS } = {}) {
  await withTimeout(ensureWarm().promise, warmWaitMs, 'warm-up still running').catch(() => {});
  const columnNames = columns.map(c => c.name);
  const messages = [{ role: 'system', content: buildPrompt() }, { role: 'user', content: buildUserMessage({ fileName, columns }) }];
  const first = await ask(messages, timeoutMs);
  const firstCheck = invalid(first, columnNames);
  if (firstCheck.ok) return { ...firstCheck, rounds: 1, timing: first.timing };

  messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: repairMessage(firstCheck.errors) });
  const second = await ask(messages, timeoutMs);
  const secondCheck = invalid(second, columnNames);
  if (secondCheck.ok) return { ...secondCheck, rounds: 2, timing: second.timing };
  return { ok: false, rounds: 2, reason: `its answer did not fit the list after one correction (${secondCheck.errors[0]})` };
}

/** Is a model server configured and answering? Never throws. */
export async function modelReachable() {
  if (!process.env.NL_REPORTS_LLM_URL) return false;
  try { await modelState(); return true; } catch { return false; }
}

const fallbackNote = (reason) => `The local model's proposal could not be used: ${reason}. This proposal comes from the column names and values.`;

/**
 * The template first (template.js: which of the four kinds this list is, or the
 * analyst's forced `template`); an activity, enrichment or relation gets its recipe
 * from templateRecipes.js, a collection from the heuristic or the model below.
 * @param {object} args
 * @param {string} [args.fileName]
 * @param {object[]} args.columns   the column profile (see heuristic.js)
 * @param {number} [args.rowCount]
 * @param {object} [args.probes]    probe.js results, when the rows were read
 * @param {string} [args.template]  force this template (the wizard's override)
 * @param {boolean} [args.hasIdentities] identities exist (an enrichment of people then targets Identity)
 * @param {object} [options]        { timeoutMs, warmWaitMs } — for tests
 * @returns {Promise<{ recipe, linkRules, notes: string[], origin: 'model'|'heuristic'|'data', timing: object,
 *                     template: { kind, confidence, reason, alternatives } }>}
 */
export async function propose(input = {}, options = {}) {
  const { fileName = '', columns, rowCount, probes = null, template = null, hasIdentities = false } = input;
  const started = Date.now();
  const cols = usableColumns(columns);
  const chosen = chooseTemplate({ columns: cols, probes, rowCount, forced: template });
  if (chosen.kind === 'collection') return { ...(await proposeCollection(input, options)), template: chosen.summary };
  const result = templateProposal(chosen.kind, { fileName, columns: cols, probes, picks: chosen.picks, hasIdentities });
  return { ...result, origin: probes ? 'data' : 'heuristic', timing: { ms: Date.now() - started, model: false }, template: chosen.summary };
}

async function proposeCollection({ fileName = '', columns, rowCount, probes = null, compositeKey = null } = {}, options = {}) {
  const started = Date.now();
  const heuristic = heuristicProposal({ fileName, columns, rowCount, probes, compositeKey });
  const done = (result, origin, extra = {}) => ({ ...result, origin, timing: { ms: Date.now() - started, ...extra } });
  // DECISION: with the list's values probed against the accounts, resources and
  // other lists, the data decides — it knows "Column 3" holds people, which no
  // model reading headers and five samples can. The model is asked only when the
  // proposal has nothing but the column profile to go on.
  if (probes) return done(heuristic, 'data', { model: false });
  if (!(await modelReachable())) return done(heuristic, 'heuristic', { model: false });

  try {
    const answer = await askModel({ fileName, columns: usableColumns(columns) }, options);
    if (answer.ok) {
      const { recipe, linkRules, notes } = answer;
      return done({ recipe, linkRules, notes }, 'model', { model: true, rounds: answer.rounds, llm: answer.timing ?? null });
    }
    return done({ ...heuristic, notes: [fallbackNote(answer.reason), ...heuristic.notes].slice(0, MAX_NOTES) }, 'heuristic', { model: true, rounds: answer.rounds });
  } catch (err) {
    // Only our own timeout sentence reaches the analyst; a server error text stays in the log.
    const reason = err.message.startsWith('the local model') ? err.message : 'the local model server failed';
    if (reason !== err.message) console.warn('org-truth propose: model call failed —', err.message);
    return done({ ...heuristic, notes: [fallbackNote(reason),...heuristic.notes].slice(0, MAX_NOTES) }, 'heuristic', { model: true });
  }
}

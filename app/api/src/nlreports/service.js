// Natural-language reports (PROTOTYPE) — interpret a question, run a spec.
//
//   interpret(): question (+ conversation) → model → validated spec or a
//                clarifying question. One repair round if the spec is invalid.
//   runSpec():   validated spec → compiled SQL → READ ONLY transaction with a
//                statement timeout → rows shaped for the list renderer.

import { query, tx } from '../db/connection.js';
import { ENTITIES, VALUE_QUERIES } from './catalog.js';
import { validateSpec } from './spec.js';
import { compileSpec } from './compile.js';
import { explainSpec } from './explain.js';
import { buildSystemPrompt, buildValuesBlock, RESPONSE_SCHEMA, REPORT_ONLY_SCHEMA } from './prompt.js';
import { chat, DEFAULT_MODEL } from './llm.js';
import { createWarmup } from './warmup.js';
import { resolveNamedObjects } from './references.js';
import { correctionMessage, findTerms, locateTerms, termConfirmation, termHint, unusedTerms } from './terms.js';
import { isFeatureEnabled } from '../featureFlags.js';

const VALUES_TTL_MS = 5 * 60 * 1000;
const MAX_CLARIFY_ROUNDS = 2;
const STATEMENT_TIMEOUT = '15s';

let valuesCache = { at: 0, values: null };

// The prompt-cache warm-up for the report prompt. Why it re-restores on every call
// instead of remembering an earlier success: see warmup.js.
export const { ensureWarm, warmupState } = createWarmup(buildSystemPrompt);

/**
 * Prepare the prompt cache when the API starts. The first run after an install or
 * update reads the whole system prompt (minutes on a small CPU box) and saves it;
 * later starts restore it in milliseconds.
 *
 * Skipped unless custom reports are switched on AND a model server is configured:
 * an install that updated and did nothing must not log connection failures on every
 * start, and on Azure must not wake a scaled-to-zero generator nobody uses. The
 * server may still be starting (or scaling up from zero), so it gets a few tries;
 * opening the report builder triggers another attempt anyway.
 *
 * @returns {Promise<'skipped'|'ready'|'failed'>}
 */
export async function warmAtStartup({ attempts = 3, delayMs = 30_000 } = {}) {
  if (!process.env.NL_REPORTS_LLM_URL || !(await isFeatureEnabled('customReports'))) return 'skipped';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await ensureWarm().promise;
      console.log(`Report generator: prompt cache ${r.restored ? 'restored' : 'prepared'} in ${(r.ms / 1000).toFixed(1)}s`);
      return 'ready';
    } catch (err) {
      console.warn(`Report generator: prompt cache attempt ${attempt}/${attempts} failed — ${err.message}`);
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return 'failed';
}

export async function loadValues() {
  if (valuesCache.values && Date.now() - valuesCache.at < VALUES_TTL_MS) return valuesCache.values;
  const values = {};
  for (const [key, sql] of Object.entries(VALUE_QUERIES)) {
    const { rows } = await query(sql);
    values[key] = rows.map(r => r.v).filter(v => v !== null && v !== '').sort();
  }
  valuesCache = { at: Date.now(), values };
  return values;
}

function addTiming(a, b) {
  if (!a) return { ...b };
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = (out[k] || 0) + b[k];
  return out;
}

const OR_REPAIR_MESSAGE =
  'The request says "or", but your definition requires ALL conditions at the same time. ' +
  'Put the alternatives that are joined by "or" together in a group with match "any"; keep the other conditions outside that group. ' +
  'Reply with the corrected complete JSON.';

/** True when the spec has an OR anywhere: top-level, in a group, or inside a relation. */
export function hasAnyMatch(spec) {
  if (spec.match === 'any' && spec.conditions.length > 1) return true;
  return spec.conditions.some(c => (c.type === 'group' || c.type === 'relation') && c.match === 'any' && c.conditions.length > 1);
}

/** The question joins alternatives with "or"/"either", but the definition has no OR at all. */
export function needsOrRepair(question, spec) {
  return /\b(or|either)\b/i.test(question) && spec.conditions.length > 1 && !hasAnyMatch(spec);
}

function parseReply(content) {
  try { return JSON.parse(content); } catch { return null; }
}

/**
 * The conversation sent to the model: system prompt, earlier turns, then the
 * question with the deployment's values in front of it (when there are any).
 */
function buildMessages(question, history, values, located = []) {
  const context = [buildValuesBlock(values), termHint(located)].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    { role: 'user', content: context ? `${context}\n\nRequest: ${question}` : question },
  ];
}

/** After MAX_CLARIFY_ROUNDS clarifying questions the model must produce a report. */
export function schemaFor(history) {
  const clarifyRounds = history.filter(h => h.role === 'assistant' && parseReply(h.content)?.kind === 'clarify').length;
  return clarifyRounds >= MAX_CLARIFY_ROUNDS ? REPORT_ONLY_SCHEMA : RESPONSE_SCHEMA;
}

// A turn is the state of one interpret() call as the repair rounds move it along:
// { raw, reply, timing, repaired }. The context `ctx` is { question, model, messages, values }.

/** The fields every interpret() reply ends with. */
function replyMeta(ctx, turn) {
  return { raw: turn.raw, timing: turn.timing, model: ctx.model, repaired: turn.repaired };
}

/** Ask again after the model's last answer, with a correction. Counts as a repair. */
async function askForCorrection(ctx, turn, correction) {
  turn.repaired = true;
  const retry = await chat({
    model: ctx.model,
    schema: REPORT_ONLY_SCHEMA,
    messages: [
      ...ctx.messages,
      { role: 'assistant', content: turn.raw },
      { role: 'user', content: correction },
    ],
  });
  turn.timing = addTiming(turn.timing, retry.timing);
  return { content: retry.content, reply: parseReply(retry.content) };
}

/** One repair round: show the model exactly what the validator rejected. */
async function repairInvalidSpec(ctx, turn, result) {
  if (result.ok) return result;
  const retry = await askForCorrection(ctx, turn,
    `That definition has problems:\n- ${result.errors.join('\n- ')}\nReply with the corrected complete JSON.`);
  if (retry.reply?.kind !== 'report') return result;
  turn.raw = retry.content;
  turn.reply = retry.reply;
  return validateSpec(turn.reply.spec, ctx.values);
}

/** The most common small-model mistake: "X or Y" compiled as X AND Y. */
async function repairMissingOr(ctx, turn, result) {
  if (!result.ok || !needsOrRepair(ctx.question, result.spec)) return result;
  const retry = await askForCorrection(ctx, turn, OR_REPAIR_MESSAGE);
  const retriedResult = retry.reply?.kind === 'report' ? validateSpec(retry.reply.spec, ctx.values) : null;
  // Only take the correction when it is valid and actually contains an "any".
  if (!retriedResult?.ok || !hasAnyMatch(retriedResult.spec)) return result;
  turn.raw = retry.content;
  turn.reply = retry.reply;
  return retriedResult;
}

/** A name from the question that occurs in the data but is not in the definition: say where it occurs. */
async function repairUnusedTerms(ctx, turn, result) {
  const unused = result.ok ? unusedTerms(result.spec, ctx.located) : [];
  if (!unused.length) return result;
  const retry = await askForCorrection(ctx, turn, correctionMessage(unused));
  const retriedResult = retry.reply?.kind === 'report' ? validateSpec(retry.reply.spec, ctx.values) : null;
  // Only take the correction when it is valid and uses more of the names.
  if (!retriedResult?.ok || unusedTerms(retriedResult.spec, ctx.located).length >= unused.length) return result;
  turn.raw = retry.content;
  turn.reply = retry.reply;
  return retriedResult;
}

/**
 * Still ignoring a name after the correction: the analyst chooses where it applies
 * (no guess is run). When the name does not occur on the report's own entity there
 * is nothing to offer, so the report says it left the name out.
 * @returns {object|null} a confirmation, or null (assumptions updated in place)
 */
function termCheck(ctx, spec, assumptions) {
  for (const unused of unusedTerms(spec, ctx.located)) {
    const confirm = termConfirmation(spec, unused, ctx.question);
    if (confirm) {
      // The model's own story about the name ("ACME is the system …") is what the analyst is correcting.
      const n = unused.term.toLowerCase();
      assumptions.splice(0, assumptions.length, ...assumptions.filter(a => !a.toLowerCase().includes(n)));
      return confirm;
    }
    assumptions.push(`“${unused.term}” from the request is not used in this report.`);
  }
  return null;
}

/** A report reply: repair it if needed, look named objects up, and shape the answer. */
async function answerReport(ctx, turn) {
  let result = validateSpec(turn.reply.spec, ctx.values);
  result = await repairInvalidSpec(ctx, turn, result);
  result = await repairMissingOr(ctx, turn, result);
  result = await repairUnusedTerms(ctx, turn, result);
  const errors = result.errors;
  // Still invalid after the repair round: say so. Validation drops what it rejects
  // and still hands back a spec, so returning that as a report would quietly answer
  // a smaller question than the one asked ("groups with X and <unknown>" → "groups
  // with X") with nothing on screen to show the difference.
  if (!result.ok || !result.spec) {
    return { kind: 'error', message: 'The model produced a report definition that could not be used.', errors, ...replyMeta(ctx, turn) };
  }
  const assumptions = Array.isArray(turn.reply.assumptions) ? turn.reply.assumptions.map(String) : [];
  const termConfirm = termCheck(ctx, result.spec, assumptions);
  if (termConfirm) {
    return { kind: 'confirm', spec: result.spec, confirm: termConfirm, assumptions, ...replyMeta(ctx, turn) };
  }
  // Named objects ("business role X", "the Sales group") are looked up; a fuzzy match is confirmed by the analyst.
  const { confirm } = await resolveNamedObjects(result.spec, query);
  if (confirm) {
    return { kind: 'confirm', spec: result.spec, confirm, assumptions, ...replyMeta(ctx, turn) };
  }
  const compiled = compileSpec(result.spec);
  return {
    kind: 'report',
    spec: result.spec,
    assumptions,
    explanation: explainSpec(result.spec),
    warnings: errors,
    sql: compiled.text,
    ...replyMeta(ctx, turn),
  };
}

function answerClarify(ctx, turn) {
  return {
    kind: 'clarify',
    question: String(turn.reply.question || ''),
    options: Array.isArray(turn.reply.options) ? turn.reply.options.map(String).slice(0, 4) : [],
    ...replyMeta(ctx, turn),
  };
}

/**
 * @param {object} args
 * @param {string} args.question  the newest user message
 * @param {{role:'user'|'assistant', content:string}[]} [args.history]  earlier turns
 * @param {string} [args.model]
 */
export async function interpret({ question, history = [], model = DEFAULT_MODEL }) {
  // Put the processed system prompt back in the server before asking, in case it
  // restarted since the last question. A hit costs ~0.1 s and saves ~3 minutes; a
  // miss is no worse than asking cold, and leaves the cache saved for next time.
  // Never let this sink the question itself — the model answers either way.
  await ensureWarm().promise.catch(() => {});
  const values = await loadValues();
  const schema = schemaFor(history);
  const terms = findTerms(question, values);
  const located = terms.length ? await locateTerms(terms, query, values) : [];
  const ctx = { question, model, values, located, messages: buildMessages(question, history, values, located) };

  const first = await chat({ model, messages: ctx.messages, schema });
  const turn = { raw: first.content, reply: parseReply(first.content), timing: first.timing, repaired: false };

  if (turn.reply?.kind === 'report') return answerReport(ctx, turn);
  if (turn.reply?.kind === 'clarify') return answerClarify(ctx, turn);
  return { kind: 'error', message: 'The model reply was not valid JSON.', ...replyMeta(ctx, turn) };
}

function formatCell(type, v) {
  if (v === null || v === undefined) return null;
  if (type === 'boolean') return v ? 'Yes' : 'No';
  if (type === 'date') return new Date(v).toISOString().slice(0, 10);
  if (type === 'number') return Number(v);
  return v;
}

/**
 * @param {object} rawSpec  a spec (from the model or edited in the UI)
 * @returns {Promise<object>} { ok:false, errors } or the run result
 */
export async function runSpec(rawSpec) {
  const values = await loadValues();
  const { ok, spec, errors } = validateSpec(rawSpec, values);
  if (!ok) return { ok: false, errors, spec };
  const { confirm } = await resolveNamedObjects(spec, query);
  if (confirm) return { ok: false, errors: [confirm.message], confirm, spec };

  const compiled = compileSpec(spec);
  const started = Date.now();
  const result = await tx(async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    return client.query(compiled.text, compiled.params);
  });
  const elapsedMs = Date.now() - started;

  const truncated = result.rows.length > spec.limit;
  const kind = ENTITIES[spec.entity].detailKind;
  const rows = result.rows.slice(0, spec.limit).map(r => {
    const row = { _entity: { kind, id: r.__id } };
    for (const c of compiled.columns) row[c.key] = formatCell(c.type, r[c.key]);
    return row;
  });

  return {
    ok: true,
    spec,
    explanation: explainSpec(spec),
    columns: compiled.columns.map(({ key, label }) => ({ key, label })),
    rows,
    total: rows.length,
    truncated,
    sql: compiled.text,
    params: compiled.params,
    elapsedMs,
  };
}

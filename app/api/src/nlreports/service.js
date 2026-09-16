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
import { chat, DEFAULT_MODEL, warm } from './llm.js';
import { getReportModel } from './settings.js';
import { resolveNamedObjects } from './references.js';

const VALUES_TTL_MS = 5 * 60 * 1000;
const MAX_CLARIFY_ROUNDS = 2;
const STATEMENT_TIMEOUT = '15s';

let valuesCache = { at: 0, values: null };

// One warm-up at a time. Two very different costs hide behind it:
//
//   • PREPARING the cache file — the model reads the whole ~4k-token system prompt,
//     which is minutes on a small CPU box. Needed once per release.
//   • RESTORING that file into the running server — ~0.1 s. Needed again every time
//     the model server starts.
//
// So a warm-up that succeeded earlier is NOT proof the server still holds the
// prompt. The generator is a separate container with its own lifecycle: on Azure it
// is scaled to zero between questions and comes back with an empty KV cache, and on
// Docker it restarts with the host. Remembering "ready" across that is how the
// prompt cache came to do nothing in exactly the case it was built for — the API
// reported ready, never restored, and the next question paid the full prompt read.
//
// This therefore never short-circuits on an earlier result: every call restores
// again, which is cheap, and only a missing cache file pays to read the prompt.
// Concurrent callers share the attempt in flight.
let warmup = null;

export function warmupState() {
  return warmup ? warmup.state : 'cold';
}

/**
 * @returns {{ state: string, promise: Promise<object> }} the warm-up in flight, started if needed
 */
export function ensureWarm() {
  if (warmup?.state === 'warming') return warmup;
  const entry = { state: 'warming', promise: null };
  entry.promise = (async () => {
    try {
      const result = await warm(await getReportModel(), buildSystemPrompt());
      entry.state = 'ready';
      return result;
    } catch (err) {
      entry.state = 'failed';
      throw err;
    }
  })();
  warmup = entry;
  return entry;
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
  const clarifyRounds = history.filter(h => h.role === 'assistant' && parseReply(h.content)?.kind === 'clarify').length;
  const schema = clarifyRounds >= MAX_CLARIFY_ROUNDS ? REPORT_ONLY_SCHEMA : RESPONSE_SCHEMA;

  const valuesBlock = buildValuesBlock(values);
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    { role: 'user', content: valuesBlock ? `${valuesBlock}\n\nRequest: ${question}` : question },
  ];

  const first = await chat({ model, messages, schema });
  let timing = first.timing;
  let raw = first.content;
  let reply = parseReply(raw);
  let repaired = false;
  let errors = [];

  if (reply?.kind === 'report') {
    let result = validateSpec(reply.spec, values);
    if (!result.ok) {
      // One repair round: show the model exactly what the validator rejected.
      repaired = true;
      const retry = await chat({
        model,
        schema: REPORT_ONLY_SCHEMA,
        messages: [
          ...messages,
          { role: 'assistant', content: raw },
          { role: 'user', content: `That definition has problems:\n- ${result.errors.join('\n- ')}\nReply with the corrected complete JSON.` },
        ],
      });
      timing = addTiming(timing, retry.timing);
      const retried = parseReply(retry.content);
      if (retried?.kind === 'report') {
        raw = retry.content;
        reply = retried;
        result = validateSpec(reply.spec, values);
      }
    }
    if (result.ok && needsOrRepair(question, result.spec)) {
      // The most common small-model mistake: "X or Y" compiled as X AND Y.
      repaired = true;
      const retry = await chat({
        model,
        schema: REPORT_ONLY_SCHEMA,
        messages: [
          ...messages,
          { role: 'assistant', content: raw },
          { role: 'user', content: OR_REPAIR_MESSAGE },
        ],
      });
      timing = addTiming(timing, retry.timing);
      const retried = parseReply(retry.content);
      const retriedResult = retried?.kind === 'report' ? validateSpec(retried.spec, values) : null;
      // Only take the correction when it is valid and actually contains an "any".
      if (retriedResult?.ok && hasAnyMatch(retriedResult.spec)) {
        raw = retry.content;
        reply = retried;
        result = retriedResult;
      }
    }
    errors = result.errors;
    if (!result.spec) {
      return { kind: 'error', message: 'The model produced a report definition that could not be used.', errors, raw, timing, model, repaired };
    }
    const assumptions = Array.isArray(reply.assumptions) ? reply.assumptions.map(String) : [];
    // Named objects ("business role X", "the Sales group") are looked up; a fuzzy match is confirmed by the analyst.
    const { confirm } = await resolveNamedObjects(result.spec, query);
    if (confirm) {
      return { kind: 'confirm', spec: result.spec, confirm, assumptions, raw, timing, model, repaired };
    }
    const compiled = compileSpec(result.spec);
    return {
      kind: 'report',
      spec: result.spec,
      assumptions,
      explanation: explainSpec(result.spec),
      warnings: errors,
      sql: compiled.text,
      raw, timing, model, repaired,
    };
  }

  if (reply?.kind === 'clarify') {
    return {
      kind: 'clarify',
      question: String(reply.question || ''),
      options: Array.isArray(reply.options) ? reply.options.map(String).slice(0, 4) : [],
      raw, timing, model, repaired,
    };
  }

  return { kind: 'error', message: 'The model reply was not valid JSON.', raw, timing, model, repaired };
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

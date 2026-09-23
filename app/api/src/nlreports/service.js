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
import { sentinelsIn, substituteValues } from './sentinels.js';
import { autofixSpec, dropUnaskedGrouping, lostLeaves } from './autofix.js';
import { buildReplySchemas, buildSystemPrompt, buildValuesBlock } from './prompt.js';
import { attributeFieldNames, attributesBlock, loadExtFields, matchQuestionAttributes } from './extFields.js';
import { chat, DEFAULT_MODEL } from './llm.js';
import { createWarmup, prepareAtStartup } from './warmup.js';
import { applyChoice, resolveNamedObjects } from './references.js';
import {
  applyTermChoice, correctionMessage, findTerms, loadKnownNames, locateTerms, termConfirmation, termHint, unusedTerms,
} from './terms.js';
import { isFeatureEnabled } from '../featureFlags.js';

const VALUES_TTL_MS = 5 * 60 * 1000;
const MAX_CLARIFY_ROUNDS = 2;
const STATEMENT_TIMEOUT = '15s';

let valuesCache = { at: 0, values: null };

/** Test seam: forget the cached value lists, so a test can supply its own. */
export function clearValuesCache() { valuesCache = { at: 0, values: null }; }

// The prompt-cache warm-up for the report prompt. Why it re-restores on every call
// instead of remembering an earlier success: see warmup.js.
export const { ensureWarm, warmupState } = createWarmup(buildSystemPrompt);

/**
 * Prepare the report prompt's cache when the API starts. See warmup.prepareAtStartup.
 * @returns {Promise<'skipped'|'ready'|'failed'>}
 */
export async function warmAtStartup(options = {}) {
  return prepareAtStartup({
    ensureWarm,
    enabled: () => isFeatureEnabled('customReports'),
    label: 'Report generator',
    ...options,
  });
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

// Dutch "of" is BOTH "or" and "whether", and the two turn up in one sentence
// often enough that telling them apart matters: "Kan je me vertellen OF William
// aan groepen toegevoegd is OF eruit gehaald is" opens with the whether sense
// and joins alternatives with the second. Treating either as a disjunction is
// not free — a false positive sends the definition back for a repair round that
// costs a model call and can turn a correct AND into a wrong OR.
//
// The one reliable signal: the whether sense follows a verb of asking or
// finding out. That verb is what is checked for, rather than trying to parse
// the clause.
const DUTCH_WHETHER_VERBS = new Set([
  'vertellen', 'zeggen', 'weten', 'zien', 'kijken', 'checken', 'controleren',
  'vragen', 'nagaan', 'benieuwd', 'uitzoeken', 'opzoeken',
]);

// Dutch words that essentially never occur in an English sentence. Two of them
// are needed before the "of" rule below is applied at all, because "of" is one
// of the commonest words in ENGLISH — "a list of all guest accounts" — where it
// is a preposition and means nothing of the sort. Without this gate the repair
// fired on almost every English question.
const DUTCH_MARKERS = new Set([
  'welke', 'wie', 'hoeveel', 'zijn', 'heeft', 'hebben', 'geen', 'niet', 'deze', 'die',
  'mijn', 'jouw', 'toegevoegd', 'verwijderd', 'gewijzigd', 'eigenaar', 'groepen',
  'gebruikers', 'leden', 'worden', 'wordt', 'nog', 'laatste', 'wel', 'ook', 'waar',
  'kan', 'kun', 'vertellen', 'laten', 'zonder', 'uit', 'aan',
]);

const looksDutch = (words) => words.filter(w => DUTCH_MARKERS.has(w)).length >= 2;

/** Does the question offer alternatives — "X or Y", "X of Y", "X dan wel Y"? */
export function hasDisjunction(question) {
  const text = String(question ?? '').toLowerCase();
  if (/\b(or|either)\b/.test(text)) return true;
  if (/\bdan wel\b/.test(text)) return true;

  const words = text.split(/[^a-zÀ-ɏ]+/).filter(Boolean);
  if (!looksDutch(words)) return false;
  return words.some((word, i) => word === 'of' && i > 0 && !DUTCH_WHETHER_VERBS.has(words[i - 1]));
}

/** The question joins alternatives, but the definition has no OR at all. */
export function needsOrRepair(question, spec) {
  return hasDisjunction(question) && spec.conditions.length > 1 && !hasAnyMatch(spec);
}

function parseReply(content) {
  try { return JSON.parse(content); } catch { return null; }
}

/**
 * The conversation sent to the model: system prompt, earlier turns, then the
 * question with the deployment's values in front of it (when there are any).
 */
/**
 * Everything put in front of the question for the model on this turn. Kept as
 * its own value — not just assembled inside the messages — because it is what
 * the conversation store records: an evaluation that cannot see what the model
 * was told cannot say whether the model or the prompt got it wrong.
 */
export function contextFor({ values, located = [], attributes = [], callerContext = '' }) {
  return [callerContext, buildValuesBlock(values), termHint(located), attributesBlock(attributes)]
    .filter(Boolean).join('\n\n');
}

function buildMessages(question, history, context) {
  return [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    { role: 'user', content: context ? `${context}\n\nRequest: ${question}` : question },
  ];
}

/**
 * The reply grammar for this turn: report-only after MAX_CLARIFY_ROUNDS clarifying
 * questions, and widened with the discovered fields the question named.
 */
export function schemaFor(history, extraFieldNames = []) {
  const { response, reportOnly } = buildReplySchemas(extraFieldNames);
  const clarifyRounds = history.filter(h => h.role === 'assistant' && parseReply(h.content)?.kind === 'clarify').length;
  return clarifyRounds >= MAX_CLARIFY_ROUNDS ? reportOnly : response;
}


// A turn is the state of one interpret() call as the repair rounds move it along:
// { raw, reply, timing, repaired }. The context `ctx` is
// { question, model, messages, values, extFields, reportSchema }.


/** The fields every interpret() reply ends with. */
function replyMeta(ctx, turn) {
  // `context` is what the model was told beside the question; `raw` is its
  // last reply. Both go to the conversation store, on every surface.
  // `substituted` says which placeholders the final definition used — "did it
  // write @me when told to" cannot be read off the substituted definition.
  return {
    raw: turn.raw, timing: turn.timing, model: ctx.model, repaired: turn.repaired,
    context: ctx.context ?? '',
    substituted: sentinelsIn(turn.reply?.spec, ctx.substitutions),
  };
}

/** Ask again after the model's last answer, with a correction. Counts as a repair. */
async function askForCorrection(ctx, turn, correction) {
  turn.repaired = true;
  const retry = await chat({
    model: ctx.model,
    // The same grammar the question itself was answered under, so a repair can
    // still name the attributes that question was allowed to name.
    schema: ctx.reportSchema,

    messages: [
      ...ctx.messages,
      { role: 'assistant', content: turn.raw },
      { role: 'user', content: correction },
    ],
  });
  turn.timing = addTiming(turn.timing, retry.timing);
  return { content: retry.content, reply: parseReply(retry.content) };
}

/**
 * One repair round: show the model exactly what the validator rejected.
 *
 * The correction is held to what it was asked: a definition that comes back
 * valid but without a condition no error named is refused, and the original
 * error stands. Asked to fix "Added AND Removed", the model once returned a
 * definition with Removed AND the 90-day window gone — valid, ran, and answered
 * a different question than the one asked. A stated failure beats that.
 */
async function repairInvalidSpec(ctx, turn, result) {
  if (result.ok) return result;
  const retry = await askForCorrection(ctx, turn,
    `That definition has problems:\n- ${result.errors.join('\n- ')}\n`
    + 'Fix only what is listed. Keep every other condition, value, time window and column exactly as it was. '
    + 'Reply with the corrected complete JSON.');
  if (retry.reply?.kind !== 'report') return result;
  const retried = ctx.validate(retry.reply.spec);
  const lost = retried.ok && result.spec ? lostLeaves(result.spec, retried.spec, result.errors) : [];
  if (lost.length) {
    return { ...result, errors: [...result.errors, `the correction dropped what the request asked for: ${lost.join('; ')}`] };
  }
  turn.raw = retry.content;
  turn.reply = retry.reply;
  return retried;
}

/** The most common small-model mistake: "X or Y" compiled as X AND Y. */
async function repairMissingOr(ctx, turn, result) {
  if (!result.ok || !needsOrRepair(ctx.question, result.spec)) return result;
  const retry = await askForCorrection(ctx, turn, OR_REPAIR_MESSAGE);
  const retriedResult = retry.reply?.kind === 'report' ? ctx.validate(retry.reply.spec) : null;
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
  const retriedResult = retry.reply?.kind === 'report' ? ctx.validate(retry.reply.spec) : null;
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
  let result = ctx.validate(turn.reply.spec);
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
  const assumptions = [
    ...(Array.isArray(turn.reply.assumptions) ? turn.reply.assumptions.map(String) : []),
    ...(result.fixes ?? []),
  ];
  const termConfirm = termCheck(ctx, result.spec, assumptions);
  if (termConfirm) {
    return { kind: 'confirm', spec: result.spec, confirm: termConfirm, assumptions, ...replyMeta(ctx, turn) };
  }
  // Named objects ("business role X", "the Sales group") are looked up; a fuzzy match is confirmed by the analyst.
  const { confirm } = await resolveNamedObjects(result.spec, query);
  if (confirm) {
    return { kind: 'confirm', spec: result.spec, confirm, assumptions, ...replyMeta(ctx, turn) };
  }
  const compiled = compileSpec(result.spec, ctx.extFields);
  return {
    kind: 'report',
    spec: result.spec,
    assumptions,
    explanation: explainSpec(result.spec, ctx.extFields),

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
/**
 * @param {object} args
 * @param {string} args.question  what the caller actually typed, and nothing else
 * @param {string} [args.context] facts about THIS caller, prepended for the model
 *                                but kept out of `question` — see below
 * @param {object[]} [args.history]
 * @param {string} [args.model]
 * @param {Map<string, unknown>} [args.substitutions]  placeholder → value, resolved in every
 *                                definition the model produces BEFORE it is validated
 *                                (sentinels.js): `@me` → the caller's account id, `@previous`
 *                                → the ids of the last answer
 */
export async function interpret({ question, context = '', history = [], model = DEFAULT_MODEL, substitutions = new Map() }) {
  // Put the processed system prompt back in the server before asking, in case it
  // restarted since the last question. A hit costs ~0.1 s and saves ~3 minutes; a
  // miss is no worse than asking cold, and leaves the cache saved for next time.
  // Never let this sink the question itself — the model answers either way.
  await ensureWarm().promise.catch(() => {});
  const values = await loadValues();
  const extFields = await loadExtFields();
  // The attributes THIS question names — never the whole set. See extFields.js.
  const attributes = matchQuestionAttributes(question, extFields);
  const extraFieldNames = attributeFieldNames(attributes);
  const schema = schemaFor(history, extraFieldNames);
  // Terms are looked for in the CALLER'S OWN WORDS, never in the context block
  // around them. The Teams bot prepends who is asking — "The person asking this
  // question is Wim van den Heijkant" — and while that was part of `question`,
  // every caller's own name was found as a term in the data. The repair round
  // then told the model it had not used "Wim", and a definition anchored to the
  // caller's account id came back as `Name contains "Wim" OR Name contains
  // "Heijkant"`: a directory-wide report about everyone with a similar name,
  // presented as the answer to "which groups do I own".
  // Names the directory knows, so a first name typed in lower case is still
  // looked up. Server-side only; the model never sees this list.
  const knownNames = await loadKnownNames(query);
  const terms = findTerms(question, values, knownNames);
  const located = terms.length ? await locateTerms(terms, query, values) : [];
  const sent = contextFor({ values, located, attributes, callerContext: context });
  const ctx = {
    question, model, values, located, extFields, substitutions,
    context: sent,
    reportSchema: buildReplySchemas(extraFieldNames).reportOnly,
    messages: buildMessages(question, history, sent),
  };
  // Every definition the model produces — the first and each repair — has its
  // placeholders resolved BEFORE it is validated. Otherwise a model that wrote
  // `@me` exactly as instructed is told that is invalid and sent round again,
  // a full second model call on this hardware, to copy the uuid instead.
  // Validation, with the corrections that need no model round (autofix.js)
  // applied in between: a grouping the request never asked for goes before
  // validation, and a definition validation rejects is corrected and checked
  // once more before a repair round is spent on it. What was corrected rides
  // along as `fixes`, so the answer can say so.
  ctx.validate = (spec) => {
    const grouping = dropUnaskedGrouping(spec, ctx.question);
    const first = validateSpec(substituteValues(grouping.spec, ctx.substitutions), ctx.values, ctx.extFields);
    if (first.ok || !first.spec) return grouping.notes.length ? { ...first, fixes: grouping.notes } : first;
    const fixed = autofixSpec(first.spec);
    if (!fixed.notes.length) return first;
    const again = validateSpec(fixed.spec, ctx.values, ctx.extFields);
    return again.ok ? { ...again, fixes: [...grouping.notes, ...fixed.notes] } : first;
  };

  const first = await chat({ model, messages: ctx.messages, schema });

  const turn = { raw: first.content, reply: parseReply(first.content), timing: first.timing, repaired: false };

  if (turn.reply?.kind === 'report') return answerReport(ctx, turn);
  if (turn.reply?.kind === 'clarify') return answerClarify(ctx, turn);
  // Not about the data, or asking for a change: one sentence, no report.
  if (turn.reply?.kind === 'decline') return { kind: 'decline', reason: String(turn.reply.reason || ''), ...replyMeta(ctx, turn) };
  return { kind: 'error', message: 'The model reply was not valid JSON.', ...replyMeta(ctx, turn) };
}

/**
 * Apply the analyst's answer to a confirmation. A term choice adds (and may drop)
 * conditions, so its result is validated again.
 *
 * Lives here rather than on the route because both front ends need it: the web
 * builder POSTs /nl-reports/resolve, and the Teams bot applies the same choice
 * when a manager picks one of the "did you mean" options out of a card.
 *
 * @returns {object|null} the spec to continue with, or null when the choice does not fit
 */
export function applyResolveChoice(spec, choice, values, extFields) {
  if (!choice) return spec;
  if (choice.kind === 'term') {
    const revalidated = applyTermChoice(spec, choice) ? validateSpec(spec, values, extFields) : null;
    return revalidated?.ok ? revalidated.spec : null;
  }
  return applyChoice(spec, choice) ? spec : null;
}

function formatCell(type, v) {
  if (v === null || v === undefined) return null;
  if (type === 'boolean') return v ? 'Yes' : 'No';
  if (type === 'date') return new Date(v).toISOString().slice(0, 10);
  if (type === 'number') return Number(v);
  return v;
}

/**
 * One result row: the displayed cells, plus the records behind any name list.
 *
 * `_links` is deliberately separate from the cell values rather than replacing
 * them. A name-list cell stays the same readable string it has always been, so
 * exports, the report table and every other consumer are untouched; a caller
 * that wants to make those names clickable — or to ask a follow-up question
 * about them — reads `_links[column]` instead of trying to parse the string
 * back apart, which is not possible when a name itself contains a comma.
 */
function buildRow(r, columns, kind, grouped) {
  // A grouped row is a value with a count, not a record, so it carries no
  // entity: the renderer then offers no detail link, which is right — there is
  // no single record behind "Finance — 42".
  const row = grouped ? {} : { _entity: { kind, id: r.__id } };
  const links = {};
  for (const c of columns) {
    // Read by alias, write by key: a column whose name is too long for a Postgres
    // alias is selected under a short one (see compile.js) — and so is the
    // companion that carries a name list's ids.
    row[c.key] = formatCell(c.type, r[c.alias]);
    const pairs = c.linkKind ? r[c.linksAlias] : null;
    if (pairs?.length) links[c.key] = pairs.map(p => ({ ...p, kind: c.linkKind }));
  }
  if (Object.keys(links).length) row._links = links;
  return row;
}

/**
 * @param {object} rawSpec  a spec (from the model or edited in the UI)
 * @returns {Promise<object>} { ok:false, errors } or the run result
 */
// `substitutions` resolves the caller's placeholder (@me) in a definition that
// still carries it: a saved "my groups" report opened by someone else, or an
// evaluation's expected answer. The bot and the Ask tab hand in definitions
// with the ids already in (interpret() substitutes before validating).
export async function runSpec(rawSpec, substitutions = new Map()) {
  const values = await loadValues();
  const extFields = await loadExtFields();
  const { ok, spec, errors } = validateSpec(substituteValues(rawSpec, substitutions), values, extFields);
  if (!ok) return { ok: false, errors, spec };
  const { confirm } = await resolveNamedObjects(spec, query);
  if (confirm) return { ok: false, errors: [confirm.message], confirm, spec };

  const compiled = compileSpec(spec, extFields);

  const started = Date.now();
  const result = await tx(async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    return client.query(compiled.text, compiled.params);
  });
  const elapsedMs = Date.now() - started;

  const truncated = result.rows.length > spec.limit;
  const kind = ENTITIES[spec.entity].detailKind;
  const rows = result.rows.slice(0, spec.limit).map(r => buildRow(r, compiled.columns, kind, !!spec.groupBy));

  return {
    ok: true,
    spec,
    explanation: explainSpec(spec, extFields),

    columns: compiled.columns.map(({ key, label }) => ({ key, label })),
    rows,
    total: rows.length,
    truncated,
    sql: compiled.text,
    params: compiled.params,
    elapsedMs,
  };
}

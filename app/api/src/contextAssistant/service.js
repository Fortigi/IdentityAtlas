// Context assistant — asking the report generator for search terms.
//
//   interpret()   description (+ conversation) → proposed terms, or a clarifying question
//   suggestMore() description + the terms kept and dropped so far → new terms only
//
// The model's terms go through the same normalisation as terms an analyst types
// (recipe.js), so what the builder shows is what will be searched. Terms made only of
// words that appear in every kind of group name ("users", "beheer") arrive unticked.

import { chat } from '../nlreports/llm.js';
import { createWarmup } from '../nlreports/warmup.js';
import { getReportModel } from '../nlreports/settings.js';
import { DEFAULT_STOPWORDS } from '../contexts/plugins/resource-cluster/tokenize.js';
import { defaultMatchFor, normalizeText, TERM_ORIGINS } from '../contexts/recipe/recipe.js';
import {
  buildContextPrompt, buildMoreTermsMessage, MORE_TERMS_SCHEMA, RESPONSE_SCHEMA, TERMS_ONLY_SCHEMA,
} from './prompt.js';

const MAX_CLARIFY_ROUNDS = 2;

export const { ensureWarm, warmupState } = createWarmup(buildContextPrompt);

function parseReply(content) {
  try { return JSON.parse(content); } catch { return null; }
}

/** True when every word of the term is one that appears in group names of every subject. */
export function isGenericTerm(key) {
  return key.split(' ').every(word => DEFAULT_STOPWORDS.has(word));
}

/**
 * Model terms → recipe terms: normalised, de-duplicated against each other and against
 * `known` (terms already in the builder), generic ones unticked.
 * @param {object[]} raw      the model's terms
 * @param {Set<string>} known normalised keys already present
 */
export function shapeTerms(raw, known = new Set()) {
  const seen = new Set(known);
  const terms = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const key = normalizeText(text);
    if (key.replace(/ /g, '').length < 2 || seen.has(key)) continue;
    seen.add(key);
    const generic = isGenericTerm(key);
    terms.push({
      text,
      match: defaultMatchFor(key),
      state: generic ? 'rejected' : 'accepted',
      origin: TERM_ORIGINS[0],
      why: generic ? 'too generic' : String(item.why || 'related'),
    });
  }
  return terms;
}

/** After MAX_CLARIFY_ROUNDS clarifying questions the model must propose terms. */
export function schemaFor(history) {
  const rounds = history.filter(h => h.role === 'assistant' && parseReply(h.content)?.kind === 'clarify').length;
  return rounds >= MAX_CLARIFY_ROUNDS ? TERMS_ONLY_SCHEMA : RESPONSE_SCHEMA;
}

async function ask(messages, schema) {
  // Put the processed system prompt back in the slot first: the generator may have
  // restarted, or custom reports may have swapped its own prompt in. Never let this
  // sink the question — the model answers either way, only slower.
  await ensureWarm().promise.catch(() => {});
  const model = await getReportModel().catch(() => undefined);
  const { content, timing } = await chat({ model, messages, schema });
  return { raw: content, reply: parseReply(content), timing };
}

function termsAnswer({ raw, reply, timing }, known) {
  return {
    kind: 'terms',
    name: typeof reply.name === 'string' ? reply.name.trim() : '',
    terms: shapeTerms(reply.terms, known),
    notes: Array.isArray(reply.notes) ? reply.notes.map(String) : [],
    raw,
    timing,
  };
}

/**
 * @param {object} args
 * @param {string} args.question
 * @param {{role:'user'|'assistant', content:string}[]} [args.history]
 */
export async function interpret({ question, history = [] }) {
  const messages = [{ role: 'system', content: buildContextPrompt() }, ...history, { role: 'user', content: question }];
  const answer = await ask(messages, schemaFor(history));
  if (answer.reply?.kind === 'terms') return termsAnswer(answer);
  if (answer.reply?.kind === 'clarify') {
    return {
      kind: 'clarify',
      question: String(answer.reply.question || ''),
      options: Array.isArray(answer.reply.options) ? answer.reply.options.map(String) : [],
      raw: answer.raw,
      timing: answer.timing,
    };
  }
  return { kind: 'error', message: 'The model reply was not valid JSON.', raw: answer.raw, timing: answer.timing };
}

/**
 * @param {object} args
 * @param {string} args.question  the original description
 * @param {object} args.recipe    a validated recipe (its terms, kept and dropped)
 */
export async function suggestMore({ question, recipe }) {
  const messages = [
    { role: 'system', content: buildContextPrompt() },
    { role: 'user', content: buildMoreTermsMessage(question, recipe) },
  ];
  const answer = await ask(messages, MORE_TERMS_SCHEMA);
  if (answer.reply?.kind !== 'terms') {
    return { kind: 'error', message: 'The model reply was not valid JSON.', raw: answer.raw, timing: answer.timing };
  }
  return termsAnswer(answer, new Set(recipe.terms.map(x => x.key)));
}

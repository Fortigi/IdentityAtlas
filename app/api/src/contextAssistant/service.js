// Context assistant — asking the report generator for search terms.
//
//   interpret()   description (+ conversation) → proposed terms, or a clarifying question
//   suggestMore() description + the terms kept and dropped so far → new terms only
//
// The model's terms go through the same normalisation as terms an analyst types
// (recipe.js), so what the builder shows is what will be searched. Only terms containing
// the analyst's own words arrive ticked — see shapeTerms().

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

// Words of a request that say nothing about its subject.
const REQUEST_WORDS = new Set([
  'everything', 'anything', 'things', 'related', 'relating', 'about', 'around', 'our', 'their', 'that', 'which', 'who',
  'have', 'has', 'give', 'hand', 'out', 'show', 'find', 'list', 'want', 'need', 'please', 'context', 'process',
  'alle', 'alles', 'rond', 'rondom', 'over', 'onze', 'hun', 'welke', 'die', 'dat', 'wat', 'geef', 'toon', 'zoek',
  'hebben', 'heeft', 'groepen', 'proces',
  'the', 'with', 'and', 'for', 'from', 'into', 'this', 'these', 'those', 'what', 'where', 'there', 'some', 'any', 'only', 'are', 'was', 'can', 'use', 'used',
]);

/**
 * The analyst's own subject words: every word of the request and of their earlier answers
 * that is not generic group-name noise or request phrasing.
 * @param {string} question
 * @param {{role:string, content:string}[]} [history]
 * @returns {string[]}
 */
export function ownWords(question, history = []) {
  const said = [question, ...history.filter(h => h.role === 'user').map(h => h.content)].join(' ');
  const words = normalizeText(said).split(' ')
    .filter(w => w.length >= 3 && !DEFAULT_STOPWORDS.has(w) && !REQUEST_WORDS.has(w));
  return [...new Set(words)];
}

// Two words are the same subject word when they are equal, or — for longer words — share
// their first five letters: "inkoop" / "inkoopproces", "licence" / "licentie" / "license".
const sameWord = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

/** Does a normalised term contain one of the analyst's own words? */
export function containsOwnWord(key, own) {
  return key.split(' ').some(w => own.some(o => sameWord(w, o)));
}

/**
 * Model terms → recipe terms: normalised, de-duplicated against each other and against
 * `known` (terms already in the builder).
 *
 * Only terms that contain the analyst's own words arrive ticked. Everything else the model
 * adds — synonyms, translations, systems, and whatever it invents — arrives unticked, with
 * its hit counts next to it. A small model asked about a name it does not know will still
 * "explain" it (HAMIS became health care); unticked, a wrong guess costs a glance instead of
 * silently pulling in every group with "zorg" in its name. Generic terms stay unticked too.
 *
 * @param {object[]} raw      the model's terms
 * @param {Set<string>} known normalised keys already present
 * @param {string[]} own      ownWords() of the conversation
 */
export function shapeTerms(raw, known = new Set(), own = []) {
  const seen = new Set(known);
  const terms = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const key = normalizeText(text);
    if (key.replace(/ /g, '').length < 2 || seen.has(key)) continue;
    seen.add(key);
    const generic = isGenericTerm(key);
    const mine = !generic && containsOwnWord(key, own);
    terms.push({
      text,
      match: defaultMatchFor(key),
      state: mine ? 'accepted' : 'rejected',
      origin: TERM_ORIGINS[0],
      own: mine,
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

function termsAnswer({ raw, reply, timing }, known, own) {
  return {
    kind: 'terms',
    name: typeof reply.name === 'string' ? reply.name.trim() : '',
    terms: shapeTerms(reply.terms, known, own),
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
  if (answer.reply?.kind === 'terms') return termsAnswer(answer, new Set(), ownWords(question, history));
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
  return termsAnswer(answer, new Set(recipe.terms.map(x => x.key)), ownWords(question));
}

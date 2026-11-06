// Context interviews — what a claim is, and the one check every claim passes.
//
//   checkClaim(raw, transcript) → { claim, repaired? } | { error, reason, field }
//
// Used for a model's reply (extract.js) and for a claim an analyst adds by hand
// (the manual "Add claim" form), so both obey the same rules:
//
//   - claimKind is one of CLAIM_KINDS; value is a non-empty sentence (≤ MAX_VALUE);
//   - a description or a property is about the context itself: it has no subject;
//   - a property names its attribute (a short key, ≤ MAX_ATTRIBUTE, no control characters);
//   - a role / roleHistory names its relation (RELATIONS; anything else reads 'other');
//   - a membership names the person and its status (MEMBERSHIP_STATUSES: current,
//     former, joined, left, rejoined — was in it before, left, and is back), kept in
//     `attribute` as a role's relation is;
//   - an alias is another name of the context ("also known as X"): no subject, the
//     name as value (≤ MAX_ALIAS);
//   - the quote, when there is one, is VERBATIM in the transcript — compared after
//     folding whitespace and typographic quotes — or the claim is dropped (reason
//     'quote'): a claim must rest on words that were said. A NEAR-verbatim quote
//     (only case, punctuation or spacing differ) is kept as the transcript has it;
//     different words are never a match;
//   - a period is from / to (a year, a year-month or a date; anything else is
//     kept only as text) and the text as spoken ("early years").
//   - an activity / expertise / duty names the person and, as value, the name of
//     what they do, know or hold (≤ MAX_OBJECT_NAME): "Handle claims", not a sentence;
// Confidence is clamped to 0..1 (default 0.5). relevance is the model's 'high' |
// 'low' when it gave one (relevance.js decides the final tier).
//
// With { repair: true } (a model's reply — a small model leaves fields out) what
// can be recovered without guessing is: a property without a usable attribute
// name becomes a description claim; a claim without a value takes its quote as
// the value; a membership whose value is its status alone ("left") takes that
// status. A role without its person, an unknown kind or a missing quote is
// still dropped. Every drop names the field it failed on (`field`). Pure.

import { KNOWLEDGE_KINDS, isKnowledgeKind, MAX_OBJECT_NAME } from '../../lib/orgKnowledge.js';

// The last three (migration 106, lib/orgKnowledge.js): what a person does, knows,
// and which duty they hold — each a name of its object, about one person.
export const CLAIM_KINDS = Object.freeze(['description', 'property', 'role', 'roleHistory', 'membership', 'alias', ...KNOWLEDGE_KINDS]);
// A membership claim's status, in `attribute`: is the person in it now, did they leave?
// 'rejoined': was in it before, left, and is in it again. A code list, not a CHECK.
export const MEMBERSHIP_STATUSES = Object.freeze(['current', 'former', 'joined', 'left', 'rejoined']);
// How much a claim matters for identity and access governance (relevance.js).
export const RELEVANCE = Object.freeze(['high', 'low']);
export const RELATIONS = Object.freeze(['owner', 'notOwner', 'dayToDay', 'delegate', 'member', 'other']);
export const CLAIM_STATUSES = Object.freeze(['proposed', 'confirmed', 'rejected', 'edited']);
// What a reader without write access to contexts sees (a context owner too): decided claims only.
export const READER_STATUSES = Object.freeze(['confirmed', 'edited']);
/** The claim statuses a reader may see: a writer sees the proposed ones too. Pure. */
export const visibleClaimStatuses = (canWrite) => (canWrite ? ['proposed', ...READER_STATUSES] : [...READER_STATUSES]);
export const ROLE_SUGGESTIONS = Object.freeze(['Accountable', 'Responsible']);

// The kinds whose subject is the context itself.
const CONTEXT_KINDS = new Set(['description', 'property', 'alias']);

export const MAX_VALUE = 2000;
export const MAX_ATTRIBUTE = 80;
export const MAX_SUBJECT = 200;
// An alias is a name, not a sentence.
export const MAX_ALIAS = 200;
export const MAX_PERIOD_TEXT = 120;
// Shorter than this a "quote" ("yes", "ok") proves nothing.
export const MIN_QUOTE = 8;
export const MAX_QUOTE = 1000;

const QUOTES = /[‘’‚‛′]/g;
const DOUBLE_QUOTES = /[“”„‟″]/g;
const STRAIGHT_MARKS = "'\"";
const QUOTE_MARKS = "'\"“”‘’";

/** s without the quote marks (any of `marks`) it starts or ends with. Linear, by index — no regex backtracking on a long run of marks. */
export function stripQuoteMarks(s, marks = QUOTE_MARKS) {
  let a = 0;
  let b = s.length;
  while (a < b && marks.includes(s[a])) a++;
  while (b > a && marks.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/** The form two copies of one span share: NFC, straight quotes, whitespace folded. */
export function foldForQuote(s) {
  return String(s ?? '').normalize('NFC').replace(QUOTES, "'").replace(DOUBLE_QUOTES, '"').replace(/\s+/g, ' ').trim();
}

/**
 * The quote as it stands in the transcript (folded), or null when it is not
 * there. Leading / trailing quote marks a model adds around a quote are ignored.
 * `folded` is foldForQuote(transcript), passed in so a reply of 20 claims folds
 * the transcript once.
 */
export function verbatimQuote(quote, folded) {
  const q = stripQuoteMarks(foldForQuote(quote), STRAIGHT_MARKS).trim();
  if (q.length < MIN_QUOTE || q.length > MAX_QUOTE) return null;
  return folded.includes(q) ? q : nearVerbatim(q, folded);
}

// The loose form: letters and digits lowercased, every run of anything else one
// space; map[k] is the index in the input of loose character k.
function looseForm(s) {
  let text = '';
  const map = [];
  let gap = true;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/[\p{L}\p{N}]/u.test(ch)) {
      for (const low of ch.toLowerCase()) { text += low; map.push(i); }
      gap = false;
    } else if (!gap) {
      text += ' ';
      map.push(i);
      gap = true;
    }
  }
  return { text, map };
}

// One transcript is checked against many claims in a row: keep its loose form.
let cached = { folded: null, loose: null };
const looseOf = (folded) => {
  if (cached.folded !== folded) cached = { folded, loose: looseForm(folded) };
  return cached.loose;
};

/**
 * The transcript's own words for a quote that differs from them only in case,
 * punctuation or spacing ('i am the owner' for 'I am the owner,'), or null.
 */
export function nearVerbatim(quote, folded) {
  const q = looseForm(quote).text.trim();
  if (q.length < MIN_QUOTE) return null;
  const loose = looseOf(folded);
  const at = loose.text.indexOf(q);
  if (at < 0) return null;
  return folded.slice(loose.map[at], loose.map[at + q.length - 1] + 1);
}

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * '2019' | '2019-03' | '2019-03-14' → an ISO date: the first day of the period
 * for a start, the last day for an end. Anything else (or an impossible date) → null.
 */
export function periodDate(value, end = false) {
  const parts = String(value ?? '').trim().split('-');
  if (parts.length > 3 || !/^\d{4}$/.test(parts[0]) || parts.slice(1).some(p => !/^\d{1,2}$/.test(p))) return null;
  const y = Number(parts[0]);
  const month = parts[1] ? Number(parts[1]) : (end ? 12 : 1);
  if (month < 1 || month > 12) return null;
  const day = parts[2] ? Number(parts[2]) : (end ? lastDay(y, month) : 1);
  if (day < 1 || day > lastDay(y, month)) return null;
  return `${y}-${pad(month)}-${pad(day)}`;
}

const text = (v, max) => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

const CONTROL = /[\u0000-\u001f\u007f]/;
const PERSON_KINDS = new Set(['role', 'roleHistory', 'membership', ...KNOWLEDGE_KINDS]);

const attributeName = (v) => {
  const key = text(v, MAX_ATTRIBUTE + 1);
  return key && key.length <= MAX_ATTRIBUTE && !CONTROL.test(v) ? key : null;
};

function checkAttribute(kind, raw) {
  if (kind === 'property') {
    const key = attributeName(raw.attribute);
    return key ? { attribute: key } : { error: 'a property claim needs an attribute name (at most 80 characters)' };
  }
  if (kind === 'membership') {
    return MEMBERSHIP_STATUSES.includes(raw.membership)
      ? { attribute: raw.membership }
      : { error: `a membership claim needs its status: ${MEMBERSHIP_STATUSES.join(', ')}`, field: 'membership' };
  }
  if (isKnowledgeKind(kind)) return { attribute: null };
  if (PERSON_KINDS.has(kind)) return { attribute: RELATIONS.includes(raw.relation) ? raw.relation : 'other' };
  return { attribute: null };
}

function confidenceOf(v) {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return 0.5;
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

function checkQuote(raw, folded, required) {
  if (raw == null || raw === '') return required ? { error: 'a claim needs the quote it rests on' } : { quote: null };
  const quote = verbatimQuote(raw, folded);
  return quote ? { quote } : { error: 'the quote is not a verbatim part of the transcript' };
}

/**
 * A model's claim with a field left out, made whole where that needs no guess:
 * a property without a usable attribute name is a description; a claim without
 * a value takes its quote. `repaired` collects the fields filled. Pure.
 */
export function repairClaim(raw, repaired = []) {
  let out = raw;
  if (raw.kind === 'property' && !attributeName(raw.attribute)) {
    out = { ...out, kind: 'description' };
    repaired.push('attribute');
  }
  // A membership whose value is its status alone ("left") says the status.
  const said = typeof raw.value === 'string' ? raw.value.trim().toLowerCase() : '';
  if (raw.kind === 'membership' && !MEMBERSHIP_STATUSES.includes(raw.membership) && MEMBERSHIP_STATUSES.includes(said)) {
    out = { ...out, membership: said };
    repaired.push('membership');
  }
  const quote = typeof raw.quote === 'string' ? stripQuoteMarks(raw.quote.trim()) : '';
  if (!text(raw.value, MAX_VALUE) && text(quote, MAX_VALUE)) {
    out = { ...out, value: quote };
    repaired.push('value');
  }
  return out;
}

const drop = (field, error, reason = 'invalid') => ({ error, reason, field });

/**
 * @param raw         { kind, value, subject?, attribute?, relation?, periodFrom?, periodTo?, periodText?, quote?, confidence? }
 * @param folded      foldForQuote(transcript)
 * @param opts.quoteRequired  a model's claim must carry a quote; an analyst's may not
 * @param opts.repair         fill what a model left out where that needs no guess (repairClaim)
 */
// The fields every claim of its kind must have: { value, subject, attribute } or a drop.
function checkFields(raw) {
  const kind = raw.kind;
  const value = text(raw.value, MAX_VALUE);
  if (!value) return drop('value', 'a claim needs a value');
  const subject = CONTEXT_KINDS.has(kind) ? null : text(raw.subject, MAX_SUBJECT);
  if (PERSON_KINDS.has(kind) && !subject) return drop('subject', 'a role claim needs the person it is about');
  const attr = checkAttribute(kind, raw);
  if (attr.error) return drop(attr.field ?? 'attribute', attr.error);
  if (kind === 'alias' && value.length > MAX_ALIAS) return drop('value', `an alias is a name of at most ${MAX_ALIAS} characters`);
  if (isKnowledgeKind(kind) && value.length > MAX_OBJECT_NAME) return drop('value', `an ${kind} is a name of at most ${MAX_OBJECT_NAME} characters`);
  return { value, subject, attribute: attr.attribute };
}

export function checkClaim(input, folded, { quoteRequired = true, repair = false } = {}) {
  if (!input || typeof input !== 'object') return drop('claim', 'a claim must be an object');
  if (!CLAIM_KINDS.includes(input.kind)) return drop('kind', `kind must be one of ${CLAIM_KINDS.join(', ')}`);
  const repaired = [];
  const raw = repair ? repairClaim(input, repaired) : input;
  const kind = raw.kind;
  const fields = checkFields(raw);
  if (fields.error) return fields;
  const { value, subject, attribute } = fields;
  const { quote, error } = checkQuote(raw.quote, folded, quoteRequired);
  if (error) return drop('quote', error, 'quote');

  const claim = {
    claimKind: kind,
    subjectKind: subject ? 'Person' : 'Context',
    subjectName: subject,
    attribute,
    value,
    periodFrom: periodDate(raw.periodFrom),
    periodTo: periodDate(raw.periodTo, true),
    periodText: text(raw.periodText, MAX_PERIOD_TEXT),
    quote,
    confidence: confidenceOf(raw.confidence),
    relevance: RELEVANCE.includes(raw.relevance) ? raw.relevance : null,
  };
  return repaired.length ? { claim, repaired } : { claim };
}

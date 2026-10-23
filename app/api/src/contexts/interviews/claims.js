// Context interviews — what a claim is, and the one check every claim passes.
//
//   checkClaim(raw, transcript) → { claim } | { error, reason }
//
// Used for a model's reply (extract.js) and for a claim an analyst adds by hand
// (the manual "Add claim" form), so both obey the same rules:
//
//   - claimKind is one of CLAIM_KINDS; value is a non-empty sentence (≤ MAX_VALUE);
//   - a description or a property is about the context itself: it has no subject;
//   - a property names its attribute (a short key, ≤ MAX_ATTRIBUTE, no control characters);
//   - a role / roleHistory names its relation (RELATIONS; anything else reads 'other');
//   - the quote, when there is one, is VERBATIM in the transcript — compared after
//     folding whitespace and typographic quotes, nothing more — or the claim is
//     dropped (reason 'quote'): a claim must rest on words that were said;
//   - a period is from / to (a year, a year-month or a date; anything else is
//     kept only as text) and the text as spoken ("early years").
// Confidence is clamped to 0..1 (default 0.5). Pure.

export const CLAIM_KINDS = Object.freeze(['description', 'property', 'role', 'roleHistory']);
export const RELATIONS = Object.freeze(['owner', 'notOwner', 'dayToDay', 'delegate', 'member', 'other']);
export const CLAIM_STATUSES = Object.freeze(['proposed', 'confirmed', 'rejected', 'edited']);
export const ROLE_SUGGESTIONS = Object.freeze(['Accountable', 'Responsible']);

// The kinds whose subject is the context itself.
const CONTEXT_KINDS = new Set(['description', 'property']);

export const MAX_VALUE = 2000;
export const MAX_ATTRIBUTE = 80;
export const MAX_SUBJECT = 200;
export const MAX_PERIOD_TEXT = 120;
// Shorter than this a "quote" ("yes", "ok") proves nothing.
export const MIN_QUOTE = 8;
export const MAX_QUOTE = 1000;

const QUOTES = /[‘’‚‛′]/g;
const DOUBLE_QUOTES = /[“”„‟″]/g;

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
  const q = foldForQuote(quote).replace(/^["']+|["']+$/g, '').trim();
  if (q.length < MIN_QUOTE || q.length > MAX_QUOTE) return null;
  return folded.includes(q) ? q : null;
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

function checkAttribute(kind, raw) {
  if (kind === 'property') {
    const key = text(raw.attribute, MAX_ATTRIBUTE + 1);
    if (!key || key.length > MAX_ATTRIBUTE || CONTROL.test(raw.attribute)) return { error: 'a property claim needs an attribute name (at most 80 characters)' };
    return { attribute: key };
  }
  if (kind === 'role' || kind === 'roleHistory') return { attribute: RELATIONS.includes(raw.relation) ? raw.relation : 'other' };
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
 * @param raw         { kind, value, subject?, attribute?, relation?, periodFrom?, periodTo?, periodText?, quote?, confidence? }
 * @param folded      foldForQuote(transcript)
 * @param opts.quoteRequired  a model's claim must carry a quote; an analyst's may not
 */
export function checkClaim(raw, folded, { quoteRequired = true } = {}) {
  if (!raw || typeof raw !== 'object') return { error: 'a claim must be an object', reason: 'invalid' };
  const kind = raw.kind;
  if (!CLAIM_KINDS.includes(kind)) return { error: `kind must be one of ${CLAIM_KINDS.join(', ')}`, reason: 'invalid' };
  const value = text(raw.value, MAX_VALUE);
  if (!value) return { error: 'a claim needs a value', reason: 'invalid' };
  const subject = CONTEXT_KINDS.has(kind) ? null : text(raw.subject, MAX_SUBJECT);
  if ((kind === 'role' || kind === 'roleHistory') && !subject) return { error: 'a role claim needs the person it is about', reason: 'invalid' };
  const attr = checkAttribute(kind, raw);
  if (attr.error) return { error: attr.error, reason: 'invalid' };
  const { quote, error } = checkQuote(raw.quote, folded, quoteRequired);
  if (error) return { error, reason: 'quote' };

  return {
    claim: {
      claimKind: kind,
      subjectKind: subject ? 'Person' : 'Context',
      subjectName: subject,
      attribute: attr.attribute,
      value,
      periodFrom: periodDate(raw.periodFrom),
      periodTo: periodDate(raw.periodTo, true),
      periodText: text(raw.periodText, MAX_PERIOD_TEXT),
      quote,
      confidence: confidenceOf(raw.confidence),
    },
  };
}

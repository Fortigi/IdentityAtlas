// Organisation truth — one link signal, evaluated (owned by workstream T2).
//
// Pure, no DB. A signal compares one org value (the entity's displayName or
// one of its attributes) with one field of one system row. Four types, the
// ones contracts.js SIGNAL_TYPES names:
//
//   exact   norm(org) === norm(target)            trim, casefold, collapse whitespace
//   prefix  the email local parts match once known admin/ext prefixes ("adm-",
//           "ext_", … from accountlinking/defaultRules.js) are stripped
//   name    graded person-name match: 'full' earns the whole weight,
//           'surnameInitial' 75 % of it, anything else nothing
//   token   every token (≥ 2 chars) of the org value is a token of the target
//   fuzzy   name similarity (fuzzySimilarity below) ≥ 0.5 earns weight × similarity
//
// Every type also has index keys (`signalKeys`, the same function for a target
// value and an org value) so candidates.js can build a Map per signal and
// score.js only evaluates plausible rows.
//
// DECISION (T2): the prefix signal strips the known prefixes on BOTH sides.
// The handover describes the org side ("adm-jdoe@" ↔ "jdoe@"); the reverse
// ("jdoe@" in the list, only "adm-jdoe@" synced) is the same person, and an
// exact signal still separates the two when both exist.
// DECISION (T2): the name index is keyed on the parsed SURNAME, not on
// parseName().key (surname|given). A key index can never find the
// surname+initial level ("J. Doe" ↔ "Jane Doe"), which the signal grades.
import {
  emailLocalPart, stripKnownPrefixes, parseName, nameMatchLevel,
} from '../../accountlinking/classifier.js';
import { DEFAULT_RULES } from '../../accountlinking/defaultRules.js';
import { NAME_ATTRIBUTE } from '../contracts.js';

export const DEFAULT_PREFIXES = Object.freeze(
  (DEFAULT_RULES.signals || []).find(s => s.type === 'prefix')?.stripPrefixes || [],
);

export const SURNAME_INITIAL_FACTOR = 0.75;
export const MIN_TOKEN_LENGTH = 2;

/** Trim, casefold, collapse inner whitespace. null/undefined → ''. */
export function normValue(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Tokens of a value (split on anything not a letter or digit), ≥ 2 chars. */
export function tokensOf(v) {
  return normValue(v).split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= MIN_TOKEN_LENGTH);
}

/** The comparable local part for the prefix signal. */
export function prefixKey(v, prefixes = DEFAULT_PREFIXES) {
  return stripKnownPrefixes(emailLocalPart(normValue(v)), prefixes);
}

/** The org value a signal reads: the entity's own name or one attribute. Empty → ''. */
export function orgValueOf(entity, attribute) {
  const raw = attribute === NAME_ATTRIBUTE ? entity?.displayName : entity?.attributes?.[attribute];
  return raw == null ? '' : String(raw).trim();
}

/**
 * Keys a value is indexed (target) or looked up (org) under for a signal type.
 * For `token` these are the value's tokens: the caller unions the postings of
 * the org tokens and the evaluation keeps only rows holding every one.
 */
export function signalKeys(type, value) {
  if (!normValue(value)) return [];
  switch (type) {
    case 'exact': return [normValue(value)];
    case 'prefix': return nonEmpty([prefixKey(value)]);
    case 'name': return nonEmpty([parseName(value).surname]);
    case 'token': return [...new Set(tokensOf(value))];
    case 'fuzzy': return fuzzyKeys(value);
    default: return [];
  }
}

// ─── fuzzy ───────────────────────────────────────────────────────────────
// Organisation names are written many ways: "ABN AMRO" / "ABN AMRO Bank N.V.",
// "Gemeente Vught" / "Vught", a typo. Legal forms and noise words are dropped,
// accents folded, then two measures, the higher wins:
//   bigrams    Dice coefficient of the character bigrams of the joined names,
//              counted only from DICE_MIN up ("_Intern" / "Interxion" share
//              letters, not a meaning)
//   contained  every word of the shorter name is a word of the longer (0.9),
//              scaled down a little per extra word in the longer name
//   shared     the names share a distinctive word (≥ 5 letters, not noise):
//              SHARED_WORD — under a usual threshold, so the pair is PROPOSED
//              for review ("Havenbedrijf Rotterdam" / "PortOfRotterdam")
export const FUZZY_FLOOR = 0.5;
export const DICE_MIN = 0.7;
export const SHARED_WORD = 0.5;
const NOISE = new Set(['bv', 'nv', 'vof', 'cv', 'holding', 'groep', 'group', 'ltd', 'inc', 'gmbh', 'ag', 'sa', 'se', 'plc', 'llc', 'the', 'de', 'het', 'en', 'and', 'of', 'van', 'b', 'v', 'n']);

/** The comparable words of a name: camelCase split, lowercase, accents folded, legal forms and noise dropped. */
export function fuzzyWords(v) {
  const split = String(v ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const folded = normValue(split).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const words = folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const kept = words.filter(w => !NOISE.has(w));
  return kept.length > 0 ? kept : words;
}

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let shared = 0;
  for (const [g, n] of A) shared += Math.min(n, B.get(g) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

function contained(wa, wb) {
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const have = new Set(long);
  if (short.length === 0 || !short.every(w => have.has(w))) return 0;
  return Math.max(0.6, 0.9 - 0.05 * (long.length - short.length));
}

/** Similarity of two names, 0..1. */
export function fuzzySimilarity(a, b) {
  const wa = fuzzyWords(a);
  const wb = fuzzyWords(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const ja = wa.join('');
  const jb = wb.join('');
  if (ja === jb) return 1;
  const d = dice(ja, jb);
  return Math.max(d >= DICE_MIN ? d : 0, contained(wa, wb), sharesDistinctiveWord(wa, wb) ? SHARED_WORD : 0);
}

function sharesDistinctiveWord(wa, wb) {
  const have = new Set(wb.filter(w => w.length >= 5));
  return wa.some(w => w.length >= 5 && have.has(w));
}

// Index keys: every word and its first three letters, so a name sharing one
// word (or a typo past the third letter) is at least a candidate.
function fuzzyKeys(value) {
  const keys = new Set();
  for (const w of fuzzyWords(value)) {
    if (w.length >= 2) keys.add(w);
    if (w.length > 3) keys.add(w.slice(0, 3));
  }
  return [...keys];
}

/**
 * The weight a signal earns for one org value against one target value:
 * 0 (no match), the full weight, or (name, surname + initial) 75 % of it.
 */
export function evaluateSignal(signal, orgValue, targetValue) {
  const o = normValue(orgValue);
  const t = normValue(targetValue);
  if (!o || !t) return 0;
  switch (signal.type) {
    case 'exact': return o === t ? signal.weight : 0;
    case 'prefix': return prefixMatches(o, t) ? signal.weight : 0;
    case 'name': return nameWeight(signal.weight, o, t);
    case 'token': return tokensMatch(o, t) ? signal.weight : 0;
    // the raw values: fuzzyWords splits camelCase ("PortOfRotterdam") before it lowercases
    case 'fuzzy': return fuzzyWeight(signal.weight, orgValue, targetValue);
    default: return 0;
  }
}

function prefixMatches(o, t) {
  const a = prefixKey(o);
  return a !== '' && a === prefixKey(t);
}

function nameWeight(weight, o, t) {
  const level = nameMatchLevel(parseName(o), parseName(t));
  if (level === 'full') return weight;
  if (level === 'surnameInitial') return Math.round(weight * SURNAME_INITIAL_FACTOR);
  return 0;
}

function fuzzyWeight(weight, o, t) {
  const sim = fuzzySimilarity(o, t);
  return sim >= FUZZY_FLOOR ? Math.round(weight * sim) : 0;
}

function tokensMatch(o, t) {
  const need = tokensOf(o);
  if (need.length === 0) return false;
  const have = new Set(tokensOf(t));
  return need.every(tok => have.has(tok));
}

function nonEmpty(keys) {
  return keys.filter(Boolean);
}

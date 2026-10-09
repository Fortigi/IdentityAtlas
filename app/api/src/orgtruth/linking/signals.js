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
    default: return [];
  }
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

function tokensMatch(o, t) {
  const need = tokensOf(o);
  if (need.length === 0) return false;
  const have = new Set(tokensOf(t));
  return need.every(tok => have.has(tok));
}

function nonEmpty(keys) {
  return keys.filter(Boolean);
}

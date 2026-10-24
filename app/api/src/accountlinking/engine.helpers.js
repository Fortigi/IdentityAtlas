// Identity Atlas — Account Linking engine, pure helpers.
//
// Dependency-light, DB-free helpers factored out of engine.js so the linking
// engine's top-level functions stay small and flat. Everything here is pure
// (no DB, no side effects) and unit-tested directly in engine.helpers.test.js.

import {
  normalizeName,
  emailLocalPart,
  stripKnownPrefixes,
  nameVariants,
} from './classifier.js';
import { parseJsonbColumn } from '../lib/jsonb.js';

/** Normalise any scalar to a trimmed, lower-cased comparison token. */
export const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

/** givenName + surname joined and normalised (optionally stripping suffixes). */
export const fullName = (o, suffixes = []) =>
  normalizeName([o.givenName, o.surname].filter(Boolean).join(' '), suffixes);

/** Every comparable name a principal/identity row is known by. */
export const personNames = (o) => nameVariants(o.displayName, o.givenName, o.surname);

/**
 * The name keys a person is indexed under, each once, mapped to how they are
 * known by that name (`'inUse'` or `'birth'` — see `nameVariants`).
 *
 * Two of their names can collapse onto one key (the key sorts its halves, so a
 * display name recorded `Surname Given` yields the same key as the columns) —
 * listed twice, the person fills a key bucket on their own and can never be its
 * sole match. Where that happens the stronger of the two variants is kept: a
 * key the person is in-use known by is not also a birth name. The keys are
 * collected first and ranked after, so that holds whichever order the person's
 * names come in.
 *
 * @returns {Map<string, 'inUse'|'birth'>}
 */
export function nameKeyVariants(o) {
  const named = personNames(o).filter(v => v.key);
  const inUse = new Set(named.filter(v => v.variant === 'inUse').map(v => v.key));
  return new Map(named.map(v => [v.key, inUse.has(v.key) ? 'inUse' : 'birth']));
}

/** The name keys a person is indexed under, each once. */
export const nameKeys = (o) => [...nameKeyVariants(o).keys()];

export function prefixesFrom(rules) {
  return (rules.signals || []).find(s => s.type === 'prefix')?.stripPrefixes || [];
}
export function suffixesFrom(rules) {
  return (rules.signals || []).find(s => s.type === 'fuzzy')?.stripSuffixes || [];
}
/**
 * The names of every signal that is a name match and nothing else. `fuzzy` is
 * included: it is the legacy single-signal name comparison, so a match resting
 * only on it is just as uncorroborated as one resting on `fullName`.
 */
export function nameSignalNames(rules) {
  return new Set((rules.signals || [])
    .filter(s => s.type === 'name' || s.type === 'fuzzy')
    .map(s => s.name));
}

/** True when a match fired at least one signal and every one of them is a name signal. */
export function isNameOnly(signals, nameSigs) {
  return signals.length > 0 && signals.every(s => nameSigs.has(s));
}

/**
 * The signal names recorded on a stored `IdentityMembers.linkSignals` value.
 *
 * The column is JSONB holding a JSON *string* of comma-separated names, so
 * node-postgres hands back the bare CSV (`fullName`, `email,fullName`) — which
 * is not itself valid JSON. Accept that, a legacy double-encoded string, and a
 * JSON array, and return [] for anything else.
 * @returns {string[]}
 */
export function parseLinkSignals(stored) {
  const value = typeof stored === 'string' ? (parseJsonbColumn(stored) ?? stored) : parseJsonbColumn(stored);
  const csv = Array.isArray(value) ? value.join(',') : value;
  if (typeof csv !== 'string') return [];
  return csv.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Index identities so buildLinks only scores plausible candidates per orphan.
 * @returns {{ byEmployeeId: Map, byEmailLocal: Map, byName: Map, byNameKey: Map }}
 */
export function indexIdentities(identities) {
  const byEmployeeId = new Map();
  const byEmailLocal = new Map();
  const byName = new Map();
  const byNameKey = new Map();
  const push = (map, key, v) => { if (!key) return; (map.get(key) || map.set(key, []).get(key)).push(v); };
  for (const idy of identities) {
    push(byEmployeeId, norm(idy.employeeId), idy);
    push(byEmailLocal, emailLocalPart(idy.email), idy);
    push(byName, normalizeName(idy.displayName) || fullName(idy), idy);
    for (const key of nameKeys(idy)) push(byNameKey, key, idy);
  }
  return { byEmployeeId, byEmailLocal, byName, byNameKey };
}

/**
 * All identities plausibly matching an orphan, deduped by identity id.
 * @returns {Map<string, object>}
 */
export function collectCandidates(orphan, indexes, { prefixes, suffixes }) {
  const { byEmployeeId, byEmailLocal, byName, byNameKey } = indexes;
  const candidates = new Map();
  const addAll = (arr) => { for (const idy of (arr || [])) candidates.set(idy.id, idy); };
  addAll(byEmployeeId.get(norm(orphan.employeeId)));
  addAll(byEmailLocal.get(emailLocalPart(orphan.email)));
  addAll(byEmailLocal.get(stripKnownPrefixes(emailLocalPart(orphan.email), prefixes)));
  addAll(byName.get(normalizeName(orphan.displayName, suffixes) || fullName(orphan, suffixes)));
  for (const key of nameKeys(orphan)) addAll(byNameKey.get(key));
  return candidates;
}

/**
 * The identities with the strongest claim to one name key, among those matching
 * it at all.
 *
 * A match is only as strong as its weaker side: it is a match on the name in use
 * when the account *and* the identity are both spelled that way under this key,
 * and a birth-name match when either side holds it only in a structured column.
 * Accounts are provisioned from the name in use, so where both kinds meet under
 * one key the name in use wins outright and the birth-name match is not a rival:
 * `Anna Jansen`'s account belongs to the Anna Jansen, not to the Anna de
 * Boer-Jansen whose HR record still carries `Jansen` in its surname column.
 * Equally strong matches tie, which is the namesake case that goes to review.
 *
 * @param {object[]} underKey  the candidate identities matching this key
 * @param {string} key  the name key being weighed
 * @param {'inUse'|'birth'} carried  how the account itself carries that key
 */
function strongestClaims(underKey, key, carried) {
  if (carried !== 'inUse') return underKey;
  const inUse = underKey.filter(idy => nameKeyVariants(idy).get(key) === 'inUse');
  return inUse.length ? inUse : underKey;
}

/**
 * Break a tie between equally-scoring candidates **per name key**, or decline.
 *
 * A person is indexed under every name they are known by — their name in use
 * and the birth surname an HR column holds — so a name tie is not one question
 * but one per name. The tie resolves when exactly one of the tied identities has
 * the strongest claim to some name the account carries: two people who share
 * only a birth surname then do not block the match that is unique on the name in
 * use. It stays unresolved (and the account goes to review) when no name singles
 * anyone out, or when different names single out different people.
 *
 * @param {object} orphan  the account being placed
 * @param {Array<{identityId: string}>} tied  the equally-scoring top candidates
 * @param {Map<string, object[]>} byNameKey  the name-key index
 * @returns {object|null} the winning candidate, or null if still ambiguous
 */
export function resolveNameTie(orphan, tied, byNameKey) {
  const tiedIds = new Set(tied.map(c => c.identityId));
  const soleMatches = new Set();
  for (const [key, carried] of nameKeyVariants(orphan)) {
    const underKey = (byNameKey.get(key) || []).filter(idy => tiedIds.has(idy.id));
    const claimants = strongestClaims(underKey, key, carried);
    if (claimants.length === 1) soleMatches.add(claimants[0].id);
  }
  if (soleMatches.size !== 1) return null;
  const [winner] = soleMatches;
  return tied.find(c => c.identityId === winner);
}

/**
 * Per-identity rollup of newly-built links: best confidence + union of signals.
 * @returns {Map<string, { conf: number, signals: Set<string> }>}
 */
export function aggregateByIdentity(links) {
  const byIdentity = new Map();
  for (const l of links) {
    const g = byIdentity.get(l.identityId) || { conf: 0, signals: new Set() };
    g.conf = Math.max(g.conf, l.confidence);
    for (const s of l.signals) g.signals.add(s);
    byIdentity.set(l.identityId, g);
  }
  return byIdentity;
}

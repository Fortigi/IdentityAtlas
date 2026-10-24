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
 * The two keys one parsed name is indexed under — one per level the engine
 * scores a name at (see `nameMatchLevel`):
 *   exact   — surname + given name, order-independent: who is spelled this name
 *   initial — surname + given initial: who is spelled a near-identical name
 * Both are empty for a name that can never match (no surname, or no given name).
 */
const EXACT_KEY = (v) => v.key;
const INITIAL_KEY = (v) => (v.surname && v.initial ? `${v.surname}|${v.initial}` : '');

/**
 * The keys a person is indexed under for one keying function, each once, mapped
 * to how they are known by that name (`'inUse'` or `'birth'` — see
 * `nameVariants`).
 *
 * Two of their names can collapse onto one key (the exact key sorts its halves,
 * so a display name recorded `Surname Given` yields the same key as the columns;
 * an initial key collapses every given name sharing an initial) — listed twice,
 * the person fills a key bucket on their own and can never be its sole match.
 * Where that happens the stronger of the two variants is kept: a key the person
 * is in-use known by is not also a birth name. The keys are collected first and
 * ranked after, so that holds whichever order the person's names come in.
 *
 * @returns {Map<string, 'inUse'|'birth'>}
 */
function keyVariants(o, keyOf) {
  const named = personNames(o).map(v => ({ key: keyOf(v), variant: v.variant })).filter(v => v.key);
  const inUse = new Set(named.filter(v => v.variant === 'inUse').map(v => v.key));
  return new Map(named.map(v => [v.key, inUse.has(v.key) ? 'inUse' : 'birth']));
}

/** How the person is known by each exact (surname + given name) key. */
export const nameKeyVariants = (o) => keyVariants(o, EXACT_KEY);

/** How the person is known by each near-identical (surname + given initial) key. */
export const nameInitialVariants = (o) => keyVariants(o, INITIAL_KEY);

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
 * Index identities so buildLinks only scores plausible candidates per orphan,
 * and so the name-uniqueness guard can ask who else answers to a name.
 *
 * `bySurnameInitial` is not a candidate index: a surname+initial match on its
 * own scores below the shipped threshold, so widening the candidate set with it
 * would change nothing about who links. It exists so the guard can see the
 * near-identical spelling a namesake hides behind — `Johannes Jansen` standing
 * behind the `Jan Jansen` an account is named after (#1440).
 *
 * @returns {{ byEmployeeId: Map, byEmailLocal: Map, byName: Map, byNameKey: Map, bySurnameInitial: Map }}
 */
export function indexIdentities(identities) {
  const byEmployeeId = new Map();
  const byEmailLocal = new Map();
  const byName = new Map();
  const byNameKey = new Map();
  const bySurnameInitial = new Map();
  const push = (map, key, v) => { if (!key) return; (map.get(key) || map.set(key, []).get(key)).push(v); };
  for (const idy of identities) {
    push(byEmployeeId, norm(idy.employeeId), idy);
    push(byEmailLocal, emailLocalPart(idy.email), idy);
    push(byName, normalizeName(idy.displayName) || fullName(idy), idy);
    for (const key of nameKeys(idy)) push(byNameKey, key, idy);
    for (const key of nameInitialVariants(idy).keys()) push(bySurnameInitial, key, idy);
  }
  return { byEmployeeId, byEmailLocal, byName, byNameKey, bySurnameInitial };
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
 * @param {(o: object) => Map<string, string>} variantsOf  how an identity carries its keys
 */
function strongestClaims(underKey, key, carried, variantsOf) {
  if (carried !== 'inUse') return underKey;
  const inUse = underKey.filter(idy => variantsOf(idy).get(key) === 'inUse');
  return inUse.length ? inUse : underKey;
}

/**
 * Everyone with a claim to ONE of the names an account carries.
 *
 * The name is read at both levels the engine scores a name at, and a claim at
 * either level counts: the people spelled exactly that name, and the people who
 * share its surname and given initial. The second half is what the tie between
 * top-scoring candidates cannot see — `Johannes Jansen` never scores high enough
 * to tie with the `Jan Jansen` an account is named after, yet he is exactly who
 * that account may belong to (#1440).
 *
 * @returns {Map<string, object>} identity id → identity
 */
function claimantsOfName(v, indexes, exactCarried, initialCarried) {
  const ek = EXACT_KEY(v);
  const ik = INITIAL_KEY(v);
  const under = new Map();
  const add = (list) => { for (const idy of list) under.set(idy.id, idy); };
  add(strongestClaims(indexes.byNameKey.get(ek) || [], ek, exactCarried.get(ek), nameKeyVariants));
  add(strongestClaims(indexes.bySurnameInitial.get(ik) || [], ik, initialCarried.get(ik), nameInitialVariants));
  return under;
}

/**
 * Who an account's name points at — the question the name-uniqueness guard asks.
 *
 * A person is indexed under every name they are known by (their name in use and
 * the birth surname an HR column holds), so this is not one question but one per
 * name the account carries. A name singles someone out when they are its only
 * claimant at either level. The account's name points at exactly one person when
 * some name singles them out and no other name singles out anybody else: two
 * people sharing only a birth surname then do not block the match that is unique
 * on the name in use, while a second person spelled the same — or near enough to
 * be the same name — leaves nothing to choose between them.
 *
 * Names that can never fire a name signal (no surname, or no given name) are
 * skipped: indexed under a bare surname they would collect claimants the engine
 * would never have scored.
 *
 * @param {object} person  the account being placed
 * @param {object} indexes  the identity indexes from `indexIdentities`
 * @returns {{ sole: object|null, claimants: object[] }}
 *   `sole` is the identity the name points at, or null when it points at nobody
 *   or at more than one; `claimants` is everyone it could be, for review.
 */
export function nameClaim(person, indexes) {
  const exactCarried = nameKeyVariants(person);
  const initialCarried = nameInitialVariants(person);
  const claimants = new Map();
  const singledOut = new Set();
  for (const v of personNames(person)) {
    if (!INITIAL_KEY(v)) continue;
    const under = claimantsOfName(v, indexes, exactCarried, initialCarried);
    for (const [id, idy] of under) claimants.set(id, idy);
    if (under.size === 1) singledOut.add([...under.keys()][0]);
  }
  const sole = singledOut.size === 1 ? claimants.get([...singledOut][0]) : null;
  return { sole, claimants: [...claimants.values()] };
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

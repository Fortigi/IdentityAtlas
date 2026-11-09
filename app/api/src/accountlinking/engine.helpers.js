// Identity Atlas — Account Linking engine, pure helpers.
//
// Dependency-light, DB-free helpers factored out of engine.js so the linking
// engine's top-level functions stay small and flat: reading the dictionary,
// indexing the identities, and the bookkeeping around a match's signals.
// Everything here is pure (no DB, no side effects) and unit-tested directly in
// engine.helpers.test.js.
//
// Two neighbours carry the rest: `nameKeys.js` has the keys a person is indexed
// under, and `nameClaim.js` the name-uniqueness reading built on them.

import {
  normalizeName,
  emailLocalPart,
  stripKnownPrefixes,
  loginToken,
  loginNameForms,
  loginFormMatch,
  LOGIN_FORM_GRADES,
  bestNameMatch,
} from './classifier.js';
import { initialsRuleOut } from './initials.js';
import { evidenceSignalNames } from './guardEvidence.js';
import {
  personNames,
  nameKeys,
  nameInitialsVariants,
  nameInitialVariants,
  LOGIN_INDEX_OF,
  spellingsOf,
} from './nameKeys.js';
import { CLAIM_RUNG_OF_LEVEL } from './nameClaim.js';
import { parseJsonbColumn } from '../lib/jsonb.js';

/** Normalise any scalar to a trimmed, lower-cased comparison token. */
export const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

/** givenName + surname joined and normalised (optionally stripping suffixes). */
export const fullName = (o, suffixes = []) =>
  normalizeName([o.givenName, o.surname].filter(Boolean).join(' '), suffixes);

export function prefixesFrom(rules) {
  return (rules.signals || []).find(s => s.type === 'prefix')?.stripPrefixes || [];
}
export function suffixesFrom(rules) {
  return (rules.signals || []).find(s => s.type === 'fuzzy')?.stripSuffixes || [];
}
/**
 * The level each signal that is a name match and nothing else fires at, by
 * signal name. Two types besides the graded `name` ones belong here, because
 * what they compare is a person's name:
 *   `fuzzy`     — the legacy single-signal name comparison, so a match resting
 *                 only on it is just as uncorroborated as one resting on
 *                 `fullName`, and it compares whole names → `full`.
 *   `loginName` — a login that spells a name form rather than an address
 *                 (#1454). It reports its own level: the rivals of such a match
 *                 share neither a spelled-out full name nor a display name, they
 *                 answer to the same login form.
 *
 * @returns {Map<string, 'full'|'surnameInitials'|'surnameInitial'|'loginName'>}
 */
export function nameSignalLevels(rules) {
  const levelOf = (s) => {
    if (s.type === 'fuzzy') return 'full';
    if (s.type === 'loginName') return 'loginName';
    return s.level;
  };
  return new Map((rules.signals || [])
    .filter(s => s.type === 'name' || s.type === 'fuzzy' || s.type === 'loginName')
    .map(s => [s.name, levelOf(s)]));
}

/** The prefixes the login-reading signals strip before comparing (`adm-`, …). */
export function loginPrefixesFrom(rules) {
  return (rules.signals || [])
    .filter(s => s.type === 'loginName')
    .flatMap(s => s.stripPrefixes || []);
}

/**
 * Which rung of the name-class ladder fires for one candidate pair, by level
 * token — or null when the account's name says nothing about this person.
 *
 * The account's parsed name and its login carry the same kind of evidence, read
 * off different fields: *this account is named after this person*. So they are
 * rungs of one graded ladder and the strongest of them fires alone, exactly as
 * the two parsed-name levels always have. Stacking them instead would let one
 * name counted twice reach the confidence of an exact employeeId match — an
 * account whose display name and login both spell its owner is no more certainly
 * hers than the name is, since a namesake's account spells her name just as
 * well, and a derived name form must never be near-certain evidence (#1454).
 *
 * The strongest rung is the heaviest one the rules configure, so a tenant that
 * reweights the dictionary reorders the ladder with it.
 *
 * @returns {'full'|'surnameInitial'|'loginName'|string|null}
 */
export function strongestNameRung(orphan, identity, rules) {
  const orphanNames = personNames(orphan);
  const identityNames = personNames(identity);
  // Initials the account states that contradict this person's are a statement
  // about who the account is NOT, so no rung fires — not the display name's, and
  // not the login's either (R1b/P5). Blocking only the route the contradiction
  // was read on would make the outcome depend on which route found her: a login
  // carries at most one initial, so `Buskes, L.R.` would be refused the Lucas
  // Willem Buskes its own name rules out and then handed to him by `adm-lbuskes`.
  if (initialsRuleOut(orphanNames, identityNames)) return null;
  const nameLevel = bestNameMatch(orphanNames, identityNames);
  let best = null;
  let bestWeight = -1; // so a signal configured at weight 0 still wins over nothing
  for (const sig of (rules.signals || [])) {
    const fires = sig.type === 'name'
      ? sig.level === nameLevel
      : sig.type === 'loginName'
        && loginFormMatch(loginToken(orphan[sig.field], sig.stripPrefixes || []), identity) !== 'none';
    if (fires && (sig.weight || 0) > bestWeight) { best = sig; bestWeight = sig.weight || 0; }
  }
  if (!best) return null;
  return best.type === 'loginName' ? 'loginName' : best.level;
}

/**
 * The names of every signal that is a name match and nothing else — the graded
 * name rungs, the login rung, the legacy `fuzzy` comparison, **and** the guard's
 * corroborating evidence.
 *
 * The evidence belongs here because it is not independent of the name: each
 * piece says the name singled somebody out, so a match carrying
 * `surnameInitial,nameUnique,department` rests on a name exactly as much as a
 * bare `surnameInitial` one does. Classified any other way, `isNameOnly` would
 * answer `false` for every link this guard makes — and the retroactive cleanup,
 * which only ever touches name-only links, could then never revisit one of
 * them, permanently (P7).
 */
export function nameSignalNames(rules) {
  return new Set([...nameSignalLevels(rules).keys(), ...evidenceSignalNames(rules)]);
}

/**
 * The claim rungs a dictionary still scores.
 *
 * Weight 0 is the dictionary's off-switch, and it has to switch the *claim* off
 * too, not just the score: a rung nothing is scored at can neither place an
 * account nor stop another rung placing it, and a link already resting on it is
 * stale. Read the other way — the shipped behaviour until #1455 — zeroing a
 * signal left every link it had already made attached, because the uniqueness
 * reading counted name keys and login forms whatever their weight.
 */
export function activeNameRungs(rules) {
  const levels = nameSignalLevels(rules);
  const on = new Set();
  for (const sig of (rules.signals || [])) {
    const rung = CLAIM_RUNG_OF_LEVEL[levels.get(sig.name)];
    if (rung && (sig.weight || 0) > 0) on.add(rung);
  }
  return on;
}

/**
 * The level a name-only match rests on. The name signals are mutually exclusive
 * — exactly one of them fires — so the first name signal among those that did is
 * the level, and null means the match fired no name signal at all.
 */
export function matchLevelOf(signals, nameLevels) {
  return signals.map(s => nameLevels.get(s)).find(Boolean) ?? null;
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
 * `bySurnameInitials` and `bySurnameInitial` are the two initial-level name
 * indexes, and both are genuine candidate indexes. They were not always: a
 * surname+initial match scores 45, below the shipped threshold of 50, so before
 * the guard could corroborate one there was no point widening the candidate set
 * with it. Now an unambiguous `van Mourik, R.` reaches 55 and links, and an
 * account carrying nothing but "Surname, Initials" has no other way to reach
 * scoring at all — it matches no exact name key, no address and no employee
 * number, which is why such a source linked nothing before #1455. They are also
 * still what lets the guard see the near-identical spelling a namesake hides
 * behind — `Johannes Jansen` standing behind the `Jan Jansen` an account is
 * named after (#1440).
 *
 * `byLoginFull` / `byLoginInitial` / `byLoginLoose` are the three grades a login
 * that spells a name is read at (see `loginNameForms`), candidate indexes for
 * the same reason: an account the login is the only evidence for has to reach
 * scoring through them — which is exactly what it could not do before (#1454),
 * nor for a login a convention had shortened (#1468).
 *
 * @returns {{ byEmployeeId: Map, byEmailLocal: Map, byName: Map, byNameKey: Map,
 *   bySurnameInitials: Map, bySurnameInitial: Map, byLoginFull: Map,
 *   byLoginInitial: Map, byLoginLoose: Map }}
 */
export function indexIdentities(identities) {
  const byEmployeeId = new Map();
  const byEmailLocal = new Map();
  const byName = new Map();
  const byNameKey = new Map();
  const bySurnameInitials = new Map();
  const bySurnameInitial = new Map();
  const byLoginFull = new Map();
  const byLoginInitial = new Map();
  const byLoginLoose = new Map();
  const push = (map, key, v) => { if (!key) return; (map.get(key) || map.set(key, []).get(key)).push(v); };
  for (const idy of identities) {
    push(byEmployeeId, norm(idy.employeeId), idy);
    push(byEmailLocal, emailLocalPart(idy.email), idy);
    push(byName, normalizeName(idy.displayName) || fullName(idy), idy);
    for (const key of nameKeys(idy)) push(byNameKey, key, idy);
    for (const key of nameInitialsVariants(idy).keys()) push(bySurnameInitials, key, idy);
    for (const key of nameInitialVariants(idy).keys()) push(bySurnameInitial, key, idy);
    const forms = loginNameForms(idy);
    for (const form of forms.full.keys()) push(byLoginFull, form, idy);
    for (const form of forms.initial.keys()) push(byLoginInitial, form, idy);
    for (const form of forms.loose.keys()) push(byLoginLoose, form, idy);
  }
  return {
    byEmployeeId, byEmailLocal, byName, byNameKey, bySurnameInitials, bySurnameInitial,
    byLoginFull, byLoginInitial, byLoginLoose,
  };
}


/**
 * All identities plausibly matching an orphan, deduped by identity id.
 * @returns {Map<string, object>}
 */
export function collectCandidates(orphan, indexes, { prefixes, suffixes, loginPrefixes = [] }) {
  const { byEmployeeId, byEmailLocal, byName, byNameKey } = indexes;
  const candidates = new Map();
  const addAll = (arr) => { for (const idy of (arr || [])) candidates.set(idy.id, idy); };
  addAll(byEmployeeId.get(norm(orphan.employeeId)));
  addAll(byEmailLocal.get(emailLocalPart(orphan.email)));
  addAll(byEmailLocal.get(stripKnownPrefixes(emailLocalPart(orphan.email), prefixes)));
  addAll(byName.get(normalizeName(orphan.displayName, suffixes) || fullName(orphan, suffixes)));
  for (const key of nameKeys(orphan)) addAll(byNameKey.get(key));
  // The initial-level name keys, which is the only route an account spelled
  // "Surname, Initials" has into scoring at all (#1455).
  for (const key of nameInitialsVariants(orphan).keys()) addAll(indexes.bySurnameInitials?.get(key));
  for (const key of nameInitialVariants(orphan).keys()) addAll(indexes.bySurnameInitial?.get(key));
  // Every grade, under every spelling of the login: narrowing is this function's
  // only job, and whose claim is the stronger one is `nameClaim`'s.
  for (const { form } of spellingsOf(orphan, loginPrefixes)) {
    for (const grade of LOGIN_FORM_GRADES) addAll(indexes[LOGIN_INDEX_OF[grade]]?.get(form));
  }
  return candidates;
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

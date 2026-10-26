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
  loginToken,
  loginSpellings,
  numberedAwayFrom,
  loginNameForms,
  loginFormMatch,
  LOGIN_FORM_GRADES,
  bestNameMatch,
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
 * @returns {Map<string, 'full'|'surnameInitial'|'loginName'>}
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
  const nameLevel = bestNameMatch(personNames(orphan), personNames(identity));
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

/** The names of every signal that is a name match and nothing else. */
export function nameSignalNames(rules) {
  return new Set(nameSignalLevels(rules).keys());
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
 * `bySurnameInitial` is not a candidate index: a surname+initial match on its
 * own scores below the shipped threshold, so widening the candidate set with it
 * would change nothing about who links. It exists so the guard can see the
 * near-identical spelling a namesake hides behind — `Johannes Jansen` standing
 * behind the `Jan Jansen` an account is named after (#1440).
 *
 * `byLoginFull` / `byLoginInitial` / `byLoginLoose` are the three grades a login
 * that spells a name is read at (see `loginNameForms`). Unlike `bySurnameInitial`
 * these *are* candidate indexes: a login form match scores above the shipped
 * threshold on its own, so an account the login is the only evidence for has to
 * reach scoring through them — which is exactly what it could not do before
 * (#1454), nor for a login a convention had shortened (#1468).
 *
 * @returns {{ byEmployeeId: Map, byEmailLocal: Map, byName: Map, byNameKey: Map,
 *   bySurnameInitial: Map, byLoginFull: Map, byLoginInitial: Map, byLoginLoose: Map }}
 */
export function indexIdentities(identities) {
  const byEmployeeId = new Map();
  const byEmailLocal = new Map();
  const byName = new Map();
  const byNameKey = new Map();
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
    for (const key of nameInitialVariants(idy).keys()) push(bySurnameInitial, key, idy);
    const forms = loginNameForms(idy);
    for (const form of forms.full.keys()) push(byLoginFull, form, idy);
    for (const form of forms.initial.keys()) push(byLoginInitial, form, idy);
    for (const form of forms.loose.keys()) push(byLoginLoose, form, idy);
  }
  return {
    byEmployeeId, byEmailLocal, byName, byNameKey, bySurnameInitial,
    byLoginFull, byLoginInitial, byLoginLoose,
  };
}

/** The identity index each login-form grade is read from, strongest grade first. */
const LOGIN_INDEX_OF = { full: 'byLoginFull', initial: 'byLoginInitial', loose: 'byLoginLoose' };

/** The spellings an account's login is looked up under, strongest first. */
const spellingsOf = (person, prefixes) => loginSpellings(loginToken(person.email, prefixes));

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
  // Every grade, under every spelling of the login: narrowing is this function's
  // only job, and whose claim is the stronger one is `nameClaim`'s.
  for (const { form } of spellingsOf(orphan, loginPrefixes)) {
    for (const grade of LOGIN_FORM_GRADES) addAll(indexes[LOGIN_INDEX_OF[grade]]?.get(form));
  }
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
 * The levels a claim can rest on, strongest first.
 *
 * Two, not three: a claim either carries the whole given name (a name spelled
 * exactly, a login that writes it out) or just its first letter (a surname +
 * initial spelling, a login that writes an initial — shortened or not). What the
 * claim *carries* is what decides whether two claims are competing answers to
 * the same question, so this is the ladder rivalry is scoped to.
 */
const CLAIM_LEVELS = ['full', 'initial'];

/**
 * The level each login-form grade is evidence at.
 *
 * `loose` sits with `initial`: a login a convention shortened still carries one
 * letter of the given name and no more, so it is initial-level evidence and can
 * no more rival a full-name claim than a surname+initial spelling can (#1468) —
 * `Michelle Schipper` answering to `mschipper` says nothing about an account the
 * directory spells `Melanie Schipper-Siemons` in full.
 *
 * The grades still rank against each other WITHIN the login (see `loginClaim`),
 * which is what keeps the D. Dongen of the tenant ahead of the Daniëlle van
 * Dongen `ddongen` was shortened from.
 */
const CLAIM_LEVEL_OF_GRADE = { full: 'full', initial: 'initial', loose: 'initial' };

/**
 * Everyone with a claim to ONE of the names an account carries, weighed at the
 * level the name's own evidence rests on.
 *
 * The name is read at the two levels the engine scores a name at, but not at
 * both at once: whoever is spelled exactly that name answers to it, and only
 * when NOBODY is does sharing its surname and given initial make somebody a
 * claimant. That fallback is what the tie between top-scoring candidates cannot
 * see — an account spelled `Johan Jansen` matches nobody exactly, and both the
 * `Jan` and the `Johannes` it may belong to stand one initial away (#1440).
 *
 * Reading both levels at once instead made every near spelling a rival of a name
 * only one person answers to, so `Youssef El Mahdi` could not be placed while a
 * Yasmina or a Yassin existed (#1460). A rival at a weaker level is not a
 * competing answer to the name the account actually carries.
 *
 * @returns {{ level: 'full'|'initial', under: Map<string, object> }}
 *   `level` is which of the two the claim rests on, so `nameClaim` can scope
 *   rivalry between this name and the account's other names the same way.
 */
function claimantsOfName(v, indexes, exactCarried, initialCarried) {
  const ek = EXACT_KEY(v);
  const ik = INITIAL_KEY(v);
  const spelled = indexes.byNameKey.get(ek) || [];
  const claims = spelled.length
    ? strongestClaims(spelled, ek, exactCarried.get(ek), nameKeyVariants)
    : strongestClaims(indexes.bySurnameInitial.get(ik) || [], ik, initialCarried.get(ik), nameInitialVariants);
  return {
    level: spelled.length ? 'full' : 'initial',
    under: new Map(claims.map(idy => [idy.id, idy])),
  };
}

/**
 * Whether one of the account's names is also shared — at the weaker surname +
 * given initial level only — by somebody other than the people spelled it.
 *
 * `claimantsOfName` disregards those, so a link this run makes on such a name is
 * one the pre-#1460 cross-level reading would have held for review, and would
 * have detached if an earlier run had made it. A run counts the links of this
 * class it creates (`linksRestored`) so the one-off restore after the upgrade is
 * visible to an analyst rather than silent.
 */
export function sharedAtWeakerLevel(person, indexes) {
  for (const v of personNames(person)) {
    const ik = INITIAL_KEY(v);
    if (!ik) continue;
    const spelled = new Set((indexes.byNameKey.get(EXACT_KEY(v)) || []).map(idy => idy.id));
    if (!spelled.size) continue; // nobody is spelled it, so the claim already rests here
    if ((indexes.bySurnameInitial.get(ik) || []).some(idy => !spelled.has(idy.id))) return true;
  }
  return false;
}

/**
 * The identities one grade of the login index answers to under one spelling,
 * split into the people a numbered login points away from and everybody else
 * (see `numberedAwayFrom`).
 * @returns {{ under: object[], numbered: object[] }}
 */
function gradeMatches(indexes, grade, spelling) {
  const under = [];
  const numbered = [];
  for (const idy of indexes[LOGIN_INDEX_OF[grade]]?.get(spelling.form) || []) {
    (numberedAwayFrom(idy, spelling) ? numbered : under).push(idy);
  }
  return { under, numbered };
}

/** One grade's claim: its claimants, ranked, under the level that grade is evidence at. */
function gradeClaim(under, form, grade) {
  const claims = strongestClaims(under, form, 'inUse', idy => loginNameForms(idy)[grade]);
  return { level: CLAIM_LEVEL_OF_GRADE[grade], under: new Map(claims.map(idy => [idy.id, idy])) };
}

/**
 * What an account's LOGIN claims, weighed the same way a display name is.
 *
 * The three grades of `loginNameForms` are read one at a time for the same reason
 * the exact and initial name keys are: whoever's whole name the login writes out
 * answers to it, and only when nobody does can the people it writes an initial
 * of become claimants — `jhogenbirk` is Jan Hogenbirk's login even where a
 * J. Hogenbirk-de Wit exists. One grade down again sit the people whose surname a
 * convention shortened to the login (#1468), so the D. Dongen of the tenant keeps
 * `ddongen` and Daniëlle van Dongen claims it only where no D. Dongen exists.
 * And since a login is provisioned from the name in use, where both kinds of
 * claim meet under one form the name in use wins outright, exactly as
 * `strongestClaims` has it for a display name.
 *
 * A numbered login is read as the name it numbers only where the number spells
 * nobody's form, so the whole cascade runs on the login as written before any of
 * it runs on the unnumbered spelling — and at that unnumbered spelling the person
 * the number points away from drops out of it (`numberedAwayFrom`).
 *
 * Who the login *could* name is a wider set than who it claims for, and both are
 * returned, because the weaker grades are what make a contested login reviewable:
 * `abecker` is claimed at the initial grade by the two plain Beckers, and a hold
 * that listed only them would not offer the Andrea Neumann-Becker whose double
 * surname it is half of — the one person a reviewer most needs to see.
 *
 * @returns {{ level: 'full'|'initial'|null, under: Map, claimants: Map, numbered: Map }}
 *   `under` is who the login claims for, at `level`; `claimants` is everyone it
 *   could name at any grade; `numbered` is who the number pointed away from.
 */
function loginClaim(person, indexes, prefixes) {
  const nothing = { level: null, under: new Map() };
  for (const spelling of spellingsOf(person, prefixes)) {
    const claimants = new Map();
    const numbered = new Map();
    let claim = null;
    for (const grade of LOGIN_FORM_GRADES) {
      const matched = gradeMatches(indexes, grade, spelling);
      for (const idy of matched.numbered) numbered.set(idy.id, idy);
      for (const idy of matched.under) claimants.set(idy.id, idy);
      if (claim || !matched.under.length) continue; // a weaker grade is listed, never claimed over
      claim = gradeClaim(matched.under, spelling.form, grade);
    }
    // The spelling cascade stops at the first spelling the directory answers to
    // at all — a login the number ruled everybody out of is answered, and
    // falling through would re-read it as a name nobody provisioned.
    if (claim || numbered.size) return { ...(claim ?? nothing), claimants, numbered };
  }
  return { ...nothing, claimants: new Map(), numbered: new Map() };
}

/**
 * Who an account's name points at — the question the name-uniqueness guard asks.
 *
 * A person is indexed under every name they are known by (their name in use and
 * the birth surname an HR column holds), so this is not one question but one per
 * name the account carries. A name singles someone out when they are its only
 * claimant at the level that name's evidence rests on (see `claimantsOfName`).
 * The account's name points at exactly one person when some name singles them
 * out and no other name *at that same level* singles out anybody else: two
 * people sharing only a birth surname then do not block the match that is unique
 * on the name in use, while a second person spelled the same leaves nothing to
 * choose between them — as do two people one initial away from a spelling
 * neither of them has.
 *
 * Names that can never fire a name signal (no surname, or no given name) are
 * skipped: indexed under a bare surname they would collect claimants the engine
 * would never have scored.
 *
 * The account's **login** is one of those names (#1454): `adm-fhogenbirk` is a
 * person's name written the way a provisioning convention writes one, and the
 * signal that reads it is name-class, so the login is asked the same question on
 * the same terms — it can single somebody out where the display name carries no
 * person's name at all, and it can tie where the form fits two people.
 *
 * Rivalry between those names is scoped to the level each claim rests on, which
 * is the same reading #1460 settled within one name, applied across them: a
 * claim carrying only a given initial is not a competing answer to a name
 * spelled out in full. Without that, every form a convention shortens a login to
 * became a rival of the display name it sits beside — a directory account spelled
 * `Melanie Schipper-Siemons` could not be placed while a Michelle Schipper
 * answered to `mschipper` (#1468), which is the pre-#1460 cross-level reading
 * arriving through the login instead of through the name keys.
 *
 * @param {object} person  the account being placed
 * @param {object} indexes  the identity indexes from `indexIdentities`
 * @param {{ loginPrefixes?: string[] }} [opts]  the prefixes the login-reading
 *   signals strip (`loginPrefixesFrom`). Omitted, the login is not read — the
 *   rules decide whether a login is evidence at all, not this helper.
 * @returns {{ sole: object|null, claimants: object[], numberedAway: object[] }}
 *   `sole` is the identity the name points at, or null when it points at nobody
 *   or at more than one; `claimants` is everyone it could be, for review;
 *   `numberedAway` is who a numbered login ruled out (`numberedAwayFrom`), so a
 *   hold with no claimants left can say the number is why.
 */
export function nameClaim(person, indexes, { loginPrefixes = [] } = {}) {
  const exactCarried = nameKeyVariants(person);
  const initialCarried = nameInitialVariants(person);
  const claims = [];
  const claimants = new Map();
  const include = (under) => { for (const [id, idy] of under) claimants.set(id, idy); };
  for (const v of personNames(person)) {
    if (!INITIAL_KEY(v)) continue;
    const claim = claimantsOfName(v, indexes, exactCarried, initialCarried);
    claims.push(claim);
    include(claim.under);
  }
  const login = loginClaim(person, indexes, loginPrefixes);
  if (login.level) claims.push(login);
  include(login.claimants);

  // Only the strongest level any of the account's names claims at can settle it;
  // the rest are read for review but never counted as rivals.
  const level = CLAIM_LEVELS.find(l => claims.some(c => c.level === l && c.under.size));
  const singledOut = new Set();
  for (const c of claims) {
    if (c.level === level && c.under.size === 1) singledOut.add([...c.under.keys()][0]);
  }
  const sole = singledOut.size === 1 ? claimants.get([...singledOut][0]) : null;
  return { sole, claimants: [...claimants.values()], numberedAway: [...login.numbered.values()] };
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

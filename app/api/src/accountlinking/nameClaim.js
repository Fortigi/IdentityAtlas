// Identity Atlas — who an account's name points at.
//
// The name-uniqueness guard's reading, and the one question account linking asks
// that is not a score: a match resting on a name alone may only attach an
// account to a person while that name points at **exactly one** of them. The
// ladder of levels a claim can rest on, what each of the account's names claims
// at its own level, and what its login claims, all live here.
//
// Pure and DB-free. The dictionary is not read here — the rungs it still scores
// arrive as `activeRungs` (see `activeNameRungs` in engine.helpers.js), so this
// module stays a reading of the data rather than of the configuration.

import {
  numberedAwayFrom,
  loginNameForms,
  LOGIN_FORM_GRADES,
} from './classifier.js';
import { initialsRuleOut } from './initials.js';
import {
  personNames,
  EXACT_KEY,
  INITIALS_KEY,
  INITIAL_KEY,
  nameKeyVariants,
  nameInitialsVariants,
  nameInitialVariants,
  LOGIN_INDEX_OF,
  spellingsOf,
} from './nameKeys.js';

/** The claim rung each name-class signal level is evidence at. */
export const CLAIM_RUNG_OF_LEVEL = {
  full: 'full', surnameInitials: 'initials', surnameInitial: 'initial', loginName: 'login',
};

/** Every claim rung — what a caller that is not reading a dictionary weighs. */
export const ALL_CLAIM_RUNGS = new Set(Object.values(CLAIM_RUNG_OF_LEVEL));

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
 * What the claim *carries* is what decides whether two claims are competing
 * answers to the same question, so this is the ladder rivalry is scoped to, and
 * there are three rungs of it:
 *
 *   full      the whole given name — a name spelled exactly, a login that
 *             writes it out
 *   initials  two or more initials, all in agreement (#1455). Richer than one
 *             letter and poorer than the name itself, so it settles a name over
 *             single-initial rivals and is settled in turn by anybody actually
 *             spelled the name
 *   initial   one letter of the given name — a surname+initial spelling, a login
 *             that writes an initial (shortened or not)
 *
 * A login never claims at `initials`: no login form carries more than one
 * initial (P4), so it has nothing to state at that rung.
 */
const CLAIM_LEVELS = ['full', 'initials', 'initial'];

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
 * How a name is keyed at each claim rung, strongest first: which key to look it
 * up under, which index answers, and how an identity carries that kind of key.
 */
const NAME_RUNGS = [
  { level: 'full', keyOf: EXACT_KEY, index: 'byNameKey', variantsOf: nameKeyVariants },
  { level: 'initials', keyOf: INITIALS_KEY, index: 'bySurnameInitials', variantsOf: nameInitialsVariants },
  { level: 'initial', keyOf: INITIAL_KEY, index: 'bySurnameInitial', variantsOf: nameInitialVariants },
];

/**
 * Everyone with a claim to ONE of the names an account carries, weighed at the
 * level the name's own evidence rests on.
 *
 * The rungs are read strongest-first and only one of them answers: whoever is
 * spelled exactly that name answers to it; only when NOBODY is do the people
 * stating the same initials become the claimants; and only when nobody does
 * *that* does sharing the surname and one initial make somebody a claimant. That
 * cascade is what the tie between top-scoring candidates cannot see — an account
 * spelled `Johan Jansen` matches nobody exactly, and both the `Jan` and the
 * `Johannes` it may belong to stand one initial away (#1440).
 *
 * Reading the rungs at once instead made every near spelling a rival of a name
 * only one person answers to, so `Youssef El Mahdi` could not be placed while a
 * Yasmina or a Yassin existed (#1460). A rival at a weaker rung is not a
 * competing answer to the name the account actually carries — which is exactly
 * what the middle rung buys: `Buskes, L.R.` is Laura Renée's, and Lars Buskes,
 * one letter away, does not get to contest it (#1455).
 *
 * @param {object} v one of the account's parsed names
 * @param {object} indexes the identity indexes from `indexIdentities`
 * @param {Record<string, Map>} carried how the account itself carries each kind of key
 * @param {(idy: object) => boolean} keep which identities are claimants at all
 * @param {Set<string>} rungs the rungs the dictionary still scores
 * @returns {{ level: 'full'|'initials'|'initial'|null, under: Map<string, object> }}
 *   `level` is which rung the claim rests on, so `nameClaim` can scope rivalry
 *   between this name and the account's other names the same way.
 */
function claimantsOfName(v, indexes, carried, keep, rungs) {
  for (const rung of NAME_RUNGS) {
    const key = rung.keyOf(v);
    if (!key || !rungs.has(rung.level)) continue;
    const under = (indexes[rung.index].get(key) || []).filter(keep);
    if (!under.length) continue;
    const claims = strongestClaims(under, key, carried[rung.level].get(key), rung.variantsOf);
    return { level: rung.level, under: new Map(claims.map(idy => [idy.id, idy])) };
  }
  return { level: null, under: new Map() };
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
function gradeMatches(indexes, grade, spelling, keep) {
  const under = [];
  const numbered = [];
  for (const idy of (indexes[LOGIN_INDEX_OF[grade]]?.get(spelling.form) || []).filter(keep)) {
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
function loginClaim(person, indexes, prefixes, keep) {
  const nothing = { level: null, under: new Map() };
  for (const spelling of spellingsOf(person, prefixes)) {
    const claimants = new Map();
    const numbered = new Map();
    let claim = null;
    for (const grade of LOGIN_FORM_GRADES) {
      const matched = gradeMatches(indexes, grade, spelling, keep);
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
 * Initials the account's own name **contradicts** rule a person out of every
 * route before any of this is asked (R1b): `Buskes, L.R.` is not the sole Lucas
 * Willem Buskes, so he neither claims the account nor counts as a rival to
 * anybody who does (P2). That is what lets two initials *resolve* an ambiguity a
 * single one cannot — `Jansen, L.R.` is Lucas Robert's rather than held between
 * him and Lucas Willem — and it is applied to the login's claimants at every
 * grade too, so the block cannot be routed around (P5).
 *
 * @param {object} person  the account being placed
 * @param {object} indexes  the identity indexes from `indexIdentities`
 * @param {{ loginPrefixes?: string[], activeRungs?: Set<string> }} [opts]
 *   `loginPrefixes` are the prefixes the login-reading signals strip
 *   (`loginPrefixesFrom`); omitted, the login is not read — the rules decide
 *   whether a login is evidence at all, not this helper. `activeRungs` are the
 *   claim rungs the dictionary still scores (`activeNameRungs`); omitted, all of
 *   them are read.
 * @returns {{ sole: object|null, claimants: object[], numberedAway: object[] }}
 *   `sole` is the identity the name points at, or null when it points at nobody
 *   or at more than one; `claimants` is everyone it could be, for review;
 *   `numberedAway` is who a numbered login ruled out (`numberedAwayFrom`), so a
 *   hold with no claimants left can say the number is why.
 */
export function nameClaim(person, indexes, { loginPrefixes = [], activeRungs = ALL_CLAIM_RUNGS } = {}) {
  const names = personNames(person);
  const keep = (idy) => !initialsRuleOut(names, personNames(idy));
  const carried = {
    full: nameKeyVariants(person),
    initials: nameInitialsVariants(person),
    initial: nameInitialVariants(person),
  };
  const claims = [];
  const claimants = new Map();
  const include = (under) => { for (const [id, idy] of under) claimants.set(id, idy); };
  for (const v of names) {
    if (!INITIAL_KEY(v)) continue;
    const claim = claimantsOfName(v, indexes, carried, keep, activeRungs);
    if (claim.level) { claims.push(claim); include(claim.under); }
  }
  const login = activeRungs.has('login')
    ? loginClaim(person, indexes, loginPrefixes, keep)
    : { level: null, under: new Map(), claimants: new Map(), numbered: new Map() };
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

// Identity Atlas — how a person is KEYED for name matching.
//
// One place for the keys both halves of the engine read: `indexIdentities`
// builds its indexes from them and `nameClaim` looks a name up under them, so a
// key built differently on the two sides is an account that silently never
// matches. Pure, DB-free, and knows nothing about the dictionary.

import { nameVariants, loginToken, loginSpellings } from './classifier.js';

/** Every comparable name a principal/identity row is known by. */
export const personNames = (o) => nameVariants(o.displayName, o.givenName, o.surname);

/**
 * The three keys one parsed name is indexed under — one per level the engine
 * scores a name at (see `nameMatchLevel`):
 *   exact    — surname + given name, order-independent: who is spelled this name
 *   initials — surname + the first TWO initials: who states the same sequence
 *   initial  — surname + given initial: who is spelled a near-identical name
 *
 * Two initials, not all of them, because the sides routinely state a different
 * number of them and the key has to find the pair anyway: `Buskes, L.R.` has to
 * reach Laura Renée Elisabeth Buskes. Keyed on the whole sequence it would not,
 * and keyed on one letter the key would say nothing more than `initial` does.
 * The letters past the second are then compared properly by `nameMatchLevel`
 * and by the guard's own contradiction test, so the key is a net, never the
 * verdict.
 *
 * All three are empty for a name that can never match at that level (no
 * surname, no given name, or fewer than two initials stated).
 */
export const EXACT_KEY = (v) => v.key;
export const INITIALS_KEY = (v) =>
  (v.surname && v.initials.length >= 2 ? `${v.surname}|${v.initials.slice(0, 2).join('')}` : '');
export const INITIAL_KEY = (v) => (v.surname && v.initial ? `${v.surname}|${v.initial}` : '');

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

/** How the person is known by each initials-sequence (surname + two initials) key. */
export const nameInitialsVariants = (o) => keyVariants(o, INITIALS_KEY);

/** How the person is known by each near-identical (surname + given initial) key. */
export const nameInitialVariants = (o) => keyVariants(o, INITIAL_KEY);

/** The name keys a person is indexed under, each once. */
export const nameKeys = (o) => [...nameKeyVariants(o).keys()];

/** The identity index each login-form grade is read from, strongest grade first. */
export const LOGIN_INDEX_OF = { full: 'byLoginFull', initial: 'byLoginInitial', loose: 'byLoginLoose' };

/** The spellings an account's login is looked up under, strongest first. */
export const spellingsOf = (person, prefixes) => loginSpellings(loginToken(person.email, prefixes));

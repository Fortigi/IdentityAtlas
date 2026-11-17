// Identity Atlas — the name a source spells as "Surname, Initials".
//
// Many ERP, finance and payroll systems show a person as `van Mourik, R.` or
// `Buskes, L.R.` and carry no address and no employee number, so the initials
// ARE the evidence there is (#1455). Reading only the first of them throws most
// of it away: `L.R.` against Laura Renée Buskes and Lars Buskes is two letters
// that single one of them out, where `L.` alone is one letter that cannot.
//
// Everything here is pure and knows nothing about the dictionary: which
// given-name halves spell initials rather than a name, the sequence a name
// exposes, and whether two sequences agree — which is both the match test and
// the contradiction test.
//
// The letters are read through the same fold as the classifier's name tokens
// (see `fold.js`): unfolded, this module would contradict the names it is
// weighed against and rule out the very person they match (#1480).

import { foldDiacritics, foldedToken } from './fold.js';

/**
 * A run of single letters each followed by a dot — `L.`, `L.R.`, `J.C.` — which
 * is how a source states an initial rather than a name (P3). The dot is what
 * carries the claim: an undotted `Rob` is a (short) name and is read as one, so
 * it is never compared letter-by-letter against somebody's given names.
 *
 * Tested against the folded token, so `Ö.R.` is the initials half it plainly is
 * and reads as the same two letters the classifier folds the name to (#1480).
 */
const INITIALS_TOKEN = /^(?:[a-z]\.)+$/;

/** The first comparable letter of one name token. */
const firstLetter = (word) => foldedToken(word).slice(0, 1);

/**
 * Whether a given-name half spells initials rather than a name. Every token has
 * to be dotted, so `L. R.` and `L.R.` both qualify (the spacing is a typing
 * convention, not information) while `L.R Buskes` and `Rob` do not.
 */
export function isInitialsHalf(words = []) {
  return words.length > 0 && words.every(w => INITIALS_TOKEN.test(foldDiacritics(w)));
}

/**
 * The letters a dotted given-name half states, in order — `['l', 'r']` for
 * `L.R.` and for `L. R.` alike. Empty for a half that spells a name.
 * @returns {string[]}
 */
export function initialsOf(words = []) {
  if (!isInitialsHalf(words)) return [];
  return foldDiacritics(words.join('')).split('.').filter(Boolean);
}

/**
 * The initials a name exposes, in order, from whichever side it was read:
 *
 *   - a dotted half states them outright (`L.R.` → `l`, `r`);
 *   - a spelled-out half yields one per given name, which is what makes the
 *     comparison possible at all — `Laura Renée` is the `L.R.` the ERP shows,
 *     and `givenName` has to be tokenised *before* it collapses to one token to
 *     see it;
 *   - a half that is already collapsed to a single token falls back to its
 *     first letter, so this never returns nothing for a name that has one.
 *
 * @param {string[]} words the half's own words (titles already dropped)
 * @param {string} given the same half, normalised and collapsed
 * @returns {string[]}
 */
export function nameInitials(words = [], given = '') {
  const stated = initialsOf(words);
  if (stated.length) return stated;
  const letters = words.map(firstLetter).filter(Boolean);
  if (letters.length) return letters;
  return given ? [given.slice(0, 1)] : [];
}

/**
 * Whether two sequences disagree at a position they both spell.
 *
 * Compared position by position over the **shorter** sequence (P1), because the
 * sides routinely state a different number of initials and the missing ones are
 * not a disagreement: `L.` against Lucas Robert says nothing about a second
 * initial, and neither does `L.R.` against an identity whose record holds only
 * `Lucas`.
 */
export function initialsConflict(a = [], b = []) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return true;
  }
  return false;
}

/**
 * Whether two sequences agree: both state at least one letter, and every
 * position they both state matches. A side with no initials at all agrees with
 * nothing — there is no evidence to agree on.
 */
export function initialsAgree(a = [], b = []) {
  return Math.min(a.length, b.length) > 0 && !initialsConflict(a, b);
}

/**
 * Whether two sequences **contradict** each other (R1b): both state at least
 * two initials and a position they both state differs.
 *
 * Two is the floor because one letter in common is the ordinary near-miss the
 * surname+initial level already weighs — `L.` and `M.` are simply different
 * people's initials, not a contradiction. Two letters that disagree are a
 * statement about who the account is *not*: `Buskes, L.R.` is not the sole
 * Lucas Willem Buskes, however little else contests the name. Unequal counts
 * stay neutral in both directions (R1).
 */
export function initialsContradict(a = [], b = []) {
  return a.length >= 2 && b.length >= 2 && initialsConflict(a, b);
}

/**
 * Whether the initials an account's own name spells rule a person out, judged
 * pair by pair across every name either side is known by (P3).
 *
 * A pair is only comparable where the surnames match — initials say nothing
 * about a different family — and one pair that does *not* contradict clears the
 * person, because a source that spells two of someone's names differently is
 * stating both of them, not contradicting itself.
 *
 * The account side is always its parsed **name**, never its login: a login
 * carries at most one initial (P4), so it can rule nobody out, and reading it
 * as if it could would make the block depend on which route found the person
 * (P5).
 *
 * @param {Array<{surname: string, initials: string[]}>} accountNames
 * @param {Array<{surname: string, initials: string[]}>} personNames
 */
export function initialsRuleOut(accountNames = [], personNames = []) {
  let ruledOut = false;
  for (const a of accountNames) {
    for (const b of personNames) {
      if (!a.surname || a.surname !== b.surname) continue;
      if (!initialsContradict(a.initials, b.initials)) return false;
      ruledOut = true;
    }
  }
  return ruledOut;
}

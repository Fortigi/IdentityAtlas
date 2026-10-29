// Unit tests for initials.js — reading "Surname, Initials" as evidence (#1455).
//
// Every assertion here is a PAIR, because each rule has an opposite that looks
// identical from the outside and is wrong in a different direction:
//
//   dotted vs undotted      `L.R.` is two initials, `Rob` is a name. Read the
//                           other way, every short given name becomes a letter
//                           sequence and `Rob Buskes` matches `R.B. Buskes`.
//   agree vs contradict     `L.R.` against Lucas Robert agrees; against Lucas
//                           Willem it contradicts. One predicate answering both
//                           either links the wrong Buskes or links nobody.
//   contradict vs neutral   two initials against ONE is neutral (R1), two
//                           against two that differ is a block (R1b). Collapse
//                           the two and the ERP's whole single-initial
//                           population stops linking.
//
// The counts are what make them discriminate: `initialsContradict` is written
// with a `>= 2` floor on both sides, so a case with one initial on either side
// is the only input that tells the floor from its absence.

import { describe, it, expect } from 'vitest';
import {
  isInitialsHalf, initialsOf, nameInitials, initialsConflict, initialsAgree,
  initialsContradict, initialsRuleOut,
} from './initials.js';

describe('isInitialsHalf / initialsOf — the dot is what states an initial (P3)', () => {
  it('reads a dotted half as initials, spaced or not', () => {
    // The two spellings an ERP writes the same person in. Reading only the
    // unspaced one costs every account whose source puts a space after the dot.
    expect(initialsOf(['L.R.'])).toEqual(['l', 'r']);
    expect(initialsOf(['L.', 'R.'])).toEqual(['l', 'r']);
    expect(initialsOf(['J.C.'])).toEqual(['j', 'c']);
  });

  it('reads an undotted token as a name, not as letters', () => {
    // The paired case: `Rob` is Rob, and `L.R` has lost its last dot, so neither
    // states a sequence. Read as initials, `Rob Buskes` would claim every
    // R.O.B. Buskes in the tenant.
    expect(isInitialsHalf(['Rob'])).toBe(false);
    expect(isInitialsHalf(['L.R'])).toBe(false);
    expect(initialsOf(['Rob'])).toEqual([]);
    // One dotted token among names is not a sequence either.
    expect(isInitialsHalf(['L.', 'Renee'])).toBe(false);
  });

  it('is empty for no half at all', () => {
    expect(isInitialsHalf([])).toBe(false);
    expect(isInitialsHalf()).toBe(false);
    expect(initialsOf([])).toEqual([]);
  });
});

describe('nameInitials — the same sequence from either side', () => {
  it('states a dotted half outright and a spelled-out half one letter per name', () => {
    // The comparison the feature rests on: these two have to produce the same
    // answer, or `Buskes, L.R.` can never meet Laura Renée Buskes.
    expect(nameInitials(['L.R.'], 'lr')).toEqual(['l', 'r']);
    expect(nameInitials(['Laura', 'Renée'], 'laurarenee')).toEqual(['l', 'r']);
  });

  it('yields one letter for a single given name', () => {
    // Not two: the rest of the ladder decides what one letter is worth, and a
    // padded sequence would silently promote every Lucas to a two-initial match.
    expect(nameInitials(['Lucas'], 'lucas')).toEqual(['l']);
  });

  it('falls back to the collapsed half when the words are gone', () => {
    // A name that only survived as one token still has an initial; answering []
    // here would drop the whole single-initial rung for it.
    expect(nameInitials([], 'lucas')).toEqual(['l']);
    expect(nameInitials(undefined, 'lucas')).toEqual(['l']);
  });

  it('is empty for no given name at all', () => {
    expect(nameInitials([], '')).toEqual([]);
  });

  it('ignores punctuation and case when taking a letter', () => {
    expect(nameInitials(['(Laura)', 'renée'], 'laurarenee')).toEqual(['l', 'r']);
  });
});

describe('initialsConflict / initialsAgree — compared over the shorter sequence (P1)', () => {
  it('agrees where every position both sides state matches', () => {
    expect(initialsAgree(['l', 'r'], ['l', 'r'])).toBe(true);
    // Unequal lengths: the letters past the shorter one are not evidence either way.
    expect(initialsAgree(['l', 'r'], ['l', 'r', 'e'])).toBe(true);
    expect(initialsAgree(['l'], ['l', 'r'])).toBe(true);
  });

  it('conflicts on the first position that differs, not only the last', () => {
    // A later position is the one a prefix-only comparison would miss, so both
    // are asserted: `l,w` vs `l,r` shares its first letter and is still a
    // conflict.
    expect(initialsConflict(['l', 'r'], ['m', 'r'])).toBe(true);
    expect(initialsConflict(['l', 'r'], ['l', 'w'])).toBe(true);
    expect(initialsConflict(['l', 'r', 'e'], ['l', 'r', 'x'])).toBe(true);
    expect(initialsConflict(['l', 'r'], ['l', 'r', 'e'])).toBe(false);
  });

  it('does not agree where one side states nothing', () => {
    // Absent initials are not a match — there is no evidence to agree on — and
    // they are not a conflict either.
    expect(initialsAgree([], ['l', 'r'])).toBe(false);
    expect(initialsConflict([], ['l', 'r'])).toBe(false);
  });
});

describe('initialsContradict — two against two, and only that (R1b)', () => {
  it('contradicts where both sides state two or more and a position differs', () => {
    expect(initialsContradict(['l', 'r'], ['l', 'w'])).toBe(true);
    expect(initialsContradict(['l', 'r', 'e'], ['l', 'r', 'x'])).toBe(true);
  });

  it('does not contradict where one side states only one initial', () => {
    // The input that discriminates the `>= 2` floor. `Buskes, L.R.` against an
    // identity whose record holds only "Lucas" is the ERP's commonest shape; a
    // contradiction here would stop the bulk of this feature's links.
    expect(initialsContradict(['l', 'r'], ['l'])).toBe(false);
    expect(initialsContradict(['l'], ['l', 'w'])).toBe(false);
    // ...and a first-letter difference at that length is simply no match, which
    // the match level decides, not this predicate.
    expect(initialsContradict(['l'], ['m'])).toBe(false);
  });

  it('does not contradict agreeing sequences', () => {
    expect(initialsContradict(['l', 'r'], ['l', 'r'])).toBe(false);
    expect(initialsContradict(['l', 'r'], ['l', 'r', 'e'])).toBe(false);
  });
});

describe('initialsRuleOut — judged pair by pair across the names (P3)', () => {
  const name = (surname, initials) => ({ surname, initials });

  it('rules a person out where the shared surname’s initials contradict', () => {
    expect(initialsRuleOut([name('buskes', ['l', 'r'])], [name('buskes', ['l', 'w'])])).toBe(true);
  });

  it('clears a person as soon as ONE pair of their names agrees', () => {
    // A source holding a birth surname beside a name in use is stating both, not
    // contradicting itself: the agreeing pair is the person's own name.
    expect(initialsRuleOut(
      [name('buskes', ['l', 'r'])],
      [name('buskes', ['l', 'w']), name('buskes', ['l', 'r'])],
    )).toBe(false);
  });

  it('says nothing about a different family', () => {
    // No shared surname, so the initials are not comparable — ruling her out
    // would block every person whose initials happen to differ from any account.
    expect(initialsRuleOut([name('buskes', ['l', 'r'])], [name('jansen', ['l', 'w'])])).toBe(false);
  });

  it('says nothing where the account states only one initial', () => {
    // The route-independence floor: a login contributes one initial at most, so
    // a one-initial account can never rule anybody out (P4/P5).
    expect(initialsRuleOut([name('buskes', ['l'])], [name('buskes', ['l', 'w'])])).toBe(false);
  });

  it('says nothing for an account with no name to compare', () => {
    expect(initialsRuleOut([], [name('buskes', ['l', 'w'])])).toBe(false);
    expect(initialsRuleOut([name('', [])], [name('buskes', ['l', 'w'])])).toBe(false);
  });
});

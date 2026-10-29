// How a parsed name carries its initials, and what `nameMatchLevel` does with
// them (#1455).
//
// `nameVariants` is the one place a person becomes comparable, so a name whose
// initials are lost there is lost everywhere downstream — the index, the claim
// ladder and the score all read this. The shapes asserted are the ones measured
// on the reporting dataset: `Surname, I.`, `Surname, I.J.`, the spaced variant,
// a particle surname, a hyphenated one, and a ` (admin)` qualifier.
//
// Kept out of classifier.test.js on purpose: that file is already 800+ lines and
// this is its own question.

import { describe, it, expect } from 'vitest';
import { nameVariants, nameMatchLevel } from './classifier.js';

/** The single name an account carrying nothing but a display name reduces to. */
const parse = (displayName, givenName = null, surname = null) =>
  nameVariants(displayName, givenName, surname);
const one = (...args) => parse(...args)[0];

describe('nameVariants — the shapes a "Surname, Initials" source writes', () => {
  it('reads one initial, and keeps the surname whole', () => {
    expect(one('van Mourik, R.')).toMatchObject({
      surname: 'vanmourik', given: 'r', initial: 'r', initials: ['r'],
    });
  });

  it('reads every initial, spaced or not, as one sequence', () => {
    // Both spellings have to reduce to the same name, or the same person is two
    // different accounts depending on how their source types a space.
    expect(one('Buskes, L.R.')).toMatchObject({ given: 'lr', initials: ['l', 'r'] });
    expect(one('Buskes, L. R.')).toMatchObject({ given: 'lr', initials: ['l', 'r'] });
  });

  it('reads an undotted given token as a name (P3)', () => {
    // The paired case: one letter of evidence, not three. `Rob` keyed as `r,o,b`
    // would make it an all-initials match for an R.O.B. who does not exist.
    expect(one('Buskes, Rob')).toMatchObject({ given: 'rob', initials: ['r'] });
  });

  it('keeps the particles of a surname spelled beside initials', () => {
    expect(one('van der Steen, I.')).toMatchObject({ surname: 'vandersteen', initials: ['i'] });
  });

  it('keeps a double surname whole, and reads both initials', () => {
    expect(one('Hoftijzer-Nijland, J.C.')).toMatchObject({
      surname: 'hoftijzernijland', initials: ['j', 'c'],
    });
  });

  it('strips a role qualifier before reading the initials', () => {
    // `(admin)` is how the measured ERP marks an admin account; parsed as part
    // of the name it is neither a surname nor an initial.
    expect(one('Buskes, J.C. (admin)')).toMatchObject({ surname: 'buskes', initials: ['j', 'c'] });
  });

  it('reads the structured givenName column as a sequence before it collapses', () => {
    // The identity side of the same comparison. `fGiven` has always collapsed to
    // one token — `laurarene`, the accent dropped rather than folded (#1480) —
    // so the second initial only exists because the words are read first.
    expect(one('Laura Renée Buskes', 'Laura Renée', 'Buskes')).toMatchObject({
      given: 'laurarene', initials: ['l', 'r'],
    });
  });

  it('reads a middle name in a display name as a second initial', () => {
    // The display name collapses middle names out of `given` (so an
    // inconsistently-recorded one still matches), which is exactly why the
    // initials are taken from the words and not from `given`.
    expect(one('Lucas Robert Jansen')).toMatchObject({ given: 'lucas', initials: ['l', 'r'] });
  });

  it('leaves a bare surname with no initials to compare', () => {
    expect(one('Buskes')).toMatchObject({ surname: 'buskes', given: '', initials: [] });
  });
});

describe('nameMatchLevel — the initials rung', () => {
  const account = (dn) => one(dn);
  const person = (dn, given, sur) => one(dn, given, sur);

  it('matches at surnameInitials where both sides state two agreeing initials', () => {
    expect(nameMatchLevel(
      account('Buskes, L.R.'),
      person('Laura Renée Buskes', 'Laura Renée', 'Buskes'),
    )).toBe('surnameInitials');
  });

  it('refuses the match outright where two stated initials disagree (R1b)', () => {
    // Not a weaker match on the shared `L.` — no match at all. Falling back to
    // `surnameInitial` here is what would hand `Buskes, L.R.` to Lucas Willem.
    expect(nameMatchLevel(
      account('Buskes, L.R.'),
      person('Lucas Willem Buskes', 'Lucas Willem', 'Buskes'),
    )).toBe('none');
  });

  it('falls back to surnameInitial where only one side states two (R1)', () => {
    // Both directions, because the comparison is written over the shorter
    // sequence and a one-sided reading would drop one of them.
    expect(nameMatchLevel(
      account('Buskes, L.R.'),
      person('Lucas Buskes', 'Lucas', 'Buskes'),
    )).toBe('surnameInitial');
    expect(nameMatchLevel(
      account('Buskes, L.'),
      person('Lucas Robert Buskes', 'Lucas Robert', 'Buskes'),
    )).toBe('surnameInitial');
  });

  it('still prefers an exact spelling over an initials sequence', () => {
    // The ladder's top rung is unchanged: somebody actually called the name wins.
    expect(nameMatchLevel(
      person('L.R. Buskes', 'L.R.', 'Buskes'),
      account('Buskes, L.R.'),
    )).toBe('full');
  });

  it('is no match across surnames, however well the initials agree', () => {
    expect(nameMatchLevel(
      account('Buskes, L.R.'),
      person('Laura Renée Jansen', 'Laura Renée', 'Jansen'),
    )).toBe('none');
  });

  it('is no match on a surname alone', () => {
    expect(nameMatchLevel(account('Buskes'), person('Laura Buskes', 'Laura', 'Buskes'))).toBe('none');
  });
});

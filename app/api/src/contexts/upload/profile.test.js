import { describe, it, expect } from 'vitest';
import { splitValues, detectShape, profileColumns, isEmailLike } from './profile.js';

describe('splitValues', () => {
  it.each([
    ['a@x.nl; b@x.nl', ['a@x.nl', 'b@x.nl']],
    ['a@x.nl, b@x.nl', ['a@x.nl', 'b@x.nl']],
    ['one\ntwo\r\nthree', ['one', 'two', 'three']],
    // A semicolon wins over commas: names written "Surname, Given" stay whole.
    ['Doe, John; Roe, Jane', ['Doe, John', 'Roe, Jane']],
    ['  single  ', ['single']],
    [';;', []],
    [null, []],
  ])('%j → %j', (cell, expected) => {
    expect(splitValues(cell)).toEqual(expected);
  });
});

describe('detectShape', () => {
  it('needs 80 %: four e-mail addresses out of five is email, three is text', () => {
    expect(detectShape(['a@x.nl', 'b@x.nl', 'c@x.nl', 'd@x.nl', 'nope'])).toBe('email');
    expect(detectShape(['a@x.nl', 'b@x.nl', 'c@x.nl', 'nope', 'nope'])).toBe('text');
  });

  it('a cell of several addresses still counts as email', () => {
    expect(detectShape(['a@x.nl;b@x.nl'])).toBe('email');
  });

  it.each([[['12', '-3.5', '1.234.567'], 'number'], [['2026-10-01', '1-10-2026'], 'date'], [[], 'text']])('%j → %s', (values, shape) => {
    expect(detectShape(values)).toBe(shape);
  });

  it('isEmailLike rejects two addresses in one value', () => {
    expect(isEmailLike('a@x.nl')).toBe(true);
    expect(isEmailLike('a@x.nl;b@x.nl')).toBe(false);
  });
});

describe('profileColumns', () => {
  const rows = [
    { Naam: 'Acme', Leden: 'a@x.nl; b@x.nl', Leeg: '' },
    { Naam: 'Beta', Leden: 'c@x.nl', Leeg: '' },
    { Naam: 'Acme', Leden: 'd@x.nl', Leeg: ' ' },
  ];
  const [naam, leden, leeg] = profileColumns(['Naam', 'Leden', 'Leeg'], rows);

  it('counts distinct values over the filled ones and rounds uniqueness to three decimals', () => {
    expect(naam).toMatchObject({ index: 0, nonEmpty: 3, distinct: 2, uniqueness: 0.667, shape: 'text', samples: ['Acme', 'Beta'] });
  });

  it('measures the share of cells holding several values', () => {
    expect(leden).toMatchObject({ shape: 'email', multiValued: 0.333 });
  });

  it('an empty column has uniqueness 0, not NaN', () => {
    expect(leeg).toMatchObject({ nonEmpty: 0, uniqueness: 0, multiValued: 0, shape: 'text', samples: [] });
  });
});

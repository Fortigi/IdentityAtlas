import { describe, it, expect } from 'vitest';
import { splitValues, singleValue, cleanValue, lookupTokens, isLookupCell } from './cellValues.js';

describe('splitValues — plain cells', () => {
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

describe('splitValues — SharePoint lookup and person cells', () => {
  it.each([
    // name;#id pairs: the ids go, every name stays — not only the first one.
    ['Alice Example;#27;#Bob Sample;#16;#Carol Test;#26', ['Alice Example', 'Bob Sample', 'Carol Test']],
    ['Alice Example;#27', ['Alice Example']],
    // id first, as some exports write it
    ['27;#Alice Example;#16;#Bob Sample', ['Alice Example', 'Bob Sample']],
    // a name that is digits in a value position is kept
    ['2026;#5;#Bob Sample;#16', ['2026', 'Bob Sample']],
    // not alternating: digit-only tokens dropped
    ['Alice Example;#Bob Sample;#16', ['Alice Example', 'Bob Sample']],
    [' Alice Example ;# 27 ;#', ['Alice Example']],
    ['i:0#.f|membership|alice@example.com;#27;#i:0#.f|membership|bob@example.com;#16', ['alice@example.com', 'bob@example.com']],
  ])('%j → %j', (cell, expected) => {
    expect(splitValues(cell)).toEqual(expected);
  });

  it('a person claim or "Name <address>" becomes the address in a plain list too', () => {
    expect(splitValues('i:0#.f|membership|alice@example.com; Bob Sample <bob@example.com>'))
      .toEqual(['alice@example.com', 'bob@example.com']);
  });
});

describe('singleValue', () => {
  it.each([
    ['Alice Example;#27', 'Alice Example'],
    ['Alice Example;#27;#Bob Sample;#16', 'Alice Example'],
    ['Example, Alice', 'Example, Alice'],
    ['a@x.nl; b@x.nl', 'a@x.nl; b@x.nl'],
    ['i:0#.f|membership|alice@example.com', 'alice@example.com'],
    ['Alice Example <alice@example.com>', 'alice@example.com'],
    ['  Alice Example  ', 'Alice Example'],
    [';#27', ''],
    [null, ''],
  ])('%j → %j', (cell, expected) => {
    expect(singleValue(cell)).toBe(expected);
  });
});

describe('cleanValue', () => {
  it('a Windows claim keeps the account after its last bar', () => {
    expect(cleanValue('i:0#.w|corp\\alice')).toBe('corp\\alice');
  });

  it('only a trailing <address> counts; other angle brackets stay text', () => {
    expect(cleanValue('Alice <not an address>')).toBe('Alice <not an address>');
    expect(cleanValue('<alice@example.com> Alice')).toBe('<alice@example.com> Alice');
    expect(cleanValue('Alice < alice@example.com >')).toBe('alice@example.com');
  });

  it('a value that only looks claim-like is left alone', () => {
    expect(cleanValue('i:0 membership')).toBe('i:0 membership');
  });
});

describe('isLookupCell / lookupTokens', () => {
  it('a lookup is any cell with ";#"', () => {
    expect(isLookupCell('A;#1')).toBe(true);
    expect(isLookupCell('A;1 #2')).toBe(false);
    expect(isLookupCell(null)).toBe(false);
  });

  it('a lone token is kept unless it is only digits', () => {
    expect(lookupTokens('Alice')).toEqual(['Alice']);
    expect(lookupTokens('27')).toEqual([]);
    expect(lookupTokens(null)).toEqual([]);
    expect(cleanValue(undefined)).toBe('');
  });
});

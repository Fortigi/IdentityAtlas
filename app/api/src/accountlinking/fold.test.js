import { describe, it, expect } from 'vitest';
import { foldDiacritics, foldedToken } from './fold.js';

// The name-side and login-side behaviour this enables is asserted in
// classifier.test.js (#1480). Here: the helper's own two contracts — what the
// fold does to a letter, and what each of the two exports does to everything
// that is not one.
describe('foldDiacritics', () => {
  it('lower-cases and folds, leaving separators and punctuation where they are', () => {
    // The distinction from `foldedToken`: a dotted initials half (`Ö.R.`) is
    // only recognisable as one while its dots are still there.
    expect(foldDiacritics('Doğan-Yıldırım')).toBe('dogan-yildirim');
    expect(foldDiacritics('Ö.R.')).toBe('o.r.');
    expect(foldDiacritics('Sevgi  Doğan 2')).toBe('sevgi  dogan 2');
  });

  it('folds a letter NFKD decomposes, including one whose mark lower-casing creates', () => {
    expect(foldDiacritics('é')).toBe('e');
    // Turkish dotted İ lower-cases to 'i' + a combining dot, so the fold only
    // works in this order: the mark does not exist before the lower-case.
    expect(foldDiacritics('İ')).toBe('i');
    expect(foldDiacritics('İ'.toLowerCase())).toBe('i');
  });

  it('folds each letter NFKD leaves whole, one at a time', () => {
    // One input per mapped letter — a single name standing in for the whole map
    // would pass with any one of them missing.
    expect(foldDiacritics('ı')).toBe('i');
    expect(foldDiacritics('ł')).toBe('l');
    expect(foldDiacritics('ø')).toBe('o');
    expect(foldDiacritics('đ')).toBe('d');
    expect(foldDiacritics('ß')).toBe('ss');
    expect(foldDiacritics('æ')).toBe('ae');
    expect(foldDiacritics('œ')).toBe('oe');
    expect(foldDiacritics('þ')).toBe('th');
    expect(foldDiacritics('ð')).toBe('d');
  });

  it('folds the upper case of a mapped letter too', () => {
    // The map is keyed lower-cased, so an upper-case Ø only folds because the
    // lower-case runs first.
    expect(foldDiacritics('Ø')).toBe('o');
    expect(foldDiacritics('Łukasz Æblegaard')).toBe('lukasz aeblegaard');
  });

  it('is empty for nothing at all', () => {
    expect(foldDiacritics(null)).toBe('');
    expect(foldDiacritics(undefined)).toBe('');
    expect(foldDiacritics('')).toBe('');
  });
});

describe('foldedToken', () => {
  it('folds, then drops everything outside [a-z0-9]', () => {
    expect(foldedToken('Doğan-Yıldırım')).toBe('doganyildirim');
    expect(foldedToken('Ö.R.')).toBe('or');
    expect(foldedToken('Sevgi  Doğan 2')).toBe('sevgidogan2');
  });

  it('still drops a letter the fold has no ASCII base for', () => {
    // The strip stays as the final guard: a script this cannot fold must not
    // reach a comparison half-folded.
    expect(foldedToken('Ωmega')).toBe('mega');
    expect(foldedToken('Иванов')).toBe('');
  });

  it('is empty for nothing at all', () => {
    expect(foldedToken(null)).toBe('');
    expect(foldedToken('')).toBe('');
  });
});

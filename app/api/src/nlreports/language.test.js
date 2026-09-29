// Which language a question is in — the word-list detector, at its thresholds.
// Every answer records the language it detected, which is how language parity is
// counted rather than argued about, so the boundaries matter more than the
// average case.
import { describe, it, expect } from 'vitest';
import { detectLanguage, LANGUAGES } from './language.js';

describe('detectLanguage', () => {
  it('reads a real Dutch question as Dutch', () => {
    expect(detectLanguage('Wie heeft toegang tot de groep Finance?')).toBe('nl');
  });

  it('reads a real English question as English', () => {
    expect(detectLanguage('Which groups is Jan de Vries a member of?')).toBe('en');
  });

  it('needs TWO markers in a normal-length question, not one', () => {
    // The threshold, from both sides. One marker in a long sentence is a loan
    // word or a name fragment; two is a language. A `>= 1` rule passes the
    // second of these and fails here.
    const one = 'show me the access for everyone in the group';
    const two = 'welke groepen heeft deze persoon precies gekregen';
    expect(detectLanguage(one)).toBe('en');
    expect(detectLanguage(two)).toBe('nl');
  });

  it('accepts a single marker only when the question is three words or shorter', () => {
    expect(detectLanguage('toegang tot Finance')).toBe('nl');
    expect(detectLanguage('access to Finance for everyone')).toBe('en');
    expect(detectLanguage('show toegang for everyone')).toBe('en');    // 1 marker, 4 words
  });

  it('defaults to English for input with no words at all', () => {
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage(null)).toBe('en');
    expect(detectLanguage('42 ???')).toBe('en');
  });

  it('answers with one of the languages it declares', () => {
    for (const question of ['welke groepen heb ik', 'which groups do I have', '']) {
      expect(LANGUAGES).toContain(detectLanguage(question));
    }
  });
});

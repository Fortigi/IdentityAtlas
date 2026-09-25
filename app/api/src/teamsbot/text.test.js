import { describe, it, expect } from 'vitest';
import { detectLanguage, strings, LANGUAGES, EN, NL } from './text.js';

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
    // A minimal pair: same seven words, one of them swapped for a marker.
    const one = 'report on the rol for each owner of a group';      // markers: rol
    const two = 'report on the rol for each eigenaar of a group';   // markers: rol, eigenaar
    expect(detectLanguage(one)).toBe('en');
    expect(detectLanguage(two)).toBe('nl');
  });

  it('accepts a single marker only when the question is three words or shorter', () => {
    // The short-question escape hatch, at its boundary: same single marker,
    // three words vs four.
    expect(detectLanguage('toegang tot Finance')).toBe('nl');
    expect(detectLanguage('toegang tot de Finance groep')).toBe('nl'); // 3 markers
    expect(detectLanguage('access to Finance for everyone')).toBe('en');
    expect(detectLanguage('show toegang for everyone')).toBe('en');    // 1 marker, 4 words
  });

  it('defaults to English for input with no words at all', () => {
    // English is the deliberate default; an empty question must not fall into
    // the "hits >= 1 and length <= 3" branch by counting 0 >= 1 as true.
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage('   ?!  ')).toBe('en');
    expect(detectLanguage(null)).toBe('en');
    expect(detectLanguage(undefined)).toBe('en');
  });

  it('ignores case, so a capitalised question is still Dutch', () => {
    expect(detectLanguage('WIE HEEFT TOEGANG?')).toBe('nl');
  });
});

describe('strings', () => {
  it('returns the table for each declared language', () => {
    expect(strings('en')).toBe(EN);
    expect(strings('nl')).toBe(NL);
  });

  it('falls back to English for an unknown, missing or hostile key', () => {
    // 'constructor' and '__proto__' resolve to inherited members on a plain
    // object lookup, which would hand back a function instead of a table.
    expect(strings('de')).toBe(EN);
    expect(strings(undefined)).toBe(EN);
    expect(strings('constructor')).toBe(EN);
    expect(strings('__proto__')).toBe(EN);
  });

  it('gives every language the same keys, so no reply can come back undefined', () => {
    const reference = Object.keys(EN).sort();
    for (const lang of LANGUAGES) {
      expect(Object.keys(strings(lang)).sort(), `${lang} is missing keys`).toEqual(reference);
    }
  });

  it('pluralises the record count in both languages', () => {
    expect(EN.records(1)).toBe('1 record.');
    expect(EN.records(2)).toBe('2 records.');
    expect(NL.records(1)).toBe('1 record.');
    expect(NL.records(2)).toBe('2 records.');
  });

  it('pluralises the hidden-column note, which is where a singular reads worst', () => {
    expect(EN.moreColumns(1)).toContain('1 more column is');
    expect(EN.moreColumns(3)).toContain('3 more columns are');
    expect(NL.moreColumns(1)).toContain('nog 1 kolom');
    expect(NL.moreColumns(3)).toContain('nog 3 kolommen');
  });

  it('builds every formatted string in both languages, with the values in them', () => {
    // Each of these is a function, so a language whose table shipped a half-
    // written one is only caught by calling it. The values must appear in the
    // output — a template that dropped its argument still returns a sentence.
    for (const t of LANGUAGES.map(strings)) {
      expect(t.showing(10, 42)).toContain('10');
      expect(t.showing(10, 42)).toContain('42');
      expect(t.timeoutHint(180)).toContain('180');
      expect(t.fuzzy('Jan de Vr', 'Jan de Vries')).toContain('Jan de Vr');
      expect(t.fuzzy('Jan de Vr', 'Jan de Vries')).toContain('Jan de Vries');
      expect(t.records(7)).toContain('7');
      expect(t.moreColumns(2)).toContain('2');
      expect(t.working('Wim')).toContain('Wim');
    }
  });

  it('greets by name, and still reads as a sentence when there is no name', () => {
    // Both branches of the greeting, in both languages. The nameless one is
    // where this breaks in front of a user: a template that keeps the comma
    // says "Hoi , ik heb je bericht ontvangen", and one that interpolates the
    // missing name anyway says "Hi null". Neither is caught by the loop above,
    // which only ever passes a name.
    expect(EN.working('Wim')).toContain('Hi Wim,');
    expect(NL.working('Wim')).toContain('Hoi Wim,');

    for (const t of LANGUAGES.map(strings)) {
      for (const nameless of [null, undefined, '']) {
        const greeting = t.working(nameless);
        expect(greeting).not.toContain('null');
        expect(greeting).not.toContain('undefined');
        expect(greeting).not.toContain(' ,');
        expect(greeting.length).toBeGreaterThan(20);
      }
    }
  });

  it('offers three examples per language, and the Dutch ones are actually Dutch', () => {
    expect(EN.examples).toHaveLength(3);
    expect(NL.examples).toHaveLength(3);
    for (const example of NL.examples) {
      expect(detectLanguage(example), `not detected as Dutch: ${example}`).toBe('nl');
    }
  });
});

import { describe, it, expect } from 'vitest';
import { locateQuote, labelKey, mentionedIn, splitList, MIN_QUOTE_CHARS } from './evidence.js';

const passage = { startChar: 100, text: 'Op dit moment bestaat het bestuur uit Wim, Gregor en Eddie. Jaarlijks rouleert er één.' };

describe('locateQuote', () => {
  it('finds an exact quote and answers with source offsets', () => {
    const q = 'bestaat het bestuur uit Wim, Gregor en Eddie';
    const r = locateQuote(passage, q);
    expect(r).toEqual({ startChar: 100 + passage.text.indexOf(q), endChar: 100 + passage.text.indexOf(q) + q.length, quote: q, exact: true });
  });

  it('repairs case, spacing and dropped punctuation but returns the SOURCE text', () => {
    const r = locateQuote(passage, 'het Bestuur uit Wim Gregor  en Eddie');
    expect(r.exact).toBe(false);
    expect(r.quote).toBe('het bestuur uit Wim, Gregor en Eddie');
    expect(passage.text.slice(r.startChar - 100, r.endChar - 100)).toBe(r.quote);
  });

  it('strips quote marks and trailing punctuation the model added', () => {
    expect(locateQuote(passage, '"Jaarlijks rouleert er één."').quote).toBe('Jaarlijks rouleert er één');
  });

  it('refuses a paraphrase and a too-short quote', () => {
    expect(locateQuote(passage, 'het bestuur bestaat uit drie mensen')).toBeNull();
    expect(locateQuote(passage, 'Wim')).toBeNull();
    expect('Gregor'.length).toBeLessThan(MIN_QUOTE_CHARS);
    expect(locateQuote(passage, '')).toBeNull();
    expect(locateQuote(passage, null)).toBeNull();
  });
});

describe('labelKey / mentionedIn', () => {
  it('folds case, accents and hyphens', () => {
    expect(labelKey('Omada-kernteam')).toBe('omada kernteam');
    expect(labelKey(' Één  Bedrijf ')).toBe('een bedrijf');
  });

  it('needs every significant word, allowing a shared prefix of four letters', () => {
    expect(mentionedIn('IT-commissie', 'De IT commissie verzorgt dat')).toBe(true);
    expect(mentionedIn('commissie', 'de commissies regelen dat')).toBe(true);
    expect(mentionedIn('het bestuur', 'Er is een bestuur')).toBe(true);
    expect(mentionedIn('Omada-kernteam', 'het kernteam van Rob')).toBe(false);
    expect(mentionedIn('de', 'de')).toBe(false);
  });
});

describe('splitList', () => {
  it('splits commas, "en", "and", "&"', () => {
    expect(splitList('Led, Rob, Mark en Taake')).toEqual(['Led', 'Rob', 'Mark', 'Taake']);
    expect(splitList('Anna and Bob')).toEqual(['Anna', 'Bob']);
    expect(splitList('R&D')).toEqual(['R&D']);
    expect(splitList('Contoso Retail')).toEqual(['Contoso Retail']);
  });
});

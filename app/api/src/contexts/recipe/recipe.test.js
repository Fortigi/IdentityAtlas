import { describe, it, expect } from 'vitest';
import {
  defaultMatchFor, likePattern, MAX_PINNED, MAX_TERMS, normalizeText, termMatches, validateRecipe,
} from './recipe.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

// The SQL side pads normalised text with a space on both ends; the tests do the same.
const hay = (s) => ` ${normalizeText(s)} `;

describe('normalizeText', () => {
  it('reduces separators of every kind to single spaces, lowercased', () => {
    expect(normalizeText('SG_INKOOP-Users (P&O)')).toBe('sg inkoop users p o');
  });

  it('keeps accented letters and digits', () => {
    expect(normalizeText('Financiële   Zaken 2024')).toBe('financiële zaken 2024');
  });
});

describe('term matching', () => {
  it('token matches a whole word only', () => {
    expect(termMatches(hay('SG_INK_Users'), 'ink', 'token')).toBe(true);
    expect(termMatches(hay('Link-Users'), 'ink', 'token')).toBe(false);
    expect(termMatches(hay('Inkoop'), 'ink', 'token')).toBe(false);
  });

  it('wordStart matches the start of a word, not the middle', () => {
    expect(termMatches(hay('Inkoopfacturen'), 'inkoop', 'wordStart')).toBe(true);
    expect(termMatches(hay('Herinkoop'), 'inkoop', 'wordStart')).toBe(false);
  });

  it('contains matches anywhere', () => {
    expect(termMatches(hay('Herinkoop'), 'inkoop', 'contains')).toBe(true);
  });

  it('a multi-word term matches across any separators in the name', () => {
    expect(termMatches(hay('Azure_DevOps-Readers'), normalizeText('Azure DevOps'), 'wordStart')).toBe(true);
  });

  it('builds LIKE patterns that mean the same as termMatches', () => {
    expect(likePattern('ink', 'token')).toBe('% ink %');
    expect(likePattern('inkoop', 'wordStart')).toBe('% inkoop%');
    expect(likePattern('inkoop', 'contains')).toBe('%inkoop%');
  });

  it('defaults short terms to whole words and longer ones to word start', () => {
    expect(defaultMatchFor('p o')).toBe('token');   // "P&O": two letters once spaces are ignored
    expect(defaultMatchFor('ink')).toBe('token');
    expect(defaultMatchFor('vsts')).toBe('wordStart');
  });
});

describe('validateRecipe', () => {
  it('fills the defaults for an empty but usable recipe', () => {
    const { ok, recipe } = validateRecipe({ terms: ['inkoop'] });
    expect(ok).toBe(true);
    expect(recipe).toMatchObject({
      version: 1, target: 'resource', resourceTypes: ['Group'], fields: ['displayName', 'description'],
      include: [], exclude: [], structure: 'byTerm',
    });
    expect(recipe.terms).toEqual([{ text: 'inkoop', key: 'inkoop', match: 'wordStart', state: 'accepted', origin: 'analyst' }]);
  });

  it('is not usable without a kept term or an included object', () => {
    const r = validateRecipe({ terms: [{ text: 'inkoop', state: 'rejected' }] });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('Keep at least one term, or include at least one object.');
    expect(validateRecipe({ include: [ID_A] }).ok).toBe(true);
  });

  it('drops terms that differ only in case or punctuation, keeping the first', () => {
    const { recipe } = validateRecipe({ terms: [{ text: 'P&O', state: 'rejected' }, 'p o', 'P-O'] });
    expect(recipe.terms).toHaveLength(1);
    expect(recipe.terms[0]).toMatchObject({ text: 'P&O', state: 'rejected' });
  });

  it('rejects terms too short to search for, and says so', () => {
    const { recipe, errors } = validateRecipe({ terms: ['x', '  ', 'ok'] });
    expect(recipe.terms.map(t => t.text)).toEqual(['ok']);
    expect(errors).toEqual(['"x" is too short to search for.']);
  });

  it('keeps only known fields, match modes, states and structures', () => {
    const { recipe } = validateRecipe({
      fields: ['description', '"Resources"; DROP', 'mail'],
      terms: [{ text: 'inkoop', match: 'regex', state: 'maybe', origin: 'hacker' }],
      structure: 'nested',
    });
    expect(recipe.fields).toEqual(['description', 'mail']);
    expect(recipe.terms[0]).toMatchObject({ match: 'wordStart', state: 'accepted', origin: 'analyst' });
    expect(recipe.structure).toBe('byTerm');
  });

  it('falls back to the default fields when none of the requested ones exist', () => {
    expect(validateRecipe({ terms: ['x1'], fields: ['password'] }).recipe.fields).toEqual(['displayName', 'description']);
  });

  it('caps the number of terms and says so', () => {
    const many = Array.from({ length: MAX_TERMS + 5 }, (_, i) => `term${i}`);
    const { recipe, errors } = validateRecipe({ terms: many });
    expect(recipe.terms).toHaveLength(MAX_TERMS);
    expect(errors).toContain(`A context can have at most ${MAX_TERMS} terms.`);
  });

  it('accepts only uuid ids, de-duplicated, and lets exclude win over include', () => {
    const { recipe } = validateRecipe({ include: [ID_A, ID_A, ID_B, 'not-an-id', 42], exclude: [ID_B] });
    expect(recipe.include).toEqual([ID_A]);
    expect(recipe.exclude).toEqual([ID_B]);
  });

  it('caps pinned objects', () => {
    const ids = Array.from({ length: MAX_PINNED + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const { recipe, errors } = validateRecipe({ include: ids });
    expect(recipe.include).toHaveLength(MAX_PINNED);
    expect(errors).toContain(`At most ${MAX_PINNED} included objects.`);
  });

  it('never throws on garbage', () => {
    for (const raw of [null, undefined, 'x', [], 42, { terms: 'inkoop', include: 'x' }]) {
      expect(() => validateRecipe(raw)).not.toThrow();
      expect(validateRecipe(raw).ok).toBe(false);
    }
  });

  it('keeps a short reason from the model, trimmed', () => {
    const { recipe } = validateRecipe({ terms: [{ text: 'Coupa', why: '  system  ' }] });
    expect(recipe.terms[0].why).toBe('system');
  });
});

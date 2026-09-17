import { describe, it, expect, vi } from 'vitest';
import { validateRecipe } from './recipe.js';
import { loadScopeNames, MAX_SUGGESTIONS, relatedWords } from './relatedWords.js';

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = (names) => names.map((displayName, i) => ({ id: ID(i), displayName }));
const recipeOf = (raw) => validateRecipe(raw).recipe;

describe('relatedWords', () => {
  // 0-3: DevOps groups (in the context). 4-9: other groups; "project" is everywhere.
  const rows = scope([
    'DevOps - DLL - B2C', 'VSTS-DLL-Members', 'VSTS-NIBC-Project', 'DevOps - NIBC - Admins',
    'Customer project Enexis', 'Customer project Evides', 'Project Alfam', 'License Power BI', 'License Fabric', 'Planning project',
  ]);
  const inContext = [ID(0), ID(1), ID(2), ID(3)];

  it('ranks words that are typical of the context above words that are everywhere', () => {
    const words = relatedWords(rows, inContext, recipeOf({ terms: ['devops'] }));
    expect(words.map(w => w.word)).toEqual(['dll', 'nibc', 'vsts']);
    expect(words[0]).toEqual({ word: 'dll', inContext: 2, outside: 0, lift: 2.5 });
    // "project" is in 5 of 10 names but only 1 of the 4 in the context: lift 0.5, not suggested.
    expect(words.find(w => w.word === 'project')).toBeUndefined();
  });

  it('never suggests a word a term already finds, or role / environment noise', () => {
    const words = relatedWords(rows, inContext, recipeOf({ terms: ['devops', { text: 'vst', match: 'wordStart' }] })).map(w => w.word);
    expect(words).not.toContain('vsts');     // "vst" (word start) already finds it
    expect(words).not.toContain('devops');
    expect(words).not.toContain('members');  // a stopword in resource-cluster's list
    expect(words).not.toContain('admins');
  });

  it('never suggests connective words, however typical', () => {
    const names = scope(['License for Power BI', 'License for Fabric', 'Teams Enexis', 'Teams Evides']);
    const words = relatedWords(names, [ID(0), ID(1)], recipeOf({ terms: ['license'] })).map(w => w.word);
    expect(words).toContain('power');
    expect(words).not.toContain('for');
  });

  it('needs a word to recur in the context, unless the context is tiny', () => {
    const recipe = recipeOf({ terms: ['devops'] });
    // Context of 4: a word seen once there ("b2c") is a coincidence.
    expect(relatedWords(rows, inContext, recipe).map(w => w.word)).not.toContain('b2c');
    // Context of 2: once is enough.
    expect(relatedWords(rows, [ID(0), ID(3)], recipe).map(w => w.word)).toContain('b2c');
  });

  it('returns nothing without a context or a scope', () => {
    expect(relatedWords(rows, [], recipeOf({ terms: ['x1'] }))).toEqual([]);
    expect(relatedWords([], inContext, recipeOf({ terms: ['x1'] }))).toEqual([]);
  });

  it('caps the number of suggestions', () => {
    // 20 distinct words, each in two of the 40 context objects and nowhere else: all qualify.
    const inside = scope(Array.from({ length: 40 }, (_, i) => `topic${Math.floor(i / 2)}x`));
    const outside = Array.from({ length: 40 }, (_, i) => ({ id: ID(100 + i), displayName: `other${i}x` }));
    const words = relatedWords([...inside, ...outside], inside.map(r => r.id), recipeOf({ terms: ['zz'] }));
    expect(words).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe('loadScopeNames', () => {
  it('reads names read-only, scoped to the recipe resource types', async () => {
    const calls = [];
    const client = { query: vi.fn(async (text, params) => { calls.push([text, params]); return { rows: text.startsWith('SET') ? [] : [{ id: 'a', displayName: 'b' }] }; }) };
    const rows = await loadScopeNames(recipeOf({ terms: ['x1'], resourceTypes: ['Group', 'AppRole'] }), fn => fn(client));
    expect(calls[0][0]).toBe('SET TRANSACTION READ ONLY');
    expect(calls[2][1]).toEqual([['Group', 'AppRole']]);
    expect(rows).toEqual([{ id: 'a', displayName: 'b' }]);
  });
});

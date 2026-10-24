import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ tx: vi.fn() }));

import plugin, { buildTree } from './context-recipe.js';
import { validateRecipe } from '../recipe/recipe.js';
import { computeMatches } from '../recipe/matches.js';

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n, name) => ({ id: ID(n), displayName: name, resourceType: 'Group', f0: ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `, f1: '  ' });
const ROWS = [row(1, 'Inkoop Users'), row(2, 'Procurement Inkoop'), row(3, 'Procurement Readers'), row(4, 'Something else')];

function treeFor(raw) {
  const { recipe } = validateRecipe(raw);
  return buildTree(recipe, computeMatches(ROWS, recipe, 100));
}

describe('context-recipe plugin — buildTree', () => {
  it('byTerm: a root, a child per kept term in term order, members under each term that finds them', () => {
    // "procurement" is listed first but finds its first object after "inkoop" does.
    const { contexts, members } = treeFor({ name: 'Inkoopproces', terms: ['procurement', 'inkoop'] });
    expect(contexts.map(c => [c.externalId, c.parentExternalId, c.displayName])).toEqual([
      ['root', undefined, 'Inkoopproces'],
      ['term:procurement', 'root', 'procurement'],
      ['term:inkoop', 'root', 'inkoop'],
    ]);
    expect(members).toEqual([
      { contextExternalId: 'term:procurement', memberId: ID(2) },
      { contextExternalId: 'term:procurement', memberId: ID(3) },
      { contextExternalId: 'term:inkoop', memberId: ID(1) },
      { contextExternalId: 'term:inkoop', memberId: ID(2) },
    ]);
    expect(contexts[0].description).toBe('3 objects found by: procurement, inkoop.');
  });

  it('byTerm: objects included by hand get their own child; excluded ones appear nowhere', () => {
    const { contexts, members } = treeFor({ name: 'X', terms: ['inkoop'], include: [ID(4)], exclude: [ID(2)] });
    expect(contexts.map(c => c.externalId)).toEqual(['root', 'term:inkoop', 'pinned']);
    expect(members).toEqual([
      { contextExternalId: 'term:inkoop', memberId: ID(1) },
      { contextExternalId: 'pinned', memberId: ID(4) },
    ]);
  });

  it('byTerm: a kept term that finds nothing gets no child', () => {
    const { contexts } = treeFor({ name: 'X', terms: ['inkoop', 'nowhere'] });
    expect(contexts.map(c => c.externalId)).toEqual(['root', 'term:inkoop']);
  });

  it('flat: every member once, on the root', () => {
    const { contexts, members } = treeFor({ name: 'X', terms: ['procurement', 'inkoop'], structure: 'flat' });
    expect(contexts).toHaveLength(1);
    expect(members.map(m => m.memberId)).toEqual([ID(1), ID(2), ID(3)]);
    expect(members.every(m => m.contextExternalId === 'root')).toBe(true);
  });

  it('records the recipe summary on the root, and names a nameless tree', () => {
    const { contexts } = treeFor({ terms: ['inkoop', { text: 'dropped1', state: 'rejected' }] });
    expect(contexts[0].displayName).toBe('Context');
    expect(contexts[0].extendedAttributes).toEqual({
      builtWith: 'context-assistant', terms: ['inkoop'], fields: ['displayName', 'description'], resourceTypes: ['Group'],
    });
  });
});

describe('context-recipe plugin — run', () => {
  it('is hidden from the generic plugin picker and targets resources', () => {
    expect(plugin).toMatchObject({ name: 'context-recipe', hidden: true, targetType: 'Resource' });
    expect(plugin.parametersSchema.required).toEqual(['recipe']);
  });

  it('refuses a recipe that cannot produce a context', async () => {
    await expect(plugin.run({ recipe: { terms: [] } }, { tx: vi.fn() })).rejects.toThrow('Keep at least one term');
  });

  it('loads candidates read-only and logs when the result was cut off', async () => {
    const queries = [];
    const client = {
      query: async (text) => {
        queries.push(text);
        if (text.includes('count(*)')) return { rows: [{ n: 4 }] };
        if (text.startsWith('SET')) return { rows: [] };
        return { rows: Array.from({ length: 5001 }, (_, i) => row(i, `Inkoop ${i}`)) };
      },
    };
    const log = vi.fn();
    const result = await plugin.run({ recipe: { name: 'X', terms: ['inkoop'], structure: 'flat' } }, { tx: fn => fn(client), log });
    expect(queries[0]).toBe('SET TRANSACTION READ ONLY');
    expect(result.members).toHaveLength(5000);
    expect(log).toHaveBeenCalledWith('More than 5000 objects matched; the rest were left out.');
  });
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js');   // the shared manual mock; every run here passes its own ctx.tx

import plugin, { PLUGIN_NAME } from './context-recipe-principals.js';
import resourcePlugin from './context-recipe.js';

const ID = (prefix, n) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const norm = (s) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

// One transaction answering every statement a principal recipe run makes.
function fakeTx() {
  const answer = (sql) => {
    if (sql.includes('count(*)::int AS n')) return [{ n: 40 }];
    if (sql.includes('FROM "Resources" r')) {
      return [{ id: ID('1', 1), displayName: 'SG_Contoso_Users', resourceType: 'Group', f0: norm('SG_Contoso_Users'), f1: '  ' }];
    }
    if (sql.includes('AS "entityId"')) return [{ entityId: ID('2', 1), principalId: ID('3', 2) }];
    if (sql.includes('FROM "OrgEntities" e')) return [{ id: ID('2', 1), entityType: 'Klant', displayName: 'Contoso Bank', f0: norm('Contoso Bank'), termScope: true }];
    if (sql.includes('FROM "ResourceAssignments"')) return [{ resourceId: ID('1', 1), principalId: ID('3', 1), assignmentType: 'Direct' }];
    return [];
  };
  return async (fn) => fn({ query: async (sql) => ({ rows: answer(sql) }) });
}

describe('context-recipe-principals plugin', () => {
  it('is a hidden Principal-target twin of context-recipe', () => {
    expect([plugin.name, plugin.targetType, plugin.hidden]).toEqual([PLUGIN_NAME, 'Principal', true]);
    expect(PLUGIN_NAME).toBe('context-recipe-principals');
    expect(resourcePlugin.targetType).toBe('Resource');
  });

  it('builds the users tree: the group members and the org entity members under the term', async () => {
    const out = await plugin.run({ recipe: { name: 'Users with access to Contoso', target: 'principal', terms: ['contoso'] } }, { tx: fakeTx() });
    expect(out.contexts.map(c => [c.externalId, c.description])).toEqual([
      ['root', '2 users found by: contoso.'],
      ['term:contoso', '2 users found by "contoso".'],
    ]);
    expect(out.members).toEqual([
      { contextExternalId: 'term:contoso', memberId: ID('3', 1) },
      { contextExternalId: 'term:contoso', memberId: ID('3', 2) },
    ]);
  });

  it('refuses a resource recipe, and the resource plugin refuses a principal recipe', async () => {
    await expect(plugin.run({ recipe: { name: 'X', terms: ['contoso'] } }, { tx: fakeTx() }))
      .rejects.toThrow('This recipe collects resources; it belongs to the other context-recipe plugin.');
    await expect(resourcePlugin.run({ recipe: { name: 'X', target: 'principal', terms: ['contoso'] } }, { tx: fakeTx() }))
      .rejects.toThrow('This recipe collects principals');
  });

  it('refuses a recipe that cannot run', async () => {
    await expect(plugin.run({ recipe: { target: 'principal', terms: [] } }, { tx: fakeTx() })).rejects.toThrow('cannot be used');
  });

  it('logs when the resource candidates were cut off', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: ID('1', i), displayName: `Contoso ${i}`, resourceType: 'Group', f0: ` contoso ${i} `, f1: '  ' }));
    const tx = async (fn) => fn({ query: async (sql) => ({ rows: sql.includes('FROM "Resources" r') && !sql.includes('count(') ? many : [] }) });
    const log = vi.fn();
    await plugin.run({ recipe: { target: 'principal', terms: ['contoso'] } }, { tx, log });
    expect(log).toHaveBeenCalledWith('More than 5000 resources matched; the rest were left out.');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('logs when the organisation entities were cut off', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: ID('2', i), entityType: 'Klant', displayName: `Contoso ${i}`, f0: ` contoso ${i} `, termScope: true }));
    const tx = async (fn) => fn({ query: async (sql) => ({ rows: sql.includes('FROM "OrgEntities" e') && !sql.includes('AS "entityId"') ? many : [] }) });
    const log = vi.fn();
    await plugin.run({ recipe: { target: 'principal', terms: ['contoso'] } }, { tx, log });
    expect(log.mock.calls).toEqual([['More organisation entities matched than can be used; the rest were left out.']]);
  });
});

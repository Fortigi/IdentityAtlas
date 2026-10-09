import { describe, it, expect } from 'vitest';
import { linkStats } from './stats.js';

// Placeholder contract test: workstream T2 replaces this file together with stats.js.
describe('linkStats (stub)', () => {
  const entities = [
    { entityType: 'Person', displayName: 'Ann', attributes: { email: 'ann@example.com' } },
    { entityType: 'Person', displayName: 'Bob', attributes: { email: 'bob@example.com' } },
    { entityType: 'Project', displayName: 'Atlas', attributes: {} },
  ];

  it('reports every entity of a ruled type as unmatched, one block per rule', async () => {
    const out = await linkStats(entities, [{ entityType: 'Person', targetType: 'Principal', signals: [] }]);
    expect(Object.keys(out)).toEqual(['Person']);
    expect(out.Person).toMatchObject({ total: 2, unique: 0, ambiguous: 0, none: 2, notBuilt: true });
  });

  it('reports nothing when there are no rules', async () => {
    expect(await linkStats(entities, [])).toEqual({});
    expect(await linkStats(entities, undefined)).toEqual({});
  });
});

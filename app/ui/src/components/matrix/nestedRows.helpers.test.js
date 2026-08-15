import { describe, it, expect } from 'vitest';
import { buildDisplayGroups } from './nestedRows.js';

const ctx = (o = {}) => ({
  expandedGroups: new Set(),
  nestedDataCache: new Map(),
  nestedMemberships: new Map(),
  users: [{ id: 'u1' }],
  resourceContextMap: new Map(),
  ...o,
});

describe('buildDisplayGroups', () => {
  it('returns the ordered groups unchanged when nothing is expanded', () => {
    const ordered = [{ id: 'r1' }];
    expect(buildDisplayGroups(ordered, ctx())).toBe(ordered);
  });

  it('injects a synthetic nested row after an expanded group', () => {
    const ordered = [{ id: 'r1' }];
    const result = buildDisplayGroups(ordered, ctx({
      expandedGroups: new Set(['r1']),
      nestedDataCache: new Map([['r1', { groups: [{ groupId: 'n1', displayName: 'Nested 1' }] }]]),
      nestedMemberships: new Map([['r1__nested__n1|u1', new Set(['Direct'])]]),
    }));
    expect(result.map(g => g.id)).toEqual(['r1', 'r1__nested__n1']);
    expect(result[1]).toMatchObject({
      isNestedRow: true, nestLevel: 1, parentGroupId: 'r1', memberCount: 1, nonIndirectCount: 1,
    });
  });

  it('counts an Indirect-only nested membership as a member but not a non-indirect', () => {
    const result = buildDisplayGroups([{ id: 'r1' }], ctx({
      expandedGroups: new Set(['r1']),
      nestedDataCache: new Map([['r1', { groups: [{ groupId: 'n1' }] }]]),
      nestedMemberships: new Map([['r1__nested__n1|u1', new Set(['Indirect'])]]),
    }));
    expect(result[1]).toMatchObject({ memberCount: 1, nonIndirectCount: 0 });
  });
});

import { describe, it, expect } from 'vitest';
import { buildMatrixModel, hasNonIndirect, compareGroupsByPriority } from './matrixModel.js';

const opts = (o = {}) => ({
  groupTagMap: undefined,
  resourceContextMap: new Map(),
  sortAttrs: [{ attribute: 'department' }],
  hierActive: false,
  hierDepth: 0,
  hierPaths: new Map(),
  ...o,
});

describe('hasNonIndirect', () => {
  it('is true only when the set holds a non-Indirect type', () => {
    expect(hasNonIndirect(new Set(['Indirect']))).toBe(false);
    expect(hasNonIndirect(new Set(['Indirect', 'Direct']))).toBe(true);
  });
});

describe('compareGroupsByPriority', () => {
  it('orders by Direct, then Eligible, then total member count', () => {
    expect(compareGroupsByPriority({ directCount: 2 }, { directCount: 1 })).toBeLessThan(0);
    expect(compareGroupsByPriority({ directCount: 1, eligibleCount: 1 }, { directCount: 1, eligibleCount: 3 })).toBeGreaterThan(0);
    expect(compareGroupsByPriority({ directCount: 1, eligibleCount: 1, memberCount: 5 }, { directCount: 1, eligibleCount: 1, memberCount: 2 })).toBeLessThan(0);
  });
});

describe('buildMatrixModel', () => {
  const data = [
    { memberId: 'u1', memberDisplayName: 'Alice', department: 'Eng', resourceId: 'r1', resourceDisplayName: 'R1', membershipType: 'Direct', managedByAccessPackage: true },
    { memberId: 'u2', memberDisplayName: 'Bob', department: 'Sales', resourceId: 'r1', membershipType: 'Indirect' },
    { memberId: 'u1', resourceId: 'r2', resourceDisplayName: 'R2', membershipType: 'Eligible' },
  ];

  it('dedupes subjects and sorts them by the sort attribute', () => {
    const { users } = buildMatrixModel(data, opts());
    expect(users.map(u => u.id)).toEqual(['u1', 'u2']); // Eng before Sales
  });

  it('records per-cell membership types and the managed-by-AP flag', () => {
    const { memberships, managedMap } = buildMatrixModel(data, opts());
    expect([...memberships.get('r1|u1')]).toEqual(['Direct']);
    expect([...memberships.get('r2|u1')]).toEqual(['Eligible']);
    expect(managedMap.get('r1|u1')).toBe(true);
    expect(managedMap.has('r1|u2')).toBe(false);
  });

  it('counts members per resource row and sorts by membership priority', () => {
    const { groups } = buildMatrixModel(data, opts());
    const r1 = groups.find(g => g.id === 'r1');
    expect(r1).toMatchObject({ memberCount: 2, directCount: 1 });
    expect(groups[0].id).toBe('r1'); // r1 has a Direct member, so it sorts first
  });

  it('uses hierarchy paths as sort keys when hierActive', () => {
    const { users } = buildMatrixModel(
      [{ memberId: 'u1', resourceId: 'r1', membershipType: 'Direct' }],
      opts({ hierActive: true, hierDepth: 2, hierPaths: new Map([['u1', ['A', 'B']]]) }),
    );
    expect(users[0].sortKeys).toEqual(['A', 'B']);
  });

  it('reads group tags from the (uppercased) tag map', () => {
    const { groups } = buildMatrixModel(
      [{ memberId: 'u1', resourceId: 'r1', membershipType: 'Direct' }],
      opts({ groupTagMap: new Map([['R1', [{ name: 'pii' }]]]) }),
    );
    expect(groups[0].tags).toEqual([{ name: 'pii' }]);
  });
});

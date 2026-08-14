import { describe, it, expect } from 'vitest';
import { buildMatrixIndexes, buildTypeSpans, byDisplayName } from './RotatedMatrixView.helpers';

describe('buildMatrixIndexes', () => {
  it('indexes users and resources and sorts them by displayName', () => {
    const { users, resources } = buildMatrixIndexes([
      { memberId: 'u2', memberDisplayName: 'Zoe', resourceId: 'r2', resourceDisplayName: 'Beta' },
      { memberId: 'u1', memberDisplayName: 'Amy', resourceId: 'r1', resourceDisplayName: 'Alpha' },
    ]);
    expect(users.map(u => u.displayName)).toEqual(['Amy', 'Zoe']);
    expect(resources.map(r => r.displayName)).toEqual(['Alpha', 'Beta']);
  });

  it('records membership types and the managed flag per cell', () => {
    const { cellMap } = buildMatrixIndexes([
      { memberId: 'u1', resourceId: 'r1', membershipType: 'Direct', managedByAccessPackage: true },
      { memberId: 'u1', resourceId: 'r1', membershipType: 'Indirect' },
    ]);
    const cell = cellMap.get('u1|r1');
    expect([...cell.types].sort()).toEqual(['Direct', 'Indirect']);
    expect(cell.managed).toBe(true);
  });

  it('falls back to group* fields and the id when display fields are absent', () => {
    const { users, resources } = buildMatrixIndexes([
      { memberId: 'u1', groupId: 'g1', groupDisplayName: 'Group One', groupTypeCalculated: 'Security' },
    ]);
    expect(users[0].displayName).toBe('u1');
    expect(users[0].department).toBe('');
    expect(resources[0]).toMatchObject({ id: 'g1', displayName: 'Group One', resourceType: 'Security' });
  });

  it('uses the resource id as the display name when nothing else is present', () => {
    const { resources } = buildMatrixIndexes([{ memberId: 'u1', resourceId: 'r9' }]);
    expect(resources[0].displayName).toBe('r9');
    expect(resources[0].resourceType).toBe('');
  });

  it('indexes each side independently but only makes a cell when both ids exist', () => {
    const { users, resources, cellMap } = buildMatrixIndexes([
      { resourceId: 'r1', membershipType: 'Direct' }, // resource only, no cell
      { memberId: 'u1', membershipType: 'Direct' },   // user only, no cell
    ]);
    expect(users.map(u => u.id)).toEqual(['u1']);
    expect(resources.map(r => r.id)).toEqual(['r1']);
    expect(cellMap.size).toBe(0);
  });
});

describe('buildTypeSpans', () => {
  it('merges consecutive resources of the same type', () => {
    expect(buildTypeSpans([
      { resourceType: 'Group' },
      { resourceType: 'Group' },
      { resourceType: 'Role' },
    ])).toEqual([{ type: 'Group', span: 2 }, { type: 'Role', span: 1 }]);
  });

  it('labels a missing type as empty and returns nothing for no resources', () => {
    expect(buildTypeSpans([{ resourceType: '' }])).toEqual([{ type: '', span: 1 }]);
    expect(buildTypeSpans([])).toEqual([]);
  });
});

describe('byDisplayName', () => {
  it('is null-safe on either side', () => {
    expect(byDisplayName({}, { displayName: 'A' })).toBeLessThan(0);
    expect(byDisplayName({ displayName: 'A' }, {})).toBeGreaterThan(0);
  });
});

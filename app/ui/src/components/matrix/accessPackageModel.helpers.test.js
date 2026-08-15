import { describe, it, expect } from 'vitest';
import { buildAccessPackages, buildApSortedGroups } from './accessPackageModel.js';

const groups = [{ id: 'r1', directCount: 1, memberCount: 1 }, { id: 'r2', directCount: 0, memberCount: 1 }];
const users = [{ id: 'u1' }];

describe('buildAccessPackages', () => {
  it('returns empty structures when there are no AP rows', () => {
    expect(buildAccessPackages([], groups, users, new Map())).toEqual({ accessPackages: [], apGroupMap: new Map() });
  });

  it('keeps only APs a visible user actually holds and maps group→role', () => {
    const apGroups = [{ resourceId: 'r1', accessPackageId: 'AP1', accessPackageName: 'AP One', roleName: 'Member', totalAssignments: 5 }];
    const managedApMap = new Map([['r1|u1', ['ap1']]]);
    const { accessPackages, apGroupMap } = buildAccessPackages(apGroups, groups, users, managedApMap);
    expect(accessPackages.map(a => a.id)).toEqual(['AP1']);
    expect(apGroupMap.get('R1|ap1')).toBe('Member');
  });

  it('drops APs with no visible-user assignment', () => {
    const apGroups = [{ resourceId: 'r1', accessPackageId: 'AP1', accessPackageName: 'AP One' }];
    const { accessPackages } = buildAccessPackages(apGroups, groups, users, new Map());
    expect(accessPackages).toEqual([]);
  });

  it('sorts categorized APs before uncategorized ones', () => {
    const apGroups = [
      { resourceId: 'r1', accessPackageId: 'AP1', accessPackageName: 'Uncat', totalAssignments: 9 },
      { resourceId: 'r2', accessPackageId: 'AP2', accessPackageName: 'Cat', categoryName: 'Zeta', totalAssignments: 1 },
    ];
    const managedApMap = new Map([['r1|u1', ['ap1']], ['r2|u1', ['ap2']]]);
    const { accessPackages } = buildAccessPackages(apGroups, groups, users, managedApMap);
    expect(accessPackages.map(a => a.id)).toEqual(['AP2', 'AP1']); // categorized first
  });
});

describe('buildApSortedGroups', () => {
  it('keeps the member-count order in the Non-governed view', () => {
    expect(buildApSortedGroups(groups, [{ id: 'AP1' }], new Map(), 'unmanaged')).toBe(groups);
  });

  it('keeps the member-count order when there are no APs', () => {
    expect(buildApSortedGroups(groups, [], new Map(), 'all')).toBe(groups);
  });

  it('orders groups by their leftmost AP bucket (staircase)', () => {
    const accessPackages = [{ id: 'AP1' }];
    const apGroupMap = new Map([['R1|ap1', 'Member']]); // r1 is in AP1, r2 is not
    const sorted = buildApSortedGroups(groups, accessPackages, apGroupMap, 'all');
    expect(sorted.map(g => g.id)).toEqual(['r1', 'r2']); // r1 (bucket 0) before r2 (unmanaged)
  });

  it('matches owner rows only against Owner-role AP buckets', () => {
    const ownerGroups = [{ id: 'r1__owner', realGroupId: 'r1', directCount: 1, memberCount: 1 }];
    const accessPackages = [{ id: 'AP1' }];
    // Role is a plain Member (not Owner), so the owner row does NOT bucket into AP1.
    const sorted = buildApSortedGroups(ownerGroups, accessPackages, new Map([['R1|ap1', 'Member']]), 'all');
    expect(sorted.map(g => g.id)).toEqual(['r1__owner']);
  });
});

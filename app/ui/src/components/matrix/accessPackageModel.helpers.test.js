import { describe, it, expect } from 'vitest';
import { buildAccessPackages, buildApSortedGroups, buildManagedApMap, bandsForLens, PROPOSED_CATEGORY } from './accessPackageModel.js';

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

describe('buildManagedApMap', () => {
  it('keys each cell by resource|member in lower case, the roles in lower case', () => {
    const map = buildManagedApMap([{ resourceId: 'R1', memberId: 'M1', accessPackageIds: ['BR-1'] }, { groupId: 'G2', memberId: 'm2' }]);
    expect([...map]).toEqual([['r1|m1', ['br-1']], ['g2|m2', []]]);
    expect(buildManagedApMap(null).size).toBe(0);
  });

  it('adds the proposals\' cells on top: a cell both cover lists both, once each', () => {
    const map = buildManagedApMap(
      [{ resourceId: 'r1', memberId: 'm1', accessPackageIds: ['br-1'] }],
      [{ resourceId: 'r1', memberId: 'm1', accessPackageIds: ['p1', 'BR-1'] }, { resourceId: 'r2', memberId: 'm1', accessPackageIds: ['p1'] }]);
    expect(map.get('r1|m1')).toEqual(['br-1', 'p1']);
    expect(map.get('r2|m1')).toEqual(['p1']);
  });
});

describe('bandsForLens', () => {
  const aps = [{ id: 'br', categoryName: 'Business' }, { id: 'p1', categoryName: PROPOSED_CATEGORY }, { id: 'x', categoryName: null }];
  it('shows every band in All, Governed and Gaps', () => {
    for (const lens of ['all', 'managed', 'gaps']) expect(bandsForLens(aps, lens)).toBe(aps);
  });
  it('shows no business role in Non-governed — only proposed roles added on top', () => {
    expect(bandsForLens(aps, 'unmanaged').map(a => a.id)).toEqual(['p1']);
    expect(bandsForLens(aps.filter(a => a.id !== 'p1'), 'unmanaged')).toEqual([]);
  });
});

describe('the order of the role columns with proposed roles added', () => {
  const ap = (id, extra) => ({ resourceId: 'r1', accessPackageId: id, accessPackageName: id, roleName: 'Member', ...extra });
  const held = (ids) => new Map([['r1|u1', ids.map(i => i.toLowerCase())]]);

  it('puts every proposed role after every real one — categorised or not — keeping the real ones\' own order', () => {
    const real = [ap('Zeta', { categoryName: 'Zeta', totalAssignments: 1 }), ap('Uncat', { totalAssignments: 9 }), ap('Alpha', { categoryName: 'Alpha', totalAssignments: 3 })];
    const drafts = [ap('p2', { categoryName: PROPOSED_CATEGORY, totalAssignments: 1 }), ap('p1', { categoryName: PROPOSED_CATEGORY, totalAssignments: 4 })];
    const alone = buildAccessPackages(real, groups, users, held(['Zeta', 'Uncat', 'Alpha'])).accessPackages.map(a => a.id);
    const added = buildAccessPackages([...drafts, ...real], groups, users, held(['Zeta', 'Uncat', 'Alpha', 'p1', 'p2'])).accessPackages.map(a => a.id);
    expect(alone).toEqual(['Alpha', 'Zeta', 'Uncat']);
    expect(added).toEqual([...alone, 'p1', 'p2']);
  });
});

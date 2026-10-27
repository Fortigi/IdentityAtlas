import { describe, it, expect } from 'vitest';
import {
  betterType, personKey, buildPeople, accountIds, buildCells, buildColumns, linkState, buildKnowledge, unresolvedMembers,
} from './model.js';

const ID = { anna: 'id-anna', bob: 'id-bob' };
const ACC = { anna1: 'p-anna-1', anna2: 'p-anna-2', bob: 'p-bob', loose: 'p-loose' };

function fixture() {
  return {
    members: [
      { memberType: 'Identity', memberId: ID.anna, direct: false, unitName: 'Claims Team B' },
      { memberType: 'Principal', memberId: ACC.bob, direct: true, unitName: 'Claims' },
      { memberType: 'Principal', memberId: ACC.loose, direct: true, unitName: 'Claims' },
    ],
    links: [{ principalId: ACC.bob, identityId: ID.bob }],
    identities: [
      { id: ID.anna, displayName: 'Anna Vos', email: null, jobTitle: null },
      { id: ID.bob, displayName: 'Bob Smit', email: 'bob@x.test', jobTitle: 'Handler' },
    ],
    accounts: [
      { identityId: ID.anna, id: ACC.anna1, displayName: 'Anna Vos', email: 'anna@x.test', jobTitle: 'Senior handler', systemName: 'Entra' },
      { identityId: ID.anna, id: ACC.anna2, displayName: 'adm-anna', principalType: 'User', systemName: 'AD' },
      { identityId: ID.bob, id: ACC.bob, displayName: 'Bob Smit', systemName: 'Entra' },
    ],
    principals: [{ id: ACC.loose, displayName: 'svc-claims', principalType: 'User', systemName: 'Entra' }],
  };
}

describe('betterType', () => {
  it('ranks Direct over Indirect over Eligible over anything else, in either order', () => {
    expect(betterType('Indirect', 'Direct')).toBe('Direct');
    expect(betterType('Direct', 'Indirect')).toBe('Direct');
    expect(betterType('Eligible', 'Indirect')).toBe('Indirect');
    expect(betterType('Owner', 'Eligible')).toBe('Eligible');
    expect(betterType('Eligible', 'Owner')).toBe('Eligible');
  });
});

describe('buildPeople', () => {
  it('makes one row per identity, resolving a member account to its identity, and keeps an unlinked account as its own row', () => {
    const people = buildPeople(fixture());
    expect(people.map(p => p.key)).toEqual([`i:${ID.anna}`, `i:${ID.bob}`, `p:${ACC.loose}`]);
    expect(people[0].accounts.map(a => a.id)).toEqual([ACC.anna1, ACC.anna2]);
    expect(people[2]).toMatchObject({ identityId: null, principalId: ACC.loose, displayName: 'svc-claims' });
    expect(people[2].accounts.map(a => a.id)).toEqual([ACC.loose]);
  });

  it('falls back to an account for e-mail and job title the identity lacks, and keeps the identity’s own', () => {
    const [anna, bob] = buildPeople(fixture());
    expect(anna).toMatchObject({ email: 'anna@x.test', jobTitle: 'Senior handler', direct: false, units: ['Claims Team B'] });
    expect(bob).toMatchObject({ email: 'bob@x.test', jobTitle: 'Handler', direct: true, units: ['Claims'] });
  });

  it('marks a person direct when any of their memberships is in the unit itself, and lists each sub-unit once', () => {
    const f = fixture();
    f.members.push({ memberType: 'Identity', memberId: ID.anna, direct: true, unitName: 'Claims' });
    f.members.push({ memberType: 'Principal', memberId: ACC.anna2, direct: false, unitName: 'Claims Team B' });
    f.links.push({ principalId: ACC.anna2, identityId: ID.anna });
    const anna = buildPeople(f)[0];
    expect(anna.direct).toBe(true);
    expect(anna.units).toEqual(['Claims', 'Claims Team B']);
  });

  it('drops a member whose identity or account is gone', () => {
    const f = fixture();
    f.identities = f.identities.filter(i => i.id !== ID.anna);
    expect(buildPeople(f).map(p => p.displayName)).toEqual(['Bob Smit', 'svc-claims']);
  });
});

describe('accountIds', () => {
  it('lists every account of every person once', () => {
    expect(accountIds(buildPeople(fixture()))).toEqual([ACC.anna1, ACC.anna2, ACC.bob, ACC.loose]);
  });
});

describe('buildCells', () => {
  const people = buildPeople(fixture());

  it('folds two accounts of one person into one cell with the best type, counting the person once', () => {
    const { cells, holders } = buildCells(people, [
      { principalId: ACC.anna1, resourceId: 'g1', membershipType: 'Indirect' },
      { principalId: ACC.anna2, resourceId: 'g1', membershipType: 'Direct' },
      { principalId: ACC.bob, resourceId: 'g1', membershipType: 'Eligible' },
    ]);
    const anna = cells.find(c => c.person === `i:${ID.anna}`);
    expect(anna).toMatchObject({ resourceId: 'g1', type: 'Direct' });
    expect(anna.accounts.sort()).toEqual([ACC.anna1, ACC.anna2]);
    expect(holders.get('g1')).toBe(2);
  });

  it('records which business roles explain a cell, but not the role’s own membership row', () => {
    const { cells } = buildCells(people, [
      { principalId: ACC.bob, resourceId: 'g1', membershipType: 'Direct', managedByAccessPackage: true },
      { principalId: ACC.bob, resourceId: 'br1', membershipType: 'Direct' },
    ], [
      { userId: ACC.bob, resourceId: 'g1', businessRoleId: 'br1' },
      { userId: ACC.bob, resourceId: 'br1', businessRoleId: 'br1' },
      { userId: ACC.bob, resourceId: 'g-not-held', businessRoleId: 'br1' },
    ]);
    expect(cells.find(c => c.resourceId === 'g1')).toMatchObject({ viaRoles: ['br1'], managed: true });
    expect(cells.find(c => c.resourceId === 'br1').viaRoles).toEqual([]);
    expect(cells.some(c => c.resourceId === 'g-not-held')).toBe(false);
  });

  it('ignores access of accounts outside the unit', () => {
    const { cells } = buildCells(people, [{ principalId: 'p-stranger', resourceId: 'g1', membershipType: 'Direct' }]);
    expect(cells).toEqual([]);
  });
});

describe('buildColumns', () => {
  const resources = [
    { id: 'g1', displayName: 'SG-Claims', resourceType: 'Group', systemName: 'Entra' },
    { id: 'br1', displayName: 'Claims handler', resourceType: 'BusinessRole', governanceResource: true },
    { id: 'g2', displayName: 'SG-Fraud', resourceType: 'Group' },
    { id: 'g-nobody', displayName: 'Nobody holds this', resourceType: 'Group' },
  ];
  const holders = new Map([['g1', 2], ['br1', 2], ['g2', 5]]);

  it('lists the held resources most-held first, a business role before a group at equal count', () => {
    const { columns, truncated } = buildColumns(resources, holders, [{ roleId: 'br1', resourceId: 'g1' }]);
    expect(columns.map(c => c.id)).toEqual(['g2', 'br1', 'g1']);
    expect(columns[1]).toMatchObject({ isRole: true, contains: ['g1'], holders: 2 });
    expect(columns[0]).toMatchObject({ isRole: false, contains: [] });
    expect(truncated).toBe(0);
  });

  it('cuts at max and says how many were left out', () => {
    const { columns, truncated } = buildColumns(resources, holders, [], 2);
    expect(columns.map(c => c.id)).toEqual(['g2', 'br1']);
    expect(truncated).toBe(1);
  });
});

describe('linkState', () => {
  const c = (status) => ({ status });
  it('reads the claims about one link together', () => {
    expect(linkState([c('confirmed')])).toBe('confirmed');
    expect(linkState([c('edited'), c('proposed')])).toBe('confirmed');
    expect(linkState([c('proposed')])).toBe('proposed');
    expect(linkState([c('confirmed'), c('rejected')])).toBe('disputed');
    expect(linkState([c('proposed'), c('rejected')])).toBe('disputed');
    expect(linkState([c('rejected')])).toBe('rejected');
  });
});

describe('buildKnowledge', () => {
  const people = buildPeople(fixture());
  const claim = (over) => ({
    id: Math.random().toString(36), claimKind: 'activity', identityId: null, principalId: null, value: 'Handle claims',
    status: 'confirmed', proposedBy: 'model', objectContextId: null, objectName: null,
    sourceKind: 'interview', intervieweeName: 'Manager', fileName: 't.txt', interviewedAt: '2026-10-20', contextId: 'u', ...over,
  });

  it('groups claims per person, kind and object — a claim about an account counts for its person', () => {
    const out = buildKnowledge(people, [
      claim({ identityId: ID.anna, objectContextId: 'o1', objectName: 'Handle claims' }),
      claim({ principalId: ACC.anna2, value: 'handle  CLAIMS', status: 'proposed' }),
      claim({ principalId: ACC.anna2, claimKind: 'duty', value: 'Works council member' }),
    ]);
    const anna = out.get(`i:${ID.anna}`);
    expect(anna.map(l => [l.kind, l.name, l.objectId, l.state, l.claims.length])).toEqual([
      ['activity', 'Handle claims', 'o1', 'confirmed', 2],
      ['duty', 'Works council member', null, 'confirmed', 1],
    ]);
  });

  it('reads a proposed and a rejected claim of the same name as one disputed link', () => {
    const out = buildKnowledge(people, [
      claim({ identityId: ID.bob, value: 'Fraud', status: 'proposed', claimKind: 'expertise' }),
      claim({ identityId: ID.bob, value: 'fraud', status: 'rejected', claimKind: 'expertise' }),
    ]);
    const [link] = out.get(`i:${ID.bob}`);
    expect(link).toMatchObject({ kind: 'expertise', objectId: null, state: 'disputed' });
    expect(link.claims.map(c => c.status)).toEqual(['proposed', 'rejected']);
    expect(link.claims[0].source).toEqual({ kind: 'interview', name: 'Manager', fileName: 't.txt', date: '2026-10-20' });
  });

  it('takes the object id and name from a later claim that has one', () => {
    const out = buildKnowledge(people, [
      claim({ identityId: ID.bob, value: 'handle claims', status: 'proposed' }),
      claim({ identityId: ID.bob, objectContextId: 'o9', objectName: 'Handle claims', value: 'Handle Claims' }),
    ]);
    expect(out.get(`i:${ID.bob}`)).toHaveLength(1);
    expect(out.get(`i:${ID.bob}`)[0]).toMatchObject({ objectId: 'o9', name: 'Handle claims', state: 'confirmed' });
  });

  it('leaves out claims about people outside the unit', () => {
    expect(buildKnowledge(people, [claim({ identityId: 'someone-else' })]).size).toBe(0);
  });
});

describe('personKey', () => {
  it('keys a person by identity, an unlinked account by its id', () => {
    expect(personKey('a', 'b')).toBe('i:a');
    expect(personKey(null, 'b')).toBe('p:b');
  });
});

describe('unresolvedMembers', () => {
  it('counts the members whose person or account is gone (a later full sync removed them), each person once', () => {
    const f = fixture();
    expect(unresolvedMembers(f)).toBe(0);
    // The identities were removed by another source's full sync; the member rows still point at them.
    f.identities = [];
    f.members.push({ memberType: 'Identity', memberId: ID.anna, direct: true, unitName: 'Claims' });
    expect(unresolvedMembers(f)).toBe(2);
    expect(buildPeople(f).map(p => p.key)).toEqual([`p:${ACC.loose}`]);
    f.principals = [];
    expect(unresolvedMembers(f)).toBe(3);
  });
});

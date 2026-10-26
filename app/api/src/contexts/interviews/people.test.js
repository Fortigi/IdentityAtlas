// The People overview's rules: one row per person, one status, paging across groups.
// Inputs are chosen to discriminate: a person listed AND overridden (left decided,
// not current), a listed person whose claims say they came back, a claim-only
// person who is said to be present (not confirmed) and one said to have left, and
// page boundaries that fall exactly on a group edge.
import { describe, it, expect } from 'vitest';
import {
  parsePeopleQuery, holderKey, groupClaimsByPerson, personStatus, buildPerson, sourcesOf, entitlementKey,
  withEntitlements, matchesSearch, splitByStatus, memoryGroups, pageAcross, claimFact, FILTER_GROUPS, PAGE_SIZE, MAX_PAGE_SIZE,
} from './people.js';

const ANN = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'aaaaaaaa-0000-4000-8000-000000000002';
const PERSON = 'bbbbbbbb-0000-4000-8000-000000000001';

let n = 0;
const claim = (over) => ({
  id: `c-${++n}`, interviewId: 'iv-1', claimKind: 'membership', attribute: 'current', value: 'x', status: 'confirmed',
  periodFrom: null, periodTo: null, periodText: null, quote: 'q', intervieweeName: 'Iris Interviewee', interviewedAt: '2026-10-01',
  createdAt: '2026-10-01T10:00:00Z', fileName: 'talk.txt', sourceKind: 'interview', ...over,
});
const left = (over) => claim({ attribute: 'left', value: 'left the unit', ...over });
const overrideCols = { overrideClaimId: 'c-decided', overrideSource: 'Customer list (upload)', overrideBy: 'analyst@example.test', overrideAt: '2026-10-23T10:00:00Z' };

describe('parsePeopleQuery', () => {
  it('defaults to the current filter, page 1 of 100', () => {
    expect(parsePeopleQuery({})).toEqual({ filter: 'current', search: '', limit: PAGE_SIZE, offset: 0 });
    expect(PAGE_SIZE).toBe(100);
  });

  it('keeps a known filter, trims the search, caps the limit and floors the offset', () => {
    expect(parsePeopleQuery({ filter: 'former', search: '  ann ', limit: '2', offset: '7' })).toEqual({ filter: 'former', search: 'ann', limit: 2, offset: 7 });
    expect(parsePeopleQuery({ filter: 'decide', limit: '9999', offset: '-3' })).toMatchObject({ filter: 'decide', limit: MAX_PAGE_SIZE, offset: 0 });
    expect(parsePeopleQuery({ filter: 'bogus', limit: '0' })).toMatchObject({ filter: 'current', limit: 1 });
    expect(parsePeopleQuery({ limit: 'x', offset: 'y' })).toMatchObject({ limit: PAGE_SIZE, offset: 0 });
    expect(parsePeopleQuery({ search: 'a'.repeat(300) }).search).toHaveLength(200);
  });
});

describe('groupClaimsByPerson', () => {
  it('keys by the holder in the context kind, else by who the claim names; one group per person', () => {
    const groups = groupClaimsByPerson([
      claim({ holderId: ANN, principalId: ANN, subjectDisplayName: 'Ann Example' }),
      // the person's claim mapped to Ann's account: the same row
      claim({ holderId: ANN, identityId: PERSON, subjectDisplayName: 'Ann (person)' }),
      claim({ holderId: null, subjectName: '  Carl  Unknown ' }),
      claim({ holderId: null, subjectName: 'carl unknown', accountDeleted: true }),
    ], 'principalId');
    expect([...groups.keys()]).toEqual([holderKey('principalId', ANN), 'name:carl unknown']);
    const ann = groups.get(`principalId:${ANN}`);
    expect(ann).toMatchObject({ holderId: ANN, principalId: ANN, displayName: 'Ann Example' });
    expect(ann.claims).toHaveLength(2);
    expect(groups.get('name:carl unknown')).toMatchObject({ holderId: null, displayName: '  Carl  Unknown ', accountDeleted: false });
  });

  it('a context whose members are not people keys by the claim alone, even with a holder', () => {
    const groups = groupClaimsByPerson([claim({ holderId: ANN, identityId: PERSON })], null);
    expect([...groups.keys()]).toEqual([`identityId:${PERSON}`]);
    expect(groups.get(`identityId:${PERSON}`).holderId).toBeNull();
  });
});

describe('personStatus', () => {
  it('listed: current, came back when a source says so, left (decided) when a decision marked them', () => {
    expect(personStatus({ listed: true })).toBe('current');
    expect(personStatus({ listed: true, claims: [claim({ attribute: 'rejoined' })] })).toBe('cameBack');
    expect(personStatus({ listed: true, overridden: true, claims: [claim({ attribute: 'rejoined' })] })).toBe('leftDecided');
    // still listed and a source says they left, undecided: still current (a contradiction to decide)
    expect(personStatus({ listed: true, claims: [left()] })).toBe('current');
  });

  it('not listed: left when a source or a decision says so, else not confirmed', () => {
    expect(personStatus({ listed: false, claims: [left()] })).toBe('left');
    expect(personStatus({ listed: false, overridden: true, claims: [] })).toBe('left');
    expect(personStatus({ listed: false, claims: [claim({})] })).toBe('notConfirmed');
    expect(personStatus({ listed: false, claims: [claim({ attribute: 'rejoined' })] })).toBe('notConfirmed');
    expect(personStatus({ claims: [claim({ claimKind: 'role', attribute: 'member', value: 'architect' })] })).toBe('notConfirmed');
  });

  it('a context that cannot list people: what the source says decides', () => {
    expect(personStatus({ canList: false, claims: [claim({})] })).toBe('current');
    expect(personStatus({ canList: false, claims: [claim({ attribute: 'rejoined' })] })).toBe('cameBack');
    expect(personStatus({ canList: false, claims: [left()] })).toBe('left');
  });
});

describe('sourcesOf', () => {
  it('the list first when it lists them, then each kind of source once, in a fixed order', () => {
    expect(sourcesOf(true, [claim({ sourceKind: 'text' }), claim({}), claim({ sourceKind: 'text' })])).toEqual(['list', 'interview', 'text']);
    expect(sourcesOf(false, [claim({ sourceKind: 'file' }), claim({ sourceKind: undefined })])).toEqual(['interview', 'file']);
    expect(sourcesOf(true, [])).toEqual(['list']);
  });
});

describe('buildPerson', () => {
  const roles = [
    { role: 'Accountable', principalId: ANN },
    { role: 'Responsible', principalId: ANN },
    { role: 'Responsible', identityId: PERSON },
    { role: 'Accountable', principalId: BOB },
  ];

  it('a listed member with claims: one row with status, roles, latest role, sources, claims and contradictions', () => {
    const role = claim({ claimKind: 'role', attribute: 'member', value: 'Lead architect', status: 'proposed' });
    const group = { key: `principalId:${ANN}`, displayName: 'Ann (as said)', claims: [role] };
    const open = [{ id: 'leftButMember:x', claimIds: ['other'] }, { id: 'accountable:y', claimIds: ['z', role.id] }];
    const p = buildPerson({ key: group.key, member: { principalId: ANN, displayName: 'Ann Example', email: 'ann@example.test', accountEnabled: true, listed: true }, group, roles, open });
    expect(p).toMatchObject({
      key: `principalId:${ANN}`, status: 'current', former: false, displayName: 'Ann Example', email: 'ann@example.test',
      roles: ['Accountable', 'Responsible'], role: { value: 'Lead architect', status: 'proposed' }, rejoined: null, left: null,
      decision: null, stillListed: false, sources: ['list', 'interview'], contradictions: ['accountable:y'],
      liveEntitlements: null, linkedEntitlements: null,
    });
    expect(p.claims).toEqual([claimFact(role)]);
  });

  it('listed and marked former: left (decided), the decision, still listed, former', () => {
    const p = buildPerson({ key: 'k', member: { principalId: BOB, displayName: 'Bob Sample', listed: true, ...overrideCols }, group: { claims: [left()] }, roles });
    expect(p).toMatchObject({ status: 'leftDecided', former: true, stillListed: true, roles: ['Accountable'],
      decision: { by: 'analyst@example.test', overrides: 'Customer list (upload)', claimId: 'c-decided' } });
  });

  it('came back: the earlier stint is on the row; a claim-only person takes the name and ids from the claims', () => {
    const back = buildPerson({ key: 'k', member: { principalId: ANN, displayName: 'Ann', listed: true }, group: { claims: [claim({ attribute: 'rejoined' })] } });
    expect(back.status).toBe('cameBack');
    expect(back.rejoined).toMatchObject({ membershipStatus: 'rejoined', earlier: [] });
    const said = buildPerson({ key: 'k2', group: { displayName: 'Dana Said', identityId: PERSON, accountDeleted: true, claims: [left()] }, roles });
    expect(said).toMatchObject({ status: 'left', displayName: 'Dana Said', identityId: PERSON, principalId: null, accountDeleted: true,
      roles: ['Responsible'], sources: ['interview'], left: { membershipStatus: 'left' }, rejoined: null });
  });

  it('nothing at all: an empty, not-confirmed row (the loader never asks for one, but it holds its shape)', () => {
    expect(buildPerson({ key: 'k' })).toMatchObject({ status: 'notConfirmed', displayName: '', claims: [], roles: [], sources: [], contradictions: [] });
  });
});

describe('claimFact', () => {
  it('carries what the popover and the review need, with the source kind defaulting to interview', () => {
    const f = claimFact(claim({ id: 'c-x', sourceKind: undefined, fileName: undefined, roleSuggestion: 'Accountable', subjectName: 'Ann' }));
    expect(f).toMatchObject({ id: 'c-x', sourceKind: 'interview', fileName: null, roleSuggestion: 'Accountable', subjectName: 'Ann', quote: 'q', intervieweeName: 'Iris Interviewee' });
  });
});

describe('entitlementKey / withEntitlements', () => {
  it('reads under the holder of the context kind first, else the account, else the person, else none', () => {
    expect(entitlementKey({ principalId: ANN, identityId: PERSON }, 'identityId')).toBe(`identityId:${PERSON}`);
    expect(entitlementKey({ principalId: ANN, identityId: PERSON }, 'principalId')).toBe(`principalId:${ANN}`);
    expect(entitlementKey({ principalId: ANN, identityId: null }, 'identityId')).toBe(`principalId:${ANN}`);
    expect(entitlementKey({ principalId: null, identityId: PERSON }, null)).toBe(`identityId:${PERSON}`);
    expect(entitlementKey({ principalId: null, identityId: null }, 'principalId')).toBeNull();
  });

  it('a matched person holds what the counts say (0 when absent); the linked count only when the context has linked resources', () => {
    const counts = new Map([[`principalId:${ANN}`, { liveEntitlements: 210, linkedEntitlements: 3 }]]);
    expect(withEntitlements({ principalId: ANN }, 'principalId', counts, 5)).toMatchObject({ liveEntitlements: 210, linkedEntitlements: 3 });
    expect(withEntitlements({ principalId: ANN }, 'principalId', counts, 0)).toMatchObject({ liveEntitlements: 210, linkedEntitlements: null });
    expect(withEntitlements({ principalId: BOB }, 'principalId', counts, 1)).toMatchObject({ liveEntitlements: 0, linkedEntitlements: 0 });
    const nobody = { principalId: null, identityId: null, liveEntitlements: null };
    expect(withEntitlements(nobody, 'principalId', counts, 1)).toBe(nobody);
  });
});

describe('search, split and groups', () => {
  const p = (displayName, status, key = displayName) => ({ displayName, status, key });

  it('matches a part of the name, any case and spacing; no search matches all', () => {
    expect(matchesSearch(p('Ann  Example'), 'ann ex')).toBe(true);
    expect(matchesSearch(p('Ann Example'), 'bob')).toBe(false);
    expect(matchesSearch(p('Ann'), '')).toBe(true);
  });

  it('splits by status, each by name (then key); said = current and came back together, by name', () => {
    const s = splitByStatus([p('Zed', 'left', 'k-z'), p('Amy', 'left', 'k-b'), p('Amy', 'left', 'k-a')]);
    expect(s.left.map(x => x.key)).toEqual(['k-a', 'k-b', 'k-z']);
    const g = memoryGroups([p('Cleo', 'cameBack'), p('Bart', 'current'), p('Dirk', 'notConfirmed'), p('Eve', 'leftDecided')]);
    expect(g.said.map(x => x.displayName)).toEqual(['Bart', 'Cleo']);
    expect([g.notConfirmed.length, g.leftDecided.length, g.left.length]).toEqual([1, 1, 0]);
  });

  it('each filter shows its groups in order; former never holds the listed current members', () => {
    expect(FILTER_GROUPS.current).toEqual(['listed', 'said', 'notConfirmed']);
    expect(FILTER_GROUPS.former).toEqual(['leftDecided', 'left']);
    expect(FILTER_GROUPS.all).toEqual([...FILTER_GROUPS.current, ...FILTER_GROUPS.former]);
  });
});

describe('pageAcross', () => {
  const groups = [{ name: 'listed', count: 3 }, { name: 'said', count: 0 }, { name: 'notConfirmed', count: 2 }];

  it('a page inside the first group takes from it only', () => {
    expect(pageAcross(groups, 0, 2)).toEqual([{ group: 'listed', offset: 0, limit: 2 }]);
  });

  it('a page across the edge takes the rest of one group and the start of the next, skipping an empty one', () => {
    expect(pageAcross(groups, 2, 2)).toEqual([{ group: 'listed', offset: 2, limit: 1 }, { group: 'notConfirmed', offset: 0, limit: 1 }]);
  });

  it('a page starting exactly at the edge starts in the next group', () => {
    expect(pageAcross(groups, 3, 5)).toEqual([{ group: 'notConfirmed', offset: 0, limit: 2 }]);
  });

  it('a page past the end is empty, and so is a zero limit', () => {
    expect(pageAcross(groups, 5, 10)).toEqual([]);
    expect(pageAcross(groups, 0, 0)).toEqual([]);
  });
});

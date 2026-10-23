import { describe, it, expect } from 'vitest';
import {
  defaultPeriod, monthsBetween, peopleGroups, childSummary, branchMap, primaryUnitOf, personKey, compareColumn,
} from './report.js';

// One aggregate row as store.activityAggregates returns it.
const agg = (over) => ({
  contextId: 'C', principalId: null, identityId: null, subjectEmail: null, subjectName: null,
  month: '2026-04', unit: 'hours', amount: 1, rows: 1, firstDate: '2026-04-10', lastDate: '2026-04-10', ...over,
});
const member = (memberId, displayName, contextId = 'C', memberType = 'Identity') => ({ contextId, memberId, memberType, displayName, email: null });
const MONTHS = ['2026-03', '2026-04'];
const group = (view, key) => view.groups.find(g => g.key === key).people;

describe('defaultPeriod / monthsBetween', () => {
  it('is the twelve calendar months ending in the latest month, across a year boundary', () => {
    expect(defaultPeriod('2026-04-18')).toEqual({ from: '2025-05-01', to: '2026-04-18' });
    expect(defaultPeriod('2026-12-31')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(defaultPeriod(null)).toBeNull();
    expect(monthsBetween('2025-05-01', '2026-04-18')).toHaveLength(12);
  });

  it('lists every month, December to January included', () => {
    expect(monthsBetween('2025-11-20', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsBetween('2026-04-01', '2026-04-30')).toEqual(['2026-04']);
  });
});

describe('primaryUnitOf / personKey / compareColumn', () => {
  it('the unit with the most rows wins; a tie goes to hours', () => {
    expect(primaryUnitOf([agg({ unit: 'events', rows: 3 }), agg({ unit: 'hours', rows: 2 })])).toBe('events');
    expect(primaryUnitOf([agg({ unit: 'events', rows: 2 }), agg({ unit: 'hours', rows: 2 })])).toBe('hours');
    expect(primaryUnitOf([agg({ unit: 'hours', rows: 2 }), agg({ unit: 'events', rows: 2 })])).toBe('hours');
    expect(primaryUnitOf([])).toBeNull();
  });

  it('keys a person by the compared id first, then the other, then the raw value', () => {
    const row = { identityId: 'I1', principalId: 'P1', subjectEmail: 'v@example.org' };
    expect(personKey(row, 'principalId')).toBe('principalId:P1');
    expect(personKey(row, 'identityId')).toBe('identityId:I1');
    expect(personKey({ ...row, identityId: null }, 'identityId')).toBe('principalId:P1');
    expect(personKey({ subjectName: 'Ghost Person' }, null)).toBe('raw:ghost person');
  });

  it('compares people on a unit of people, accounts on a unit of accounts, nothing on resources', () => {
    expect(compareColumn('Identity')).toBe('identityId');
    expect(compareColumn('Principal')).toBe('principalId');
    expect(compareColumn('Resource')).toBeNull();
  });
});

describe('peopleGroups', () => {
  const names = new Map([['I1', 'Vera Example'], ['I2', 'Tom Sample']]);
  const aggregates = [
    // Vera: a member, active in two months (two rows in April under two spellings of her name).
    agg({ identityId: 'I1', principalId: 'P1', subjectName: 'Vera', month: '2026-03', amount: 2, firstDate: '2026-03-02', lastDate: '2026-03-30' }),
    agg({ identityId: 'I1', principalId: 'P1', subjectName: 'V. Example', month: '2026-04', amount: 1.5, rows: 2, firstDate: '2026-04-01', lastDate: '2026-04-20' }),
    // Tom: known, active, not a member.
    agg({ identityId: 'I2', principalId: 'P2', month: '2026-04', amount: 6 }),
    // A name nobody matched.
    agg({ subjectName: 'Ghost Person', month: '2026-04', amount: 0.5 }),
  ];
  const members = [member('I1', 'Vera Example'), member('I3', 'Ann Idle')];

  it('splits into the four groups against the current members', () => {
    const view = peopleGroups({ targetType: 'Identity', aggregates, members, names, months: MONTHS });
    expect(view.comparable).toBe(true);
    expect(view.unit).toBe('hours');
    expect(view.groups.map(g => g.key)).toEqual(['memberAndActive', 'activeNotMember', 'memberNoActivity', 'activeUnknown']);
    expect(group(view, 'memberAndActive')).toEqual([expect.objectContaining({
      displayName: 'Vera Example', identityId: 'I1', amount: 3.5, rows: 3, firstDate: '2026-03-02', lastDate: '2026-04-20',
      perMonth: [{ month: '2026-03', amount: 2 }, { month: '2026-04', amount: 1.5 }],
    })]);
    expect(group(view, 'activeNotMember').map(p => [p.displayName, p.amount])).toEqual([['Tom Sample', 6]]);
    expect(group(view, 'memberNoActivity')).toEqual([{ displayName: 'Ann Idle', memberId: 'I3', memberType: 'Identity', email: null }]);
    expect(group(view, 'activeUnknown').map(p => [p.displayName, p.amount])).toEqual([['Ghost Person', 0.5]]);
  });

  it('on a unit of accounts the comparison is on the account, not the person', () => {
    const accountMembers = [member('P2', 'tom.sample', 'C', 'Principal')];
    const view = peopleGroups({ targetType: 'Principal', aggregates, members: accountMembers, names, months: MONTHS });
    expect(group(view, 'memberAndActive').map(p => p.principalId)).toEqual(['P2']);
    expect(group(view, 'activeNotMember').map(p => p.principalId)).toEqual(['P1']);
    expect(group(view, 'memberNoActivity')).toEqual([]);
  });

  it('activity outside the period is not there: a member whose rows were all earlier has no activity', () => {
    // The aggregates are already cut to the period by the query; Ann's earlier rows are not among them.
    const view = peopleGroups({ targetType: 'Identity', aggregates: [], members, names, months: MONTHS });
    expect(group(view, 'memberNoActivity').map(m => m.memberId)).toEqual(['I3', 'I1']); // by name: Ann before Vera
    expect(view.unit).toBeNull();
  });

  it('a unit of resources has no members to compare: known people are just active', () => {
    const view = peopleGroups({ targetType: 'Resource', aggregates, members: [], names, months: MONTHS });
    expect(view.comparable).toBe(false);
    expect(view.groups.map(g => g.key)).toEqual(['active', 'activeUnknown']);
    expect(group(view, 'active').map(p => p.displayName)).toEqual(['Tom Sample', 'Vera Example']);
  });

  it('the people of a group run from most to least, and amounts in another unit are kept apart', () => {
    const view = peopleGroups({
      targetType: 'Identity', members: [], names, months: MONTHS,
      aggregates: [agg({ identityId: 'I1', amount: 1 }), agg({ identityId: 'I1', unit: 'events', amount: 4, rows: 1 }), agg({ identityId: 'I2', amount: 2 }), agg({ identityId: 'I2', amount: 2, rows: 1 })],
    });
    const people = group(view, 'activeNotMember');
    expect(people.map(p => p.displayName)).toEqual(['Tom Sample', 'Vera Example']);
    expect(people[1].amounts).toEqual({ hours: 1, events: 4 });
    expect(people[1].amount).toBe(1);
  });
});

describe('branchMap', () => {
  it('maps every context below the root to the direct sub-unit it lies under', () => {
    const below = [
      { id: 'A', parentContextId: 'ROOT' }, { id: 'B', parentContextId: 'ROOT' },
      { id: 'A1', parentContextId: 'A' }, { id: 'A11', parentContextId: 'A1' },
    ];
    expect(Object.fromEntries(branchMap('ROOT', below))).toEqual({ A: 'A', B: 'B', A1: 'A', A11: 'A' });
  });
});

describe('childSummary', () => {
  const children = [{ id: 'A', displayName: 'Northwind Traders' }, { id: 'B', displayName: 'Contoso Bakery' }, { id: 'Z', displayName: 'Quiet Co' }];
  const branchOf = new Map([['A', 'A'], ['A1', 'A'], ['B', 'B'], ['Z', 'Z']]);
  const members = [member('I1', 'Vera', 'A'), member('I3', 'Ann', 'A'), member('I2', 'Tom', 'A1'), member('I4', 'Kim', 'Z')];
  const aggregates = [
    agg({ contextId: 'A', identityId: 'I1', month: '2026-03', amount: 2 }),
    agg({ contextId: 'A1', identityId: 'I2', month: '2026-04', amount: 3 }),     // a member of the grandchild it landed on
    agg({ contextId: 'A', identityId: 'I2', month: '2026-04', amount: 1 }),      // ...but not of A itself
    agg({ contextId: 'B', identityId: 'I1', month: '2026-04', amount: 4 }),
    agg({ contextId: 'B', subjectName: 'Ghost Person', month: '2026-04', amount: 1 }),
    agg({ contextId: 'B', identityId: 'I1', unit: 'events', month: '2026-04', amount: 9, rows: 1 }),
    agg({ contextId: 'ELSEWHERE', identityId: 'I9', month: '2026-04', amount: 100 }),
  ];

  it('one line per sub-unit over its subtree, with the two suggestion counts', () => {
    const s = childSummary({ targetType: 'Identity', children, branchOf, aggregates, members, months: MONTHS });
    expect(s.unit).toBe('hours');
    const [a, b, z] = s.children;
    expect(a).toMatchObject({ contextId: 'A', total: 6, activePeople: 2, activeNotMember: 1, activeUnknown: 0, memberNoActivity: 1 });
    expect(a.perMonth).toEqual([{ month: '2026-03', amount: 2 }, { month: '2026-04', amount: 4 }]);
    expect(b).toMatchObject({ contextId: 'B', total: 5, activePeople: 2, activeNotMember: 1, activeUnknown: 1, memberNoActivity: 0 });
    expect(z).toMatchObject({ contextId: 'Z', total: 0, activePeople: 0, memberNoActivity: 1 });
    expect(s.totals).toEqual({ total: 11, perMonth: [{ month: '2026-03', amount: 2 }, { month: '2026-04', amount: 9 }] });
  });

  it('a tree of resources counts people but makes no member suggestions', () => {
    const s = childSummary({ targetType: 'Resource', children, branchOf, aggregates, members, months: MONTHS });
    expect(s.comparable).toBe(false);
    expect(s.children.find(c => c.contextId === 'A')).toMatchObject({ activeNotMember: 0, memberNoActivity: 0, activePeople: 2 });
  });
});

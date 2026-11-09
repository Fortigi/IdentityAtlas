import { describe, it, expect } from 'vitest';
import {
  cellKey, indexCells, groupPeople, accessCounts, rangeKeys, toggleAll, selectionParts, addSelection, frequencies,
  candidateFromRole, cellsByResource, cellImpact, impactSummary, possibleMembers, roleDelta,
  startsCrowded, NOT_KNOWN, EMPTY_CANDIDATE,
} from './workbench.model';

const link = (kind, name, state = 'confirmed') => ({ kind, name, state, claims: [] });
const person = (key, displayName, knowledge = [], jobTitle = null) => ({ key, displayName, knowledge, jobTitle, accounts: [] });

const people = [
  person('a', 'Anna', [link('activity', 'Handle claims'), link('duty', 'Works council member')], 'Lead'),
  person('b', 'Bram', [link('activity', 'Handle claims'), link('activity', 'Manage garages', 'proposed')], 'Handler'),
  person('c', 'Cleo', [link('activity', 'Fraud', 'rejected')]),
  person('d', 'Dirk', [link('activity', 'Manage garages', 'proposed')], 'Handler'),
];

const cells = [
  { person: 'a', resourceId: 'r1', type: 'Direct' }, { person: 'a', resourceId: 'r2', type: 'Direct' },
  { person: 'b', resourceId: 'r1', type: 'Indirect' }, { person: 'b', resourceId: 'r3', type: 'Direct' },
  { person: 'c', resourceId: 'r1', type: 'Direct' }, { person: 'c', resourceId: 'r2', type: 'Direct' },
  { person: 'd', resourceId: 'r3', type: 'Direct' },
];
const columns = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
const idx = indexCells(cells);

describe('groupPeople', () => {
  it('puts a person with two activities in both groups, one without any (or only rejected) in Not known, largest first', () => {
    const groups = groupPeople(people, 'activity');
    expect(groups.map(g => [g.label, g.rows.map(r => r.person.key)])).toEqual([
      ['Handle claims', ['a', 'b']],
      ['Manage garages', ['b', 'd']],
      ['Not known', ['c']],
    ]);
    // Bram's confirmed value comes first; his proposed one is the repeat, naming where else he is.
    expect(groups[0].rows.find(r => r.person.key === 'b')).toMatchObject({ repeat: false, alsoUnder: ['Manage garages'] });
    expect(groups[1].rows.find(r => r.person.key === 'b')).toMatchObject({ repeat: true, alsoUnder: ['Handle claims'] });
    expect(groups[0].rows.find(r => r.person.key === 'a')).toMatchObject({ repeat: false, alsoUnder: [] });
    expect(groups.at(-1).key).toBe(NOT_KNOWN);
  });

  it('flags a group whose people are only proposed, never a confirmed one', () => {
    const groups = groupPeople(people, 'activity');
    expect(groups.find(g => g.label === 'Manage garages').allProposed).toBe(true);
    expect(groups.find(g => g.label === 'Handle claims').allProposed).toBe(false);
    expect(groups.find(g => g.key === NOT_KNOWN).allProposed).toBe(false);
  });

  it('groups by job title from the source, and puts everyone in one group without grouping', () => {
    expect(groupPeople(people, 'jobTitle').map(g => [g.label, g.count])).toEqual([['Handler', 2], ['Lead', 1], ['Not known', 1]]);
    expect(groupPeople(people, 'jobTitle')[0].allProposed).toBe(false);
    const [all] = groupPeople(people, 'none');
    expect(all.count).toBe(4);
  });

  it('sorts inside a group by name, by most access, or by job title', () => {
    const counts = accessCounts(cells);
    expect(groupPeople(people, 'none', 'name')[0].rows.map(r => r.person.key)).toEqual(['a', 'b', 'c', 'd']);
    expect(groupPeople(people, 'none', 'access', k => counts.get(k) ?? 0)[0].rows.map(r => r.person.key)).toEqual(['a', 'b', 'c', 'd']);
    const fewFirst = (k) => ({ a: 1, b: 5, c: 3, d: 5 })[k];
    expect(groupPeople(people, 'none', 'access', fewFirst)[0].rows.map(r => r.person.key)).toEqual(['b', 'd', 'c', 'a']);
    expect(groupPeople(people, 'none', 'jobTitle')[0].rows.map(r => r.person.key)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('keeps one group per name whatever its case or spacing', () => {
    const p = [person('x', 'X', [link('duty', 'Fire  warden')]), person('y', 'Y', [link('duty', 'fire warden')])];
    expect(groupPeople(p, 'duty').map(g => g.count)).toEqual([2]);
  });
});

describe('groupPeople — several values', () => {
  const tom = person('t', 'Tom', [link('expertise', 'Motor claims', 'proposed'), link('expertise', 'Fraud detection', 'confirmed')]);
  const amy = person('y', 'Amy', [link('expertise', 'Motor claims')]);

  it('shows a person first under their strongest evidence, not alphabetically, the other appearance a repeat', () => {
    const groups = groupPeople([tom, amy], 'expertise');
    const tomIn = (label) => groups.find(g => g.label === label).rows.find(r => r.person.key === 't');
    expect(tomIn('Fraud detection')).toMatchObject({ repeat: false, state: 'confirmed', alsoUnder: ['Motor claims'] });
    expect(tomIn('Motor claims')).toMatchObject({ repeat: true, state: 'proposed', alsoUnder: ['Fraud detection'] });
  });

  it('shows each person once under their strongest value when asked', () => {
    const groups = groupPeople([tom, amy], 'expertise', 'name', () => 0, 'once');
    expect(groups.map(g => [g.label, g.rows.map(r => r.person.key)])).toEqual([['Fraud detection', ['t']], ['Motor claims', ['y']]]);
    expect(groups.flatMap(g => g.rows).every(r => !r.repeat)).toBe(true);
  });

  it('notes a group with only proposed evidence, and not one with a disputed or confirmed value', () => {
    const p = [person('x', 'X', [link('duty', 'OR', 'proposed')]), person('z', 'Z', [link('duty', 'BHV', 'disputed')])];
    expect(groupPeople(p, 'duty').map(g => [g.label, g.allProposed])).toEqual([['BHV', false], ['OR', true]]);
  });
});

describe('selection', () => {
  it('rangeKeys covers the rectangle between two positions, either way round', () => {
    const keys = rangeKeys(['a', 'b', 'c'], ['r1', 'r2', 'r3'], { row: 2, col: 1 }, { row: 1, col: 2 });
    expect([...keys].sort()).toEqual([cellKey('b', 'r2'), cellKey('b', 'r3'), cellKey('c', 'r2'), cellKey('c', 'r3')].sort());
  });

  it('toggleAll removes keys that were all in, and adds them all otherwise', () => {
    const s = new Set(['x', 'y']);
    expect([...toggleAll(s, ['x', 'y'])]).toEqual([]);
    expect([...toggleAll(s, ['y', 'z'])].sort()).toEqual(['x', 'y', 'z']);
    expect([...s]).toEqual(['x', 'y']);
  });

  it('selectionParts splits keys into people and resources, a person key with a colon included', () => {
    const { people: p, resources } = selectionParts(new Set([cellKey('i:1', 'r1'), cellKey('i:1', 'r2'), cellKey('p:2', 'r1')]));
    expect([...p]).toEqual(['i:1', 'p:2']);
    expect([...resources]).toEqual(['r1', 'r2']);
  });
});

describe('composing the candidate', () => {
  it('addSelection adds the people, and only the resources they really hold', () => {
    const sel = new Set([cellKey('a', 'r1'), cellKey('a', 'r3'), cellKey('d', 'r3')]);
    const c = addSelection(EMPTY_CANDIDATE, sel, idx);
    expect([...c.members].sort()).toEqual(['a', 'd']);
    expect([...c.entitlements].sort()).toEqual(['r1', 'r3']);
    expect(EMPTY_CANDIDATE.members.size).toBe(0);
  });

  it('frequencies gives each column’s share of the members, highest first, held ones only', () => {
    expect(frequencies(new Set(['a', 'b', 'c']), columns, idx)).toEqual([
      { resourceId: 'r1', held: 3, share: 1 },
      { resourceId: 'r2', held: 2, share: 2 / 3 },
      { resourceId: 'r3', held: 1, share: 1 / 3 },
    ]);
    expect(frequencies(new Set(), columns, idx)).toEqual([]);
  });

  it('candidateFromRole starts from the role’s holders and what it Contains', () => {
    const role = { id: 'br', displayName: 'Handler', contains: ['r1', 'r9'] };
    const byRes = cellsByResource([...cells, { person: 'b', resourceId: 'br' }, { person: 'd', resourceId: 'br' }]);
    const c = candidateFromRole(role, byRes);
    expect(c).toMatchObject({ baseBusinessRoleId: 'br', name: 'Handler', description: '' });
    expect([...c.members]).toEqual(['b', 'd']);
    expect([...c.entitlements]).toEqual(['r1', 'r9']);
    expect([...candidateFromRole({ id: 'none', displayName: 'N' }, byRes).members]).toEqual([]);
  });

  it('roleDelta says what the candidate adds to the role and leaves out of it', () => {
    const cand = { entitlements: new Set(['r1', 'r3']) };
    expect(roleDelta(cand, { contains: ['r1', 'r2'] })).toEqual({ added: ['r3'], leftOut: ['r2'] });
    expect(roleDelta(cand, null)).toEqual({ added: [], leftOut: [] });
  });
});

describe('impact', () => {
  it('cellImpact reads one cell: covered, gain, outside, a mark, held — never a loss', () => {
    expect(cellImpact({ observed: true, member: true, inCandidate: true })).toBe('covered');
    expect(cellImpact({ observed: false, member: true, inCandidate: true })).toBe('gain');
    expect(cellImpact({ observed: true, member: true, inCandidate: false })).toBe('outside');
    expect(cellImpact({ observed: true, member: true, inCandidate: false, mark: 'other' })).toBe('other');
    expect(cellImpact({ observed: true, member: false, inCandidate: true })).toBe('held');
    expect(cellImpact({ observed: false, member: false, inCandidate: true })).toBeNull();
    expect(cellImpact({ observed: false, member: true, inCandidate: false })).toBeNull();
    expect(cellImpact({ observed: true, member: true, inCandidate: true, mark: 'unrelated' })).toBe('covered');
  });

  it('impactSummary counts the members’ cells, the people who would gain, and possible members', () => {
    const candidate = { members: new Set(['a', 'b']), entitlements: new Set(['r1', 'r2']) };
    const marks = new Map([[cellKey('b', 'r3'), 'other']]);
    const s = impactSummary(candidate, people, idx, marks);
    // a: r1 ✓ r2 ✓ · b: r1 ✓ r2 + · b's r3 is outside but marked other.
    expect(s.counts).toEqual({ covered: 3, gain: 1, outside: 0, other: 1, unrelated: 0, investigate: 0 });
    expect(s.gainers).toBe(1);
    // c holds r1 and r2: all of it, not a member.
    expect(s.possibleMembers).toEqual(['c']);
  });

  it('impactSummary counts only the permissions shown, and says how many the filters leave out', () => {
    const candidate = { members: new Set(['a', 'b']), entitlements: new Set(['r1', 'r2']) };
    const marks = new Map([[cellKey('b', 'r3'), 'other']]);
    expect(impactSummary(candidate, people, idx, marks).hidden).toBe(0);
    // r2 and r3 hidden: only r1 counts (a ✓, b ✓); r2 (candidate) and r3 (b's, outside) are left out.
    const s = impactSummary(candidate, people, idx, marks, new Set(['r1']));
    expect(s.counts).toEqual({ covered: 2, gain: 0, outside: 0, other: 0, unrelated: 0, investigate: 0 });
    expect(s.gainers).toBe(0);
    expect(s.hidden).toBe(2);
  });

  it('possibleMembers needs all of the entitlements by default, and nothing without entitlements', () => {
    const cand = { members: new Set(['a']), entitlements: new Set(['r1', 'r2', 'r3', 'r4']) };
    expect(possibleMembers(cand, people, idx)).toEqual([]);
    expect(possibleMembers({ members: new Set(), entitlements: new Set(['r1', 'r2']) }, people, idx)).toEqual(['a', 'c']);
    expect(possibleMembers(cand, people, idx, 0.5)).toEqual(['b', 'c']);
    expect(possibleMembers({ members: new Set(), entitlements: new Set() }, people, idx)).toEqual([]);
  });
});

describe('startsCrowded', () => {
  const data = (cols, ppl) => ({ columns: Array.from({ length: cols }), people: Array.from({ length: ppl }) });
  it('is true only with more than 120 columns and at least 4 people', () => {
    expect(startsCrowded(data(121, 4))).toBe(true);
    expect(startsCrowded(data(120, 4))).toBe(false);
    expect(startsCrowded(data(500, 3))).toBe(false);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query } from '../db/connection.js';
import {
  departmentOfRule, normalizeParticipant, readParticipants, loadParticipants, namedResponsible, withPolicyResponsible,
} from './businessRolePeople.js';

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const G1 = '33333333-3333-3333-3333-333333333333';
const C1 = '44444444-4444-4444-4444-444444444444';
const POLICY = { id: 'pol', displayName: 'Policy' };

beforeEach(() => query.mockReset());

describe('departmentOfRule', () => {
  it.each([
    ['(user.department -eq "IT")', 'IT'],
    ['user.department -eq "Human Resources"', 'Human Resources'],
    ['  (USER.DEPARTMENT   -EQ "Sales")  ', 'Sales'],
  ])('reads %s', (rule, name) => expect(departmentOfRule(rule)).toBe(name));

  it.each([
    ['(user.department -eq "IT") -or (user.department -eq "HR")'],
    ['(user.department -ne "IT")'],
    ['(user.jobTitle -eq "IT")'],
    [''], [null],
  ])('does not treat %s as one department', (rule) => expect(departmentOfRule(rule)).toBeNull());
});

describe('normalizeParticipant', () => {
  it('keeps a full entry and lower-cases its ids', () => {
    const out = normalizeParticipant({
      participation: 'Approver', subjectType: 'User', principalId: U1.toUpperCase(), groupId: G1, rule: 'r',
      managerLevel: 2, displayName: 'Ann', isFallback: true, onBehalf: true, stage: 2,
    }, POLICY);
    expect(out).toEqual({
      policyId: 'pol', policyName: 'Policy', participation: 'Approver', subjectType: 'User', principalId: U1, groupId: G1,
      rule: 'r', managerLevel: 2, displayName: 'Ann', isFallback: true, onBehalf: true, stage: 2,
    });
  });

  it('fills safe defaults', () => {
    expect(normalizeParticipant({ participation: 'Reviewer', principalId: 'nope', isFallback: 'yes', stage: '2' }, POLICY)).toMatchObject({
      subjectType: 'Other', principalId: null, groupId: null, isFallback: false, onBehalf: false, stage: 0,
    });
  });

  it.each([[null], ['x'], [{}], [{ participation: 'Owner' }]])('drops %j', (raw) => {
    expect(normalizeParticipant(raw, POLICY)).toBeNull();
  });
});

describe('readParticipants', () => {
  it('flattens policies and survives one without a list', () => {
    const out = readParticipants([
      { id: 'a', participants: [{ participation: 'Approver' }, { participation: 'x' }] },
      { id: 'b', participants: null },
      { id: 'c', participants: [{ participation: 'Reviewer' }] },
    ]);
    expect(out.map(p => [p.policyId, p.participation])).toEqual([['a', 'Approver'], ['c', 'Reviewer']]);
  });
});

describe('namedResponsible', () => {
  it('counts named approvers and reviewers, once per person', () => {
    const named = namedResponsible([
      { participation: 'Approver', subjectType: 'User', principalId: U1, displayName: 'Ann' },
      { participation: 'Reviewer', subjectType: 'User', principalId: U1, displayName: 'Ann' },
      { participation: 'Approver', subjectType: 'User', principalId: U1, displayName: 'Ann' },
    ]);
    expect([...named.keys()]).toEqual([U1]);
    expect(named.get(U1).derivedFrom).toEqual(['Approver', 'Reviewer']);
  });

  it.each([
    [{ participation: 'Requestor', subjectType: 'User', principalId: U1 }],
    [{ participation: 'Approver', subjectType: 'Manager', principalId: null }],
    [{ participation: 'Approver', subjectType: 'Group', principalId: U1 }],
    [{ participation: 'Reviewer', subjectType: 'User', principalId: null }],
  ])('makes nobody Responsible from %j', (p) => expect(namedResponsible([p]).size).toBe(0));
});

describe('withPolicyResponsible', () => {
  const approver = { participation: 'Approver', subjectType: 'User', principalId: U1, displayName: 'Ann' };

  it('adds a named approver as a read-only Responsible', () => {
    expect(withPolicyResponsible([], [approver])).toEqual([{
      id: `policy:${U1}`, role: 'Responsible', principalId: U1, identityId: null, addedBy: 'policy', displayName: 'Ann', derivedFrom: ['Approver'],
    }]);
  });

  it('marks someone already Responsible instead of listing them twice', () => {
    const out = withPolicyResponsible([{ id: 'o1', role: 'Responsible', principalId: U1 }], [approver]);
    expect(out).toEqual([{ id: 'o1', role: 'Responsible', principalId: U1, derivedFrom: ['Approver'] }]);
  });

  it('keeps an Accountable who also approves in both places', () => {
    const out = withPolicyResponsible([{ id: 'o1', role: 'Accountable', principalId: U1 }], [approver]);
    expect(out.map(o => o.role)).toEqual(['Accountable', 'Responsible']);
    expect(out[0].derivedFrom).toBeUndefined();
  });

  it('leaves owners alone without participants', () => {
    const owners = [{ id: 'o1', role: 'Responsible', principalId: U2 }];
    expect(withPolicyResponsible(owners, [])).toEqual(owners);
  });
});

describe('loadParticipants', () => {
  // Answers by the shape of the query; `ctx` are the rows of the context lookup.
  function stage({ participants, ctx = [], groupMembers = [{ id: U1 }, { id: U2 }] }) {
    query.mockImplementation(async (sql) => {
      if (/FROM "AssignmentPolicies"/.test(sql)) return { rows: [{ id: 'pol', displayName: 'Policy', participants }] };
      if (/FROM "Principals"/.test(sql)) return { rows: [{ id: U1, displayName: 'Ann From Directory' }] };
      if (/FROM "Resources"/.test(sql)) return { rows: [{ id: G1, displayName: 'SG-Finance' }] };
      if (/FROM "ResourceAssignments"/.test(sql)) return { rows: groupMembers };
      if (/FROM "Contexts"/.test(sql)) return { rows: ctx };
      return { rows: [] };
    });
  }
  const requestorGroup = { participation: 'Requestor', subjectType: 'Group', groupId: G1 };

  it('prefers the directory name over the stored description', async () => {
    stage({ participants: [{ participation: 'Approver', subjectType: 'User', principalId: U1, displayName: 'old' }] });
    expect((await loadParticipants('r'))[0].displayName).toBe('Ann From Directory');
  });

  it('keeps the description for someone not in the directory', async () => {
    stage({ participants: [{ participation: 'Reviewer', subjectType: 'User', principalId: U2, displayName: 'Described' }] });
    expect((await loadParticipants('r'))[0].displayName).toBe('Described');
  });

  it('names a group and links the one context with exactly its members', async () => {
    stage({ participants: [requestorGroup], ctx: [{ id: C1, displayName: 'Finance team' }] });
    expect((await loadParticipants('r'))[0]).toMatchObject({ displayName: 'SG-Finance', contextId: C1, contextName: 'Finance team' });
    const call = query.mock.calls.find(([s]) => /HAVING/.test(s));
    expect(call[1]).toEqual([U1, 2, [U1, U2]]);
  });

  it('links nothing when two contexts have the same members', async () => {
    stage({ participants: [requestorGroup], ctx: [{ id: C1 }, { id: U2 }] });
    expect((await loadParticipants('r'))[0].contextId).toBeNull();
  });

  it('links nothing for an empty group', async () => {
    stage({ participants: [requestorGroup], groupMembers: [], ctx: [{ id: C1 }] });
    expect((await loadParticipants('r'))[0].contextId).toBeNull();
  });

  it('links a one-department rule to that department', async () => {
    stage({ participants: [{ participation: 'Requestor', subjectType: 'Rule', rule: '(user.department -eq "IT")' }], ctx: [{ id: C1, displayName: 'IT' }] });
    expect((await loadParticipants('r'))[0].contextName).toBe('IT');
    expect(query.mock.calls.find(([s]) => /"contextType" = 'Department'/.test(s))[1]).toEqual(['IT']);
  });

  it('does not link a rule it cannot read as one department', async () => {
    stage({ participants: [{ participation: 'Requestor', subjectType: 'Rule', rule: '(user.jobTitle -eq "x")' }], ctx: [{ id: C1 }] });
    expect((await loadParticipants('r'))[0].contextId).toBeNull();
  });

  it('looks for a context for a request scope only', async () => {
    stage({ participants: [{ participation: 'Approver', subjectType: 'Group', groupId: G1 }], ctx: [{ id: C1 }] });
    expect((await loadParticipants('r'))[0].contextId).toBeNull();
    expect(query.mock.calls.some(([s]) => /FROM "Contexts"/.test(s))).toBe(false);
  });

  it('asks for no names when nobody is named', async () => {
    stage({ participants: [{ participation: 'Reviewer', subjectType: 'Manager' }] });
    await loadParticipants('r');
    expect(query).toHaveBeenCalledTimes(1);
  });
});

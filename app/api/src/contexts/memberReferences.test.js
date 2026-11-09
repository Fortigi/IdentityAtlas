// A context member's references, names only (contexts/memberReferences.js).
//
// The pool is a fake that answers by statement, so these pin what reaches the
// SQL (whose subjects, which flag, which cap) and how the rows are shaped. Which
// rows the statements pick is contract-tests/memberReferences.contract.test.js.

import { describe, it, expect, vi } from 'vitest';
import {
  REFERENCE_CAP, toReferenceGroup, memberSubjects, findContextMember, loadMemberReferences,
} from './memberReferences.js';

const CTX = 'aaaaaaaa-0000-4000-8000-000000000001';
const MEMBER = 'bbbbbbbb-0000-4000-8000-000000000002';
const ACCOUNT = 'cccccccc-0000-4000-8000-000000000003';

const named = (n, total) => Array.from({ length: n }, (_, i) => ({ displayName: `R${i}`, total: String(total) }));

// A pool whose answer depends on the statement: the first `match` whose needle
// is in the SQL wins. Every call is recorded.
function fakePool(match) {
  return {
    query: vi.fn(async (sql) => {
      const hit = match.find(([needle]) => sql.includes(needle));
      return { rows: hit ? hit[1] : [] };
    }),
  };
}
const callsFor = (pool, needle) => pool.query.mock.calls.filter(([sql]) => sql.includes(needle));

describe('toReferenceGroup — the cap', () => {
  it('keeps all 50 of exactly 50, with nothing more to say', () => {
    const g = toReferenceGroup('resources', named(50, 50));
    expect(g.items).toHaveLength(50);
    expect(g.total).toBe(50);
    expect(g.items[49]).toEqual({ displayName: 'R49' });
  });

  it('keeps 50 of 51 and reports the true total of 51', () => {
    const g = toReferenceGroup('resources', named(51, 51));
    expect(g.items).toHaveLength(50);
    expect(g.items.at(-1).displayName).toBe('R49');
    expect(g.total).toBe(51);
  });

  it('takes the total from the window count, not from the rows it got', () => {
    expect(toReferenceGroup('contexts', named(3, 1234)).total).toBe(1234);
  });

  it('never claims fewer than it lists, and an empty group is 0', () => {
    expect(toReferenceGroup('contexts', [{ displayName: 'x' }]).total).toBe(1);
    expect(toReferenceGroup('contexts', [])).toEqual({ key: 'contexts', items: [], total: 0 });
  });

  it('drops the total column from every item and keeps the rest as given', () => {
    const g = toReferenceGroup('holders', [{ displayName: 'Ann', holderType: 'User', assignmentType: 'Direct', total: '1' }]);
    expect(g.items).toEqual([{ displayName: 'Ann', holderType: 'User', assignmentType: 'Direct' }]);
  });

  it('caps at 50 by default', () => {
    expect(REFERENCE_CAP).toBe(50);
  });
});

describe('memberSubjects', () => {
  it('an account stands for itself, with no person', async () => {
    const pool = fakePool([]);
    expect(await memberSubjects(pool, 'Principal', MEMBER)).toEqual({ principalIds: [MEMBER], identityId: null });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('a person is its linked accounts plus the person', async () => {
    const pool = fakePool([['IdentityMembers', [{ principalId: ACCOUNT }]]]);
    expect(await memberSubjects(pool, 'Identity', MEMBER)).toEqual({ principalIds: [ACCOUNT], identityId: MEMBER });
    expect(pool.query.mock.calls[0][1]).toEqual([MEMBER]);
  });

  it('a resource or a system holds nothing', async () => {
    expect(await memberSubjects(fakePool([]), 'Resource', MEMBER)).toEqual({ principalIds: [], identityId: null });
  });
});

describe('findContextMember', () => {
  it('returns the membership row, or null when the id is not a member of THIS context', async () => {
    expect(await findContextMember(fakePool([['ContextMembers', [{ memberType: 'Principal' }]]]), CTX, MEMBER))
      .toEqual({ memberType: 'Principal' });
    const pool = fakePool([]);
    expect(await findContextMember(pool, CTX, MEMBER)).toBeNull();
    expect(pool.query.mock.calls[0][1]).toEqual([CTX, MEMBER]);
  });
});

describe('loadMemberReferences', () => {
  it('for a person: groups & resources, business roles and other contexts, through the person and their accounts', async () => {
    const pool = fakePool([
      ['IdentityMembers', [{ principalId: ACCOUNT }]],
      ['ResourceAssignments', [{ displayName: 'Finance-Admins', resourceType: 'Group', systemName: 'Entra', assignmentType: 'Direct', total: '1' }]],
      ['"ContextMembers"', [{ displayName: 'Sales', contextType: 'Department', targetType: 'Identity', total: '1' }]],
    ]);
    const out = await loadMemberReferences(pool, CTX, 'Identity', MEMBER);
    expect(out.memberType).toBe('Identity');
    expect(out.groups.map(g => g.key)).toEqual(['resources', 'businessRoles', 'contexts']);
    expect(out.groups[0].items).toEqual([{ displayName: 'Finance-Admins', resourceType: 'Group', systemName: 'Entra', assignmentType: 'Direct' }]);

    const held = callsFor(pool, 'ResourceAssignments').map(([, params]) => params);
    // [principalIds, identityId, businessRoles?, cap] — once without, once with business roles.
    expect(held).toEqual([[[ACCOUNT], MEMBER, false, 50], [[ACCOUNT], MEMBER, true, 50]]);
    // Other contexts: of the person or any of their accounts, never this one.
    expect(callsFor(pool, 'c.id <> $1')[0][1]).toEqual([CTX, [MEMBER, ACCOUNT], 50]);
  });

  it('for an account: its own assignments, no person', async () => {
    const pool = fakePool([]);
    await loadMemberReferences(pool, CTX, 'Principal', MEMBER, 7);
    expect(callsFor(pool, 'ResourceAssignments').map(([, p]) => p))
      .toEqual([[[MEMBER], null, false, 7], [[MEMBER], null, true, 7]]);
    expect(callsFor(pool, 'IdentityMembers')).toHaveLength(0);
  });

  it('for a resource: who holds it, the business roles containing it, and its other contexts', async () => {
    const pool = fakePool([
      ['"Principals"', [{ displayName: 'Ann', holderType: 'User', assignmentType: 'Eligible', total: '2' }]],
      ['ResourceRelationships', [{ displayName: 'Payroll clerk', systemName: 'Omada', total: '1' }]],
    ]);
    const out = await loadMemberReferences(pool, CTX, 'Resource', MEMBER);
    expect(out.groups.map(g => [g.key, g.total])).toEqual([['holders', 2], ['businessRoles', 1], ['contexts', 0]]);
    expect(out.groups[0].items[0]).toEqual({ displayName: 'Ann', holderType: 'User', assignmentType: 'Eligible' });
    expect(callsFor(pool, 'ResourceRelationships')[0][1]).toEqual([MEMBER, 50]);
    expect(callsFor(pool, 'c.id <> $1')[0][1]).toEqual([CTX, [MEMBER], 50]);
  });

  it('for a system: only its other contexts', async () => {
    const pool = fakePool([]);
    const out = await loadMemberReferences(pool, CTX, 'System', MEMBER);
    expect(out.groups.map(g => g.key)).toEqual(['contexts']);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('never returns an id — names and the words to read them only', async () => {
    const pool = fakePool([
      ['"Principals"', [{ displayName: 'Ann', holderType: 'User', assignmentType: 'Direct', total: '1' }]],
      ['ResourceRelationships', [{ displayName: 'Payroll clerk', systemName: 'Omada', total: '1' }]],
      ['"ContextMembers"', [{ displayName: 'Sales', contextType: 'Department', targetType: 'Identity', total: '1' }]],
    ]);
    const out = await loadMemberReferences(pool, CTX, 'Resource', MEMBER);
    const keys = new Set(out.groups.flatMap(g => g.items.flatMap(Object.keys)));
    expect([...keys].sort()).toEqual(['assignmentType', 'contextType', 'displayName', 'holderType', 'systemName', 'targetType']);
  });
});

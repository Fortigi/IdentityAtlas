import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query, queryOne } from '../db/connection.js';
import {
  suggestOwner, suggestBusinessRoleOwners, SCOPE_ACCOUNTABLE_SQL, RESPONSIBLE_MANAGER_SQL, HOLDER_TOTAL_SQL, RESOURCE_TOTAL_SQL, MANAGER_SQL, RESOURCE_OWNER_SQL, SIGNAL_ORDER,
} from './businessRoleOwnerSuggestion.js';

const ROLE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MGR = { id: 'mgr', displayName: 'Mara', count: 8 };
const OWNER = { id: 'own', displayName: 'Omar', count: 3 };

// totals + candidates per signal; a candidate list is what the SQL would return.
function stage({ holders = 0, resources = 0, manager = [], owner = [] } = {}) {
  queryOne.mockImplementation(async (sql) => ({ total: sql === HOLDER_TOTAL_SQL ? holders : resources }));
  query.mockImplementation(async (sql) => ({ rows: sql === MANAGER_SQL ? manager : owner }));
}

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('suggestOwner', () => {
  it('prefers the manager of the holders for Accountable', async () => {
    stage({ holders: 10, resources: 4, manager: [MGR], owner: [OWNER] });
    expect(await suggestOwner(ROLE, 'Accountable')).toEqual({
      role: 'Accountable', principalId: 'mgr', displayName: 'Mara', reason: 'manages 8 of the 10 holders', count: 8, total: 10,
    });
  });

  it('prefers the owner of the resources for Responsible', async () => {
    stage({ holders: 10, resources: 4, manager: [MGR], owner: [OWNER] });
    expect(await suggestOwner(ROLE, 'Responsible')).toMatchObject({ role: 'Responsible', principalId: 'own', reason: 'owns 3 of the 4 resources' });
  });

  it('falls back to the second signal when the first is below the threshold', async () => {
    stage({ holders: 100, resources: 4, manager: [MGR], owner: [OWNER] });
    expect(await suggestOwner(ROLE, 'Accountable')).toMatchObject({ principalId: 'own' });
  });

  it('falls back when the role has no holders at all, without querying candidates for them', async () => {
    stage({ holders: 0, resources: 4, manager: [MGR], owner: [OWNER] });
    expect(await suggestOwner(ROLE, 'Accountable')).toMatchObject({ principalId: 'own' });
    expect(query.mock.calls.some(([s]) => s === MANAGER_SQL)).toBe(false);
  });

  it('suggests a candidate at exactly the 40% threshold and not just below it', async () => {
    stage({ holders: 10, manager: [{ ...MGR, count: 4 }] });
    expect(await suggestOwner(ROLE, 'Accountable')).toMatchObject({ count: 4 });
    stage({ holders: 11, manager: [{ ...MGR, count: 4 }] });
    expect(await suggestOwner(ROLE, 'Accountable')).toBeNull();
  });

  it('is null when no signal gives a candidate', async () => {
    stage({ holders: 5, resources: 5 });
    expect(await suggestOwner(ROLE, 'Responsible')).toBeNull();
  });

  it('passes the role and the excluded people to the query', async () => {
    stage({ holders: 2, manager: [{ ...MGR, count: 2 }] });
    await suggestOwner(ROLE, 'Accountable', ['x']);
    expect(query.mock.calls[0][1]).toEqual([ROLE, 'Accountable', ['x']]);
  });

  it('asks the signals in the documented order', () => {
    expect(SIGNAL_ORDER).toEqual({ Accountable: ['manager', 'owner'], Responsible: ['owner', 'manager'] });
  });
});

describe('suggestBusinessRoleOwners', () => {
  it('suggests both places, never the same person twice', async () => {
    stage({ holders: 10, resources: 4, manager: [MGR], owner: [OWNER] });
    const out = await suggestBusinessRoleOwners(ROLE, []);
    expect(out.Accountable.principalId).toBe('mgr');
    expect(out.Responsible.principalId).toBe('own');
    const responsibleCall = query.mock.calls.find(([, p]) => p[1] === 'Responsible');
    expect(responsibleCall[1][2]).toEqual(['mgr']);
  });

  it('excludes the current Accountable from the Responsible guess', async () => {
    stage({ holders: 10, resources: 4, manager: [MGR], owner: [OWNER] });
    const out = await suggestBusinessRoleOwners(ROLE, [{ role: 'Accountable', principalId: 'acc' }]);
    expect(out.Accountable).toBeNull();
    expect(query.mock.calls.find(([, p]) => p[1] === 'Responsible')[1][2]).toEqual(['acc']);
  });

  it('suggests nobody for a place already held', async () => {
    stage({ holders: 10, resources: 4, manager: [MGR], owner: [OWNER] });
    const out = await suggestBusinessRoleOwners(ROLE, [{ role: 'Accountable', principalId: 'a' }, { role: 'Responsible', principalId: 'r' }]);
    expect(out).toEqual({ Accountable: null, Responsible: null });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('suggesting from the policies', () => {
  const ctxRequestor = { participation: 'Requestor', contextId: 'ctx-1' };
  const approver = { id: 'policy:a', role: 'Responsible', principalId: 'a', derivedFrom: ['Approver'] };

  function stageSql({ scope = [], manager = [] }) {
    queryOne.mockResolvedValue({ total: 0 });
    query.mockImplementation(async (sql) => {
      if (sql === SCOPE_ACCOUNTABLE_SQL) return { rows: scope };
      if (sql === RESPONSIBLE_MANAGER_SQL) return { rows: manager };
      return { rows: [] };
    });
  }

  it('prefers the Accountable of the context the request scope maps to', async () => {
    stageSql({ scope: [{ id: 'boss', displayName: 'Bo', contextName: 'Finance' }], manager: [{ id: 'm', displayName: 'M', count: 1 }] });
    const out = await suggestBusinessRoleOwners(ROLE, [approver], [ctxRequestor]);
    expect(out.Accountable).toMatchObject({ principalId: 'boss', reason: 'accountable for Finance, who may request this role' });
  });

  it('does not pick when the mapped contexts have different Accountables', async () => {
    stageSql({ scope: [{ id: 'b1', contextName: 'A' }, { id: 'b2', contextName: 'B' }], manager: [{ id: 'm', displayName: 'M', count: 1 }] });
    expect((await suggestBusinessRoleOwners(ROLE, [approver], [ctxRequestor])).Accountable.principalId).toBe('m');
  });

  it('counts one person accountable for two mapped contexts as clear', async () => {
    stageSql({ scope: [{ id: 'b1', displayName: 'Bo', contextName: 'A' }, { id: 'b1', displayName: 'Bo', contextName: 'B' }] });
    expect((await suggestBusinessRoleOwners(ROLE, [], [ctxRequestor])).Accountable.principalId).toBe('b1');
  });

  it('falls to the manager of the named approvers', async () => {
    stageSql({ manager: [{ id: 'm', displayName: 'Mara', count: 1 }] });
    const out = await suggestBusinessRoleOwners(ROLE, [approver], []);
    expect(out.Accountable).toMatchObject({ principalId: 'm', reason: 'manages the approver or reviewer' });
    expect(query.mock.calls.find(([s]) => s === RESPONSIBLE_MANAGER_SQL)[1]).toEqual([ROLE, ['a']]);
  });

  it('says how many approvers and reviewers the manager covers', async () => {
    stageSql({ manager: [{ id: 'm', displayName: 'Mara', count: 2 }] });
    const owners = [approver, { ...approver, id: 'policy:b', principalId: 'b' }, { ...approver, id: 'policy:c', principalId: 'c' }];
    expect((await suggestBusinessRoleOwners(ROLE, owners, [])).Accountable.reason).toBe('manages 2 of the 3 approvers and reviewers');
  });

  it('ignores a manager of too few of them, and a hand-picked Responsible', async () => {
    stageSql({ manager: [{ id: 'm', displayName: 'Mara', count: 1 }] });
    const owners = [approver, ...['b', 'c'].map(p => ({ ...approver, id: p, principalId: p }))];
    expect((await suggestBusinessRoleOwners(ROLE, owners, [])).Accountable).toBeNull();
    query.mockClear();
    await suggestBusinessRoleOwners(ROLE, [{ id: 'o', role: 'Responsible', principalId: 'h' }], []);
    expect(query.mock.calls.some(([s]) => s === RESPONSIBLE_MANAGER_SQL)).toBe(false);
  });

  it('offers no Responsible guess once a policy names one', async () => {
    stageSql({ manager: [{ id: 'm', displayName: 'Mara', count: 1 }] });
    expect((await suggestBusinessRoleOwners(ROLE, [approver], [])).Responsible).toBeNull();
  });

  it.each([[SCOPE_ACCOUNTABLE_SQL], [RESPONSIBLE_MANAGER_SQL]])('never offers someone already turned down', (sql) => {
    expect(sql).toContain('"BusinessRoleOwnerRejections"');
    expect(sql).toContain("x.role = 'Accountable'");
  });
});

describe('the suggestion queries', () => {
  it.each([['manager', MANAGER_SQL, 'm.id'], ['owner', RESOURCE_OWNER_SQL, 'p.id']])('%s skips rejected and excluded people', (_n, sql, column) => {
    expect(sql).toContain(`${column} <> ALL($3::uuid[])`);
    expect(sql).toMatch(/"BusinessRoleOwnerRejections"/);
    expect(sql).toContain('x.role = $2');
  });

  it('counts only live holders and live resources', () => {
    expect(HOLDER_TOTAL_SQL).toContain('a."deletedAt" IS NULL');
    expect(HOLDER_TOTAL_SQL).toContain('e."deletedAt" IS NULL');
    expect(RESOURCE_TOTAL_SQL).toContain('r."deletedAt" IS NULL');
  });
});

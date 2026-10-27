// The workbench read: which statements run, in which order, with what — and that
// their number does not grow with the unit (no N+1). The SQL runs against
// PostgreSQL in contract-tests/workbench.contract.test.js; the assembly is model.test.js's.
import { describe, it, expect, vi } from 'vitest';
import {
  loadWorkbench, WorkbenchError, MAX_PEOPLE, SCOPE_SQL, MEMBERS_SQL, LINKS_SQL, IDENTITIES_SQL, ACCOUNTS_SQL,
  PRINCIPALS_SQL, ACCESS_SQL, VIA_ROLE_SQL, RESOURCES_SQL, ROLE_PARTS_SQL, KNOWLEDGE_SQL,
} from './load.js';

const UNIT = 'dddddddd-0000-4000-8000-000000000001';

function fakeDb({ unit = { id: UNIT, displayName: 'Claims', contextType: 'Department', contextCategory: 'OrganizationalUnit', targetType: 'Identity' }, members, resources } = {}) {
  const calls = [];
  const answers = new Map([
    [SCOPE_SQL, [{ id: UNIT, displayName: 'Claims' }, { id: 'sub', displayName: 'Motor' }]],
    [MEMBERS_SQL, members ?? [
      { memberType: 'Identity', memberId: 'id-a', direct: true, unitName: 'Claims' },
      { memberType: 'Principal', memberId: 'p-b', direct: false, unitName: 'Motor' },
      { memberType: 'Principal', memberId: 'p-loose', direct: false, unitName: 'Motor' },
    ]],
    [LINKS_SQL, [{ principalId: 'p-b', identityId: 'id-b' }]],
    [IDENTITIES_SQL, [{ id: 'id-a', displayName: 'Anna' }, { id: 'id-b', displayName: 'Bram' }]],
    [ACCOUNTS_SQL, [{ identityId: 'id-a', id: 'p-a' }, { identityId: 'id-b', id: 'p-b' }]],
    [PRINCIPALS_SQL, [{ id: 'p-loose', displayName: 'svc' }]],
    [ACCESS_SQL, [
      { principalId: 'p-a', resourceId: 'r1', membershipType: 'Direct' },
      { principalId: 'p-b', resourceId: 'br', membershipType: 'Direct' },
      { principalId: 'p-loose', resourceId: 'r2', membershipType: 'Direct' },
    ]],
    [VIA_ROLE_SQL, []],
    [KNOWLEDGE_SQL, [{ id: 'c1', claimKind: 'duty', identityId: 'id-b', value: 'Works council', status: 'confirmed', objectName: 'Works council' }]],
    [RESOURCES_SQL, resources ?? [
      { id: 'r1', displayName: 'Read', resourceType: 'AppRole' },
      { id: 'br', displayName: 'Handler', resourceType: 'BusinessRole', governanceResource: true },
      { id: 'r2', displayName: 'Batch', resourceType: 'Group' },
    ]],
    [ROLE_PARTS_SQL, [{ roleId: 'br', resourceId: 'r1' }]],
  ]);
  return {
    calls,
    queryOne: vi.fn(async () => unit),
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (!answers.has(sql)) throw new Error('unexpected SQL');
      return { rows: answers.get(sql) };
    }),
  };
}

describe('loadWorkbench', () => {
  it('reads the scope, people, accounts, access, roles and knowledge in a fixed set of statements', async () => {
    const db = fakeDb();
    const out = await loadWorkbench(db, UNIT, { includeChildren: true });
    expect(db.calls.map(c => c.sql)).toEqual([
      SCOPE_SQL, MEMBERS_SQL, LINKS_SQL, IDENTITIES_SQL, ACCOUNTS_SQL, PRINCIPALS_SQL,
      ACCESS_SQL, VIA_ROLE_SQL, KNOWLEDGE_SQL, RESOURCES_SQL, ROLE_PARTS_SQL,
    ]);
    expect(db.calls[0].params).toEqual([UNIT, true]);
    expect(db.calls[1].params).toEqual([[UNIT, 'sub'], UNIT, MAX_PEOPLE + 1]);
    // Only the account nobody linked is read as a principal of its own.
    expect(db.calls[5].params).toEqual([['p-loose']]);
    expect(db.calls[6].params).toEqual([['p-a', 'p-b', 'p-loose']]);
    expect(db.calls[8].params).toEqual([['id-a', 'id-b'], ['p-a', 'p-b', 'p-loose'], ['activity', 'expertise', 'duty']]);
    expect(db.calls[10].params).toEqual([['br']]);

    expect(out.unit).toEqual({ id: UNIT, displayName: 'Claims', contextType: 'Department', targetType: 'Identity' });
    expect(out.scope).toEqual({ includeChildren: true, units: 2, truncatedPeople: false, maxPeople: MAX_PEOPLE, unresolved: 0 });
    expect(out.people.map(p => [p.key, p.knowledge.length])).toEqual([['i:id-a', 0], ['i:id-b', 1], ['p:p-loose', 0]]);
    expect(out.columns.map(c => [c.id, c.isRole, c.contains])).toEqual([['br', true, ['r1']], ['r2', false, []], ['r1', false, []]]);
    expect(out.cells).toHaveLength(3);
    expect(out.kinds.map(k => k.predicate)).toEqual(['performsActivity', 'hasExpertise', 'holdsResponsibility']);
    expect(Date.parse(out.generatedAt)).not.toBeNaN();
  });

  it('skips the link and role-part reads when there is nothing to look up', async () => {
    const db = fakeDb({ members: [{ memberType: 'Identity', memberId: 'id-a', direct: true, unitName: 'Claims' }], resources: [{ id: 'r1', displayName: 'Read' }] });
    await loadWorkbench(db, UNIT, { includeChildren: false });
    const sqls = db.calls.map(c => c.sql);
    expect(sqls).not.toContain(LINKS_SQL);
    expect(sqls).not.toContain(ROLE_PARTS_SQL);
    expect(db.calls[0].params).toEqual([UNIT, false]);
  });

  it('says when the unit has more people than it shows, and shows the first ones', async () => {
    const many = Array.from({ length: MAX_PEOPLE + 1 }, (_, i) => ({ memberType: 'Identity', memberId: `id-${i}`, direct: true }));
    const out = await loadWorkbench(fakeDb({ members: many }), UNIT);
    expect(out.scope.truncatedPeople).toBe(true);
  });

  it('refuses a context that is not there, and one that is not an organizational unit', async () => {
    await expect(loadWorkbench(fakeDb({ unit: null }), UNIT)).rejects.toMatchObject({ status: 404 });
    const app = { id: UNIT, contextCategory: 'LogicalApplication' };
    await expect(loadWorkbench(fakeDb({ unit: app }), UNIT)).rejects.toBeInstanceOf(WorkbenchError);
    await expect(loadWorkbench(fakeDb({ unit: app }), UNIT)).rejects.toMatchObject({ status: 400 });
  });

  it('reads only what it needs: no write, no ResourceAssignments', () => {
    const all = [SCOPE_SQL, MEMBERS_SQL, LINKS_SQL, IDENTITIES_SQL, ACCOUNTS_SQL, PRINCIPALS_SQL, ACCESS_SQL, VIA_ROLE_SQL, RESOURCES_SQL, ROLE_PARTS_SQL, KNOWLEDGE_SQL].join('\n');
    expect(all).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    expect(all).not.toMatch(/"ResourceAssignments"/);
    expect(MEMBERS_SQL).toMatch(/ContextMemberOverrides/);
  });
});

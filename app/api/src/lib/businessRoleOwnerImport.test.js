import { describe, it, expect, vi } from 'vitest';
import {
  splitHolders, readOwnerRows, buildRoleMatcher, accountableAction, planRow, summarize, planOwnerImport, applyOwnerPlan,
} from './businessRoleOwnerImport.js';

vi.mock('../contexts/upload/members.js', () => ({
  matchAll: vi.fn(async (_db, { Principal }) => ({
    ids: { Principal: new Map(Principal.filter(v => v !== 'nobody').map(v => [v, `id-${v}`])) },
    stats: { fuzzySamples: [{ kind: 'Principal', value: 'Anne', matched: 'Ann' }] },
  })),
}));

const R1 = { id: 'aaaaaaaa-0000-0000-0000-000000000001', displayName: 'Finance', externalId: 'ext-1' };
const R2 = { id: 'aaaaaaaa-0000-0000-0000-000000000002', displayName: 'Sales', externalId: 'ext-2' };

describe('splitHolders', () => {
  it('splits on ; and | and keeps a comma inside a name', () => {
    expect(splitHolders(' Jansen, Piet ; ann@x.test|bo ')).toEqual(['Jansen, Piet', 'ann@x.test', 'bo']);
  });
  it.each([[null], [undefined], [''], [' ; ']])('is empty for %j', (v) => expect(splitHolders(v)).toEqual([]));
});

describe('readOwnerRows', () => {
  it('finds the columns whatever their case or spacing, and numbers file lines', () => {
    const rows = readOwnerRows({
      columns: ['Business Role', 'ACCOUNTABLE', 'responsible'],
      rows: [{ 'Business Role': ' Finance ', ACCOUNTABLE: 'ann', responsible: 'bo; cy' }],
    });
    expect(rows).toEqual([{ line: 2, businessRole: 'Finance', accountable: ['ann'], responsible: ['bo', 'cy'] }]);
  });

  it('works with only a Responsible column', () => {
    const rows = readOwnerRows({ columns: ['role', 'Responsible'], rows: [{ role: 'x', Responsible: 'bo' }] });
    expect(rows[0]).toMatchObject({ accountable: [], responsible: ['bo'] });
  });

  it('drops a fully blank row but keeps the numbering of the others', () => {
    const rows = readOwnerRows({ columns: ['name', 'accountable'], rows: [{ name: '', accountable: '' }, { name: 'x', accountable: 'a' }] });
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe(3);
  });

  it('refuses a list without a role column', () => {
    expect(() => readOwnerRows({ columns: ['accountable'], rows: [] })).toThrow(/Business role/);
  });

  it('refuses a list without an owner column', () => {
    expect(() => readOwnerRows({ columns: ['role'], rows: [] })).toThrow(/Accountable.*Responsible/);
  });
});

describe('buildRoleMatcher', () => {
  const match = buildRoleMatcher([R1, R2, { id: 'dup-1', displayName: 'Twice' }, { id: 'dup-2', displayName: 'twice' }]);

  it.each([[R1.id], ['ext-1'], ['Finance'], ['FINANCE']])('finds a role by %s', (v) => expect(match(v)).toBe(R1));
  it('is null for an unknown role', () => expect(match('nope')).toBeNull());
  it('is ambiguous when two roles share a name', () => expect(match('Twice')).toEqual({ ambiguous: true }));
  it('a role whose id and name are the same value is still one role', () => {
    const r = { id: 'same', displayName: 'same', externalId: 'same' };
    expect(buildRoleMatcher([r])('same')).toBe(r);
  });
});

describe('accountableAction', () => {
  it.each([
    [null, 'p1', 'set'],
    [{ principalId: 'p1', addedBy: 'analyst' }, 'p1', 'same'],
    [{ principalId: 'p2', addedBy: 'analyst' }, 'p1', 'kept'],
    [{ principalId: 'p2', addedBy: 'sync' }, 'p1', 'replace'],
    [{ principalId: 'p2', addedBy: 'import' }, 'p1', 'replace'],
  ])('%j with %s is %s', (current, id, action) => expect(accountableAction(current, id)).toBe(action));
});

describe('planRow', () => {
  const ctx = (owners = []) => ({
    matchRole: buildRoleMatcher([R1, { id: 'd1', displayName: 'Dup' }, { id: 'd2', displayName: 'Dup' }]),
    people: new Map([['ann', 'p-ann'], ['bo', 'p-bo']]),
    names: new Map([['p-ann', 'Ann A'], ['p-bo', 'Bo B']]),
    owners: new Map([[R1.id, owners]]),
  });
  const entry = (over) => ({ line: 2, businessRole: 'Finance', accountable: [], responsible: [], ...over });

  it('reports a role it cannot find', () => {
    expect(planRow(entry({ businessRole: 'nope' }), ctx())).toMatchObject({ problem: 'Business role not found', changes: [] });
  });

  it('reports an ambiguous role', () => {
    expect(planRow(entry({ businessRole: 'Dup' }), ctx()).problem).toMatch(/More than one/);
  });

  it('plans an Accountable and resolves the name', () => {
    const row = planRow(entry({ accountable: ['ann'] }), ctx());
    expect(row.businessRoleId).toBe(R1.id);
    expect(row.changes).toEqual([{ role: 'Accountable', value: 'ann', principalId: 'p-ann', displayName: 'Ann A', action: 'set' }]);
  });

  it('refuses two Accountables in one cell', () => {
    const row = planRow(entry({ accountable: ['ann', 'bo'] }), ctx());
    expect(row.changes).toHaveLength(1);
    expect(row.changes[0]).toMatchObject({ action: 'tooMany', principalId: null });
  });

  it('marks an unknown person', () => {
    const row = planRow(entry({ accountable: ['zed'], responsible: ['zed'] }), ctx());
    expect(row.changes.map(c => c.action)).toEqual(['unmatched', 'unmatched']);
  });

  it('adds a new Responsible and recognises one already there', () => {
    const row = planRow(entry({ responsible: ['ann', 'bo'] }), ctx([{ role: 'Responsible', principalId: 'p-bo', addedBy: 'sync' }]));
    expect(row.changes.map(c => c.action)).toEqual(['add', 'same']);
  });

  it('does not treat an Accountable as already being Responsible', () => {
    const row = planRow(entry({ responsible: ['ann'] }), ctx([{ role: 'Accountable', principalId: 'p-ann', addedBy: 'analyst' }]));
    expect(row.changes[0].action).toBe('add');
  });
});

describe('summarize', () => {
  it('counts each action in its own bucket', () => {
    const rows = [
      { problem: 'x', changes: [] },
      { changes: [{ action: 'set' }, { action: 'replace' }, { action: 'add' }, { action: 'same' }, { action: 'kept' }, { action: 'unmatched' }, { action: 'tooMany' }] },
    ];
    expect(summarize(rows)).toEqual({ roles: 1, toWrite: 3, unchanged: 1, kept: 1, problems: 3 });
  });
});

describe('planOwnerImport', () => {
  const db = (existing = []) => ({
    query: vi.fn(async (sql) => {
      if (/FROM "Resources"/.test(sql)) return { rows: [R1, R2] };
      if (/FROM "Principals"/.test(sql)) return { rows: [{ id: 'id-ann', displayName: 'Ann A' }] };
      return { rows: existing };
    }),
  });

  it('plans from a table and passes near matches through for the preview', async () => {
    const plan = await planOwnerImport(db(), { columns: ['role', 'accountable'], rows: [{ role: 'Finance', accountable: 'ann' }, { role: 'Sales', accountable: 'nobody' }] });
    expect(plan.rows[0].changes[0]).toMatchObject({ principalId: 'id-ann', displayName: 'Ann A', action: 'set' });
    expect(plan.rows[1].changes[0].action).toBe('unmatched');
    expect(plan.summary).toMatchObject({ roles: 2, toWrite: 1, problems: 1 });
    expect(plan.nearMatches).toHaveLength(1);
  });

  it('sees the existing owner of each role', async () => {
    const d = db([{ resourceId: R1.id, role: 'Accountable', principalId: 'other', addedBy: 'analyst' }]);
    const plan = await planOwnerImport(d, { columns: ['role', 'accountable'], rows: [{ role: 'Finance', accountable: 'ann' }] });
    expect(plan.rows[0].changes[0].action).toBe('kept');
  });

  it('does not look up names when nobody matched', async () => {
    const d = db();
    await planOwnerImport(d, { columns: ['role', 'accountable'], rows: [{ role: 'Finance', accountable: 'nobody' }] });
    expect(d.query.mock.calls.some(([s]) => /FROM "Principals"/.test(s))).toBe(false);
  });
});

describe('applyOwnerPlan', () => {
  const plan = { rows: [
    { problem: 'x', changes: [] },
    { businessRoleId: 'r1', changes: [
      { role: 'Accountable', principalId: 'p1', action: 'set' },
      { role: 'Accountable', principalId: 'p2', action: 'replace' },
      { role: 'Responsible', principalId: 'p3', action: 'add' },
      { role: 'Responsible', principalId: 'p4', action: 'same' },
      { role: 'Accountable', principalId: 'p5', action: 'kept' },
      { role: 'Responsible', principalId: null, action: 'unmatched' },
    ] },
  ] };

  it('writes only the planned writes, as an import', async () => {
    const set = vi.fn(async () => ({ id: 'x' }));
    expect(await applyOwnerPlan(plan, set)).toEqual({ written: 3, kept: 0 });
    expect(set).toHaveBeenCalledTimes(3);
    expect(set).toHaveBeenCalledWith('r1', { role: 'Responsible', holderCol: 'principalId', holderId: 'p3' }, 'import');
  });

  it('counts a write the database refused as kept', async () => {
    const set = vi.fn(async (_id, { holderId }) => (holderId === 'p2' ? null : { id: 'x' }));
    expect(await applyOwnerPlan(plan, set)).toEqual({ written: 2, kept: 1 });
  });
});

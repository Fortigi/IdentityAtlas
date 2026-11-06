// Unit tests for the unit report. The db mock is SQL-blind, so each read is
// recognised by a fragment only its statement contains. Whether the SQL selects
// the right rows (a deleted assignment ignored, a business role not counted, a
// person's linked accounts summed) is proven against a real schema in
// contract-tests/unitMembers.contract.test.js.
//
// Inputs discriminate: two members with different counts, so a count filed
// under the wrong member fails; attributes present on one member only.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import report, { MAX_ROWS, baseColumns, isTrue, memberStatus } from './unit-members.js';
import { fetchContextDetails } from '../contextDetails.js';

const UNIT = '33333333-3333-3333-3333-333333333333';
const PEOPLE = '44444444-4444-4444-4444-444444444444';

const unit = over => ({ id: UNIT, displayName: 'Finance accounts', targetType: 'Principal', ...over });
const detailRow = over => ({
  id: UNIT, displayName: 'Finance accounts', targetType: 'Principal', contextType: 'Department',
  contextCategory: 'OrganizationalUnit', extendedAttributes: { costCenter: 'FIN-01' }, ...over,
});
const account = (id, over = {}) => ({
  id, displayName: `Account ${id}`, email: `${id}@example.com`, jobTitle: 'Clerk', department: 'Finance',
  employeeId: `E-${id}`, principalType: 'User', accountEnabled: true, managerName: 'Ada Lovelace',
  systemName: 'Entra', extendedAttributes: {}, contextId: UNIT, unitName: 'Finance accounts', ...over,
});

const MEMBERS_SQL = 'DISTINCT ON (cm."contextId", m.id)';
const COUNTS_SQL = 'AS "entitlements"';

function stage({ units = [unit()], details = [detailRow()], members = [], counts = [], candidates = [], total = 0 } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('SELECT c.*')) return { rows: details };
    if (sql.includes('FROM "ContextRoles"')) return { rows: [] };
    if (sql.includes('ContextRoleSuggestionRejections')) return { rows: candidates };
    if (sql.includes(MEMBERS_SQL)) return { rows: members };
    if (sql.includes(COUNTS_SQL)) return { rows: counts };
    if (sql.includes(`c."targetType" IN ('Principal', 'Identity')`)) return { rows: units };
    throw new Error(`unstaged query: ${sql.slice(0, 80)}`);
  });
  queryOne.mockResolvedValue({ total });
}

const run = (params = {}) => report.run({ contexts: UNIT, ...params });
const sqlOf = fragment => query.mock.calls.find(([sql]) => sql.includes(fragment));
const keys = columns => columns.map(c => c.key);
const noticeText = result => result.notices.map(n => n.text).join('\n');

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe('unit report — template contract', () => {
  it('is a list report over units, picked from the unit lookup, with an include-sub-units switch off by default', () => {
    expect(report).toMatchObject({ name: 'unit-members', displayName: 'Unit report', form: 'list' });
    const { required, properties } = report.parametersSchema;
    expect(required).toEqual(['contexts']);
    expect(properties.contexts['x-lookup']).toBe('unit-contexts');
    expect(properties.includeSubUnits).toMatchObject({ type: 'boolean', default: false });
    expect(keys(report.columns)).toEqual([...keys(baseColumns('Principal')), 'entitlements']);
  });

  it('reads the switch the way a form or a link sends it', () => {
    for (const v of [true, 'true', '1', 1]) expect(isTrue(v), String(v)).toBe(true);
    for (const v of [false, 'false', '0', undefined, 'yes']) expect(isTrue(v), String(v)).toBe(false);
  });
});

describe('unit report — a unit of accounts', () => {
  it('lists one row per member with its details, its entitlement count, then every attribute', async () => {
    stage({
      members: [
        account('a', { extendedAttributes: { costCenter: 'FIN-01', badge: 7 } }),
        account('b', { accountEnabled: false, managerName: null, markedFormer: true, extendedAttributes: { badge: 9 } }),
      ],
      counts: [{ id: 'a', entitlements: 12 }, { id: 'b', entitlements: 3 }],
    });
    const result = await run();
    expect(keys(result.columns)).toEqual([
      'unit', 'displayName', 'status', 'email', 'employeeId', 'jobTitle', 'department', 'manager',
      'accountType', 'accountEnabled', 'system', 'entitlements', 'member.ext.badge', 'member.ext.costCenter',
    ]);
    // A member a decision marked former stays a row, with its status: the source still lists them.
    expect(result.rows.map(r => r.status)).toEqual(['current', 'marked former (decision)']);
    expect(memberStatus({ markedFormer: false })).toBe('current');
    expect(result.rows[0]).toEqual({
      unit: 'Finance accounts', displayName: 'Account a', status: 'current', email: 'a@example.com', employeeId: 'E-a',
      jobTitle: 'Clerk', department: 'Finance', manager: 'Ada Lovelace', accountType: 'User',
      accountEnabled: true, system: 'Entra', entitlements: 12, 'member.ext.badge': 7, 'member.ext.costCenter': 'FIN-01',
      _entity: { kind: 'user', id: 'a' },
    });
    expect(result.rows[1]).toMatchObject({ entitlements: 3, accountEnabled: false, manager: null, 'member.ext.costCenter': null });
    // One unit, no sub-units: the unit is stated once on the first tab.
    expect(result.constantColumns).toEqual(['unit']);
    expect(noticeText(result)).toMatch(/2 member\(s\) listed\./);
    expect(noticeText(result)).toMatch(/distinct resources each account holds/);
  });

  it('opens with the same context block as the Entitlement Pivot', async () => {
    stage({ members: [account('a')], candidates: [{ id: 'p1', displayName: 'Ada Lovelace', count: 3 }], total: 4 });
    const result = await run();
    stage({ candidates: [{ id: 'p1', displayName: 'Ada Lovelace', count: 3 }], total: 4 });
    const shared = await fetchContextDetails([{ id: UNIT }]);
    expect(result.details).toEqual(shared.details);
    expect(result.details[0].entries).toContainEqual({ label: 'Suggested Accountable', value: 'Ada Lovelace · manages 3 of the 4 members' });
    expect(result.details[0].entries).toContainEqual({ label: 'costCenter', value: 'FIN-01' });
  });

  it('counts all members in one grouped read, whatever their number', async () => {
    const callsFor = async (n) => {
      query.mockReset();
      queryOne.mockReset();
      stage({ members: Array.from({ length: n }, (_, i) => account(`m${i}`)) });
      await run();
      return query.mock.calls.length + queryOne.mock.calls.length;
    };
    const few = await callsFor(2);
    expect(await callsFor(400)).toBe(few);
    // units, context rows, roles, the suggestion's member total, members, counts.
    expect(few).toBe(6);
    const [sql, params] = sqlOf(COUNTS_SQL);
    expect(params[0]).toHaveLength(400);
    expect(sql).toContain('ra."principalId" = ANY($1::uuid[]) AND ra."deletedAt" IS NULL');
    expect(sql).toMatch(/r\."resourceType" NOT IN \('BusinessRole'\)/);
    expect(sql).toContain('GROUP BY d.id');
  });

  it('reads direct members by default, and the subtree when asked', async () => {
    stage({ members: [account('a')] });
    await run();
    expect(sqlOf(MEMBERS_SQL)[0]).toContain('cm."contextId" IN (SELECT unnest($1::uuid[]) AS id)');
    expect(sqlOf(MEMBERS_SQL)[1]).toEqual([[UNIT]]);

    query.mockReset();
    stage({ members: [account('a'), account('c', { contextId: 'sub', unitName: 'Payables' })] });
    const result = await run({ includeSubUnits: 'true' });
    expect(sqlOf(MEMBERS_SQL)[0]).toMatch(/WITH RECURSIVE scope AS[\s\S]*UNION\s+SELECT c\.id FROM "Contexts" c JOIN scope s ON c\."parentContextId" = s\.id/);
    // Rows from several units: the unit is a column again.
    expect(result.constantColumns).toEqual([]);
    expect(result.rows.map(r => r.unit)).toEqual(['Finance accounts', 'Payables']);
  });

  it('caps the rows and says so', async () => {
    stage({ members: Array.from({ length: MAX_ROWS + 1 }, (_, i) => account(`m${i}`)) });
    const result = await run();
    expect(result.rows).toHaveLength(MAX_ROWS);
    expect(result.truncated).toBe(true);
    expect(noticeText(result)).toMatch('shows the first 50,000 members');
  });
});

describe('unit report — a unit of people', () => {
  it('lists the people, counting entitlements across their linked accounts and their own', async () => {
    stage({
      units: [unit({ id: PEOPLE, displayName: 'Finance', targetType: 'Identity' })],
      details: [detailRow({ id: PEOPLE, displayName: 'Finance', targetType: 'Identity' })],
      members: [{ id: 'i1', displayName: 'Grace Hopper', email: 'g@x', accountCount: 3, managerName: 'Ada', extendedAttributes: {}, contextId: PEOPLE, unitName: 'Finance' }],
      counts: [{ id: 'i1', entitlements: 41 }],
    });
    const result = await run({ contexts: PEOPLE });
    expect(keys(result.columns)).toContain('linkedAccounts');
    expect(keys(result.columns)).not.toContain('accountEnabled');
    expect(result.rows[0]).toMatchObject({ displayName: 'Grace Hopper', linkedAccounts: 3, entitlements: 41, _entity: { kind: 'identity', id: 'i1' } });
    const [membersSql] = sqlOf(MEMBERS_SQL);
    expect(membersSql).toContain('JOIN "Identities" m ON m.id = cm."memberId"');
    expect(membersSql).toContain(`cm."memberType" = 'Identity'`);
    const [countSql, countParams] = sqlOf(COUNTS_SQL);
    expect(countSql).toContain('FROM "IdentityMembers" im');
    expect(countSql).toContain('JOIN "ResourceAssignments" ra ON ra."principalId" = im."principalId" AND ra."deletedAt" IS NULL');
    expect(countSql).toContain('ra."identityId" = ANY($1::uuid[])');
    expect(countParams).toEqual([['i1']]);
    expect(noticeText(result)).toMatch(/across every account linked to them/);
  });
});

describe('unit report — what it is given', () => {
  it('asks for a unit when none is named, and reads nothing', async () => {
    const result = await report.run({});
    expect(noticeText(result)).toMatch(/Pick one or more units/);
    expect(query).not.toHaveBeenCalled();
  });

  it('names a unit it could not find', async () => {
    stage({ units: [] });
    const result = await run({ contexts: 'Typo Team' });
    expect(result.rows).toEqual([]);
    expect(noticeText(result)).toMatch(/No unit of accounts or people matches "Typo Team"/);
  });

  it('refuses to mix a unit of accounts with a unit of people, before reading members', async () => {
    stage({ units: [unit(), unit({ id: PEOPLE, displayName: 'Finance', targetType: 'Identity' })] });
    const result = await run({ contexts: `${UNIT},${PEOPLE}` });
    expect(noticeText(result)).toMatch(/Pick units of one kind/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('lists nothing for an empty unit, and counts nothing', async () => {
    stage({ members: [] });
    const result = await run();
    expect(result.rows).toEqual([]);
    expect(sqlOf(COUNTS_SQL)).toBeUndefined();
  });
});

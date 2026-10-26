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
import report, { MAX_ROWS, NOT_LISTED, baseColumns, isTrue, memberStatus } from './unit-members.js';
import { fetchContextDetails } from '../contextDetails.js';
import { CLAIM_COLUMNS, CLAIM_NOTE } from '../unitClaims.js';

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
const CLAIMS_SQL = 'c."contextId" = ANY($1::uuid[])';
const HOLDERS_SQL = 'EXISTS (SELECT 1 FROM "ContextMembers" cm WHERE cm."contextId" = $1';
const CLAIM_KEYS = CLAIM_COLUMNS.map(c => c.key);

// The claim statuses are filtered the way the SQL does: only those asked for come back.
function stage({ units = [unit()], details = [detailRow()], members = [], counts = [], candidates = [], total = 0, claims = [], holders = [] } = {}) {
  query.mockImplementation(async (sql, params) => {
    if (sql.includes(CLAIMS_SQL)) return { rows: claims.filter(c => params[2].includes(c.status)) };
    if (sql.includes(HOLDERS_SQL)) return { rows: holders.filter(h => h.unit === params[0]) };
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
    expect(keys(report.columns)).toEqual([...keys(baseColumns('Principal')), ...CLAIM_KEYS, 'entitlements']);
    // The claim columns carry their own header colour, so the workbook sets them apart.
    expect(report.columns.filter(c => c.headerFill).map(c => c.label)).toEqual(['Org claim — Status', 'Org claim — Role', 'Org claim — Source']);
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
      'accountType', 'accountEnabled', 'system', ...CLAIM_KEYS, 'entitlements', 'member.ext.badge', 'member.ext.costCenter',
    ]);
    // A member a decision marked former stays a row, with its status: the source still lists them.
    expect(result.rows.map(r => r.status)).toEqual(['current', 'marked former (decision)']);
    expect(memberStatus({ markedFormer: false })).toBe('current');
    expect(memberStatus({ markedFormer: false, listed: false })).toBe(NOT_LISTED);
    expect(result.rows[0]).toEqual({
      unit: 'Finance accounts', displayName: 'Account a', status: 'current', email: 'a@example.com', employeeId: 'E-a',
      jobTitle: 'Clerk', department: 'Finance', manager: 'Ada Lovelace', accountType: 'User',
      accountEnabled: true, system: 'Entra', entitlements: 12, 'member.ext.badge': 7, 'member.ext.costCenter': 'FIN-01',
      claimStatus: null, claimRole: null, claimSource: null,
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
    // The same block, with the Org-claim note and counts under its people block.
    const added = ['Org claim columns', 'Current members', 'Former people', 'Claims proposed (not reviewed)'];
    expect(result.details[0].entries.filter(e => !added.includes(e.label))).toEqual(shared.details[0].entries);
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
    // units, context rows, roles, the suggestion's member total, members, the claims, the holders, counts.
    expect(few).toBe(8);
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

describe('unit report — organisational claims', () => {
  // Invented people. b says a role, c came back, d was decided former while the
  // list still lists them, e left and is not listed, f is named but not listed,
  // and Gerrit is a name nobody matched.
  const claim = (id, over) => ({
    id, interviewId: 'iv1', claimKind: 'membership', attribute: null, value: '', status: 'confirmed',
    periodFrom: null, periodTo: null, periodText: null, quote: null, createdAt: '2026-10-01T10:00:00Z',
    subjectName: null, principalId: null, identityId: null, roleSuggestion: null,
    intervieweeName: 'Ilse Interviewer', interviewedAt: '2026-10-01', fileName: 'gesprek.vtt', sourceKind: 'interview',
    contextId: UNIT, accountDeleted: false, ...over,
  });
  const about = (pid, over) => claim(`${pid}-${over.claimKind}-${over.attribute ?? over.value}`, {
    principalId: pid, holderId: pid, subjectDisplayName: `Account ${pid}`, ...over,
  });
  const holder = (pid, over = {}) => ({
    unit: UNIT, id: pid, displayName: `Account ${pid}`, principalId: pid, email: `${pid}@example.com`, jobTitle: 'Analyst',
    principalType: 'User', accountEnabled: true, accountDeleted: false, listed: false, overrideClaimId: null, ...over,
  });
  const DECISION = { overrideClaimId: 'd-membership-former', overrideSource: 'sync', overrideBy: 'analyst@example.test', overrideAt: '2026-10-03' };
  const CLAIMS = [
    about('b', { claimKind: 'role', value: 'Data mining' }),
    about('c', { claimKind: 'membership', attribute: 'rejoined', interviewedAt: '2026-10-02' }),
    about('c', { claimKind: 'roleHistory', value: 'junior analyst', periodFrom: '2019-01-01', periodTo: '2021-01-01' }),
    about('c', { claimKind: 'role', value: 'Analyst', status: 'proposed' }),
    about('d', { claimKind: 'membership', attribute: 'former' }),
    about('e', { claimKind: 'membership', attribute: 'left', sourceKind: 'file', fileName: 'team.xlsx', intervieweeName: null }),
    about('f', { claimKind: 'membership', attribute: 'current', status: 'proposed', sourceKind: 'text', intervieweeName: 'Nora Notetaker' }),
    claim('g-left', { claimKind: 'membership', attribute: 'left', status: 'proposed', subjectName: 'Gerrit Nobody', holderId: null }),
  ];
  const HOLDERS = [
    holder('b', { listed: true }), holder('c', { listed: true }), holder('d', { listed: true, ...DECISION }),
    holder('e'), holder('f'),
  ];
  const MEMBERS = [account('a'), account('b'), account('c'), account('d', { markedFormer: true, ...DECISION })];
  const COUNTS = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => ({ id, entitlements: i + 1 }));
  const cells = r => [r.displayName, r.status, r.claimStatus, r.claimRole, r.claimSource, r.entitlements];
  const stageAll = () => stage({ members: MEMBERS, counts: COUNTS, claims: CLAIMS, holders: HOLDERS });
  const writer = { claimStatuses: ['proposed', 'confirmed', 'edited'] };
  const entry = (result, label) => result.details[0].entries.find(e => e.label === label)?.value;
  const ILSE = 'interview with Ilse Interviewer, 2026-10-01';

  it('gives each person the People overview\'s status, role and source, and adds the people the list does not list', async () => {
    stageAll();
    const result = await report.run({ contexts: UNIT }, writer);
    expect(result.rows.map(cells)).toEqual([
      ['Account a', 'current', null, null, null, 1],
      ['Account b', 'current', 'Current', 'Data mining', ILSE, 2],
      ['Account c', 'current', 'Came back', 'Analyst (proposed) · earlier: Junior analyst', ILSE, 3],
      ['Account d', 'marked former (decision)', 'Left (decided)', null, ILSE, 4],
      // After the members: not confirmed, then left — each with what they still hold.
      ['Account f', NOT_LISTED, 'Not confirmed (proposed)', null, 'notes added by Nora Notetaker, 2026-10-01', 6],
      ['Account e', NOT_LISTED, 'Left', null, 'file team.xlsx, 2026-10-01', 5],
      ['Gerrit Nobody', NOT_LISTED, 'Left (proposed)', null, ILSE, null],
    ]);
    // A matched former person links to their account; a bare name links nowhere.
    const e = result.rows.find(r => r.displayName === 'Account e');
    expect(e).toMatchObject({ unit: 'Finance accounts', email: 'e@example.com', jobTitle: 'Analyst', _entity: { kind: 'user', id: 'e' } });
    expect(result.rows.find(r => r.displayName === 'Gerrit Nobody')._entity).toBeUndefined();
    // The former people's entitlements are counted in the same grouped read as the members'.
    expect(sqlOf(COUNTS_SQL)[1]).toEqual([['a', 'b', 'c', 'd', 'f', 'e']]);
    expect(noticeText(result)).toMatch(/4 member\(s\) listed\./);
    expect(noticeText(result)).toMatch(/3 more person\(s\) follow the members/);
  });

  it('reads the claims of every unit in one statement, and the holders of the picked unit', async () => {
    stageAll();
    await report.run({ contexts: UNIT }, writer);
    const [, claimParams] = sqlOf(CLAIMS_SQL);
    expect(claimParams[0]).toEqual([UNIT]);
    expect(claimParams[2]).toEqual(writer.claimStatuses);
    const holderReads = query.mock.calls.filter(([sql]) => sql.includes(HOLDERS_SQL));
    expect(holderReads).toHaveLength(1);
    expect(holderReads[0][1][0]).toBe(UNIT);
    expect([...holderReads[0][1][1]].sort()).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('adds former people for the picked unit only, while a sub-unit\'s members get their own claims', async () => {
    const SUB = '55555555-5555-5555-5555-555555555555';
    stage({
      members: [account('a'), account('s', { contextId: SUB, unitName: 'Payables' })],
      counts: COUNTS,
      claims: [...CLAIMS, about('s', { claimKind: 'role', value: 'Clerk', contextId: SUB })],
      holders: [...HOLDERS, holder('s', { unit: SUB, listed: true })],
    });
    const result = await report.run({ contexts: UNIT, includeSubUnits: 'true' }, writer);
    expect(sqlOf(CLAIMS_SQL)[1][0]).toEqual([UNIT, SUB]);
    expect(query.mock.calls.filter(([sql]) => sql.includes(HOLDERS_SQL)).map(([, p]) => p[0])).toEqual([UNIT]);
    expect(result.rows.find(r => r.displayName === 'Account s')).toMatchObject({ unit: 'Payables', claimRole: 'Clerk' });
    expect(result.rows.filter(r => r.status === NOT_LISTED).map(r => r.unit)).toEqual(['Finance accounts', 'Finance accounts', 'Finance accounts']);
  });

  it('opens with the note and the counts under the people block', async () => {
    stageAll();
    const result = await report.run({ contexts: UNIT }, writer);
    const labels = result.details[0].entries.map(e => e.label);
    expect(labels.slice(0, 6)).toEqual(['Accountable', 'Responsible', 'Org claim columns', 'Current members', 'Former people', 'Claims proposed (not reviewed)']);
    expect(entry(result, 'Org claim columns')).toBe(CLAIM_NOTE);
    expect(CLAIM_NOTE).toMatch(/not from a connected system\. '\(proposed\)' means not reviewed yet\./);
    // Current: a, b, c listed (d is decided former) and f not confirmed. Former: d (decided), e and Gerrit.
    expect(entry(result, 'Current members')).toBe(4);
    expect(entry(result, 'Former people')).toBe(3);
    // Proposed: c's role, f's membership and Gerrit's.
    expect(entry(result, 'Claims proposed (not reviewed)')).toBe(3);
  });

  it('shows a reader — a context owner too — confirmed claims only, and no proposed count', async () => {
    for (const ctx of [{ claimStatuses: ['confirmed', 'edited'] }, undefined]) {
      query.mockReset();
      stageAll();
      const result = await report.run({ contexts: UNIT }, ctx);
      expect(sqlOf(CLAIMS_SQL)[1][2]).toEqual(['confirmed', 'edited']);
      expect(result.rows.map(cells)).toEqual([
        ['Account a', 'current', null, null, null, 1],
        ['Account b', 'current', 'Current', 'Data mining', ILSE, 2],
        // The proposed "Analyst" is not shown: the latest confirmed role is the earlier one.
        ['Account c', 'current', 'Came back', 'junior analyst', ILSE, 3],
        ['Account d', 'marked former (decision)', 'Left (decided)', null, ILSE, 4],
        ['Account e', NOT_LISTED, 'Left', null, 'file team.xlsx, 2026-10-01', 5],
      ]);
      expect(entry(result, 'Claims proposed (not reviewed)')).toBeUndefined();
      expect(entry(result, 'Former people')).toBe(2);
    }
  });

  it('keeps the number of reads fixed however many people the sources name', async () => {
    const reads = async (n) => {
      query.mockReset();
      queryOne.mockReset();
      const many = Array.from({ length: n }, (_, i) => about(`x${i}`, { claimKind: 'membership', attribute: 'left' }));
      stage({ members: MEMBERS, counts: COUNTS, claims: many, holders: many.map(c => holder(c.principalId)) });
      const result = await report.run({ contexts: UNIT }, writer);
      expect(result.rows).toHaveLength(MEMBERS.length + n);
      return query.mock.calls.length + queryOne.mock.calls.length;
    };
    expect(await reads(300)).toBe(await reads(2));
  });
});

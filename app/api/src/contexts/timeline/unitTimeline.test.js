import { describe, it, expect, vi } from 'vitest';
import {
  loadUnitTimeline, idsNamed, nameBook, splitByTable, leavers, untoldJoins,
  UNIT_HISTORY_SQL, EARLIER_MEMBERS_SQL, PROVENANCE_SQL, PEOPLE_ACCOUNTS_SQL, PEOPLE_CHANGES_SQL, NAMES_SQL, UNIT_TIMELINE_ROW_CAP,
} from './unitTimeline.js';

const UNIT = '00000000-0000-4000-8000-000000000001';
const LISA = '00000000-0000-4000-8000-0000000000a1';
const MAX = '00000000-0000-4000-8000-0000000000a2';
const SOPHIE = '00000000-0000-4000-8000-0000000000a3';
const TOM = '00000000-0000-4000-8000-0000000000a4';
const EVA = '00000000-0000-4000-8000-0000000000a5';

describe('splitByTable / leavers', () => {
  it('splits the rows per table, oldest first, ignoring tables it does not read', () => {
    const out = splitByTable([
      { tableName: 'ContextMembers', changedAt: '2' }, { tableName: 'Other', changedAt: '1' }, { tableName: 'ContextMembers', changedAt: '1' },
    ]);
    expect(out.ContextMembers.map(r => r.changedAt)).toEqual(['1', '2']);
    expect(Object.keys(out)).toEqual(['ContextMembers', 'Contexts', 'ContextRoles', 'ChangeRequests', 'ContextTreeAdjustments']);
  });

  it('who left: the accounts and persons a delete took away', () => {
    expect(leavers([
      { operation: 'D', rowData: { memberType: 'Principal', memberId: MAX } },
      { operation: 'D', rowData: { memberType: 'Identity', memberId: LISA } },
      { operation: 'D', rowData: { memberType: 'Resource', memberId: 'r' } },
      { operation: 'I', rowData: { memberType: 'Principal', memberId: TOM } },
    ])).toEqual({ principals: [MAX], identities: [LISA] });
  });
});

describe('untoldJoins', () => {
  it('drops an earlier join the membership history already tells, keeps the rest', () => {
    const earlier = [{ memberId: LISA }, { memberId: TOM }];
    expect(untoldJoins(earlier, [
      { operation: 'I', rowData: { memberId: LISA } },
      { operation: 'D', rowData: { memberId: TOM } },
    ])).toEqual([{ memberId: TOM }]);
  });
});

describe('idsNamed / nameBook', () => {
  it('collects every uuid the rows name, once, and nothing that is not one', () => {
    const ids = idsNamed({
      ContextMembers: [{ rowData: { memberId: LISA } }],
      ContextRoles: [{ rowData: { principalId: MAX }, prevData: { identityId: TOM } }],
      Contexts: [{ rowData: { parentContextId: 'not-a-uuid' }, prevData: {} }],
      ChangeRequests: [],
      ContextTreeAdjustments: [{ rowData: { memberId: LISA, payload: { toUnitId: UNIT } } }],
    }, [{ rowData: { managerId: SOPHIE }, prevData: { managerId: null } }], [{ memberId: EVA }]);
    expect(ids.sort()).toEqual([UNIT, LISA, MAX, SOPHIE, TOM, EVA].sort());
  });

  it('looks a name up by kind, falls back across kinds, and gives null for an unknown id', () => {
    const book = nameBook([{ kind: 'Principal', id: MAX, displayName: 'Max' }, { kind: 'Identity', id: LISA, displayName: 'Lisa' }, { kind: 'Context', id: UNIT, displayName: 'Unit' }]);
    expect(book.member('Identity', MAX)).toBe('Max');
    expect(book.holder({ principalId: MAX })).toBe('Max');
    expect(book.holder({ identityId: LISA })).toBe('Lisa');
    expect(book.context(UNIT)).toBe('Unit');
    expect(book.context(LISA)).toBeNull();
    expect(book.any(TOM)).toBeNull();
    expect(book.any(null)).toBeNull();
  });
});

function fakeDb(rows) {
  return { query: vi.fn(async (sql) => ({ rows: rows.get(sql) ?? [] })) };
}

describe('loadUnitTimeline', () => {
  const history = [
    { tableName: 'ContextMembers', operation: 'D', changedAt: '2026-10-27T12:00:00Z', rowData: { memberType: 'Principal', memberId: MAX, addedBy: 'sync' } },
    { tableName: 'ContextRoles', operation: 'I', changedAt: '2026-10-27T11:00:00Z', rowData: { contextId: UNIT, role: 'Responsible', identityId: LISA, addedBy: 'analyst' } },
    { tableName: 'ContextMembers', operation: 'I', changedAt: '2026-10-27T10:00:00Z', rowData: { memberType: 'Identity', memberId: LISA, addedBy: 'sync' } },
  ];
  const sophieChange = { operation: 'U', changedAt: '2026-10-26T09:00:00Z', prevData: { id: SOPHIE, displayName: 'Sophie Willems', jobTitle: 'Handler' }, rowData: { id: SOPHIE, displayName: 'Sophie Willems', jobTitle: 'Team lead' } };

  it('puts people, roles, the members\' own changes, earlier joins and the interview events in one stream, newest first', async () => {
    const db = fakeDb(new Map([
      [UNIT_HISTORY_SQL, history],
      [EARLIER_MEMBERS_SQL, [{ memberType: 'Identity', memberId: TOM, addedBy: 'sync', addedAt: '2026-10-20T08:00:00Z' }]],
      [PROVENANCE_SQL, [{ systemType: 'Upload', systemName: 'Teams.xlsx' }]],
      [PEOPLE_ACCOUNTS_SQL, [{ id: SOPHIE }]],
      [PEOPLE_CHANGES_SQL, [sophieChange]],
      [NAMES_SQL, [{ kind: 'Principal', id: MAX, displayName: 'Max Jacobs' }, { kind: 'Identity', id: LISA, displayName: 'Lisa Vos' }, { kind: 'Identity', id: TOM, displayName: 'Tom Bakker' }]],
    ]));
    const interviewEvents = vi.fn(async () => [{ at: '2026-10-27T13:00:00Z', operation: 'added', eventKind: 'interview', summary: 'Interview with Anna uploaded (a.txt)' }]);

    const { events, truncated } = await loadUnitTimeline(db, UNIT, { sinceDays: 30, interviewEvents });

    expect(events.map(e => [e.category, e.summary])).toEqual([
      ['knowledge', 'Interview with Anna uploaded (a.txt)'],
      ['people', 'Max Jacobs left (list upload: Teams.xlsx)'],
      ['roles', 'Responsible added: Lisa Vos (analyst)'],
      ['people', 'Lisa Vos joined (list upload: Teams.xlsx)'],
      ['people', 'Sophie Willems\' job title changed: Handler → Team lead'],
      ['people', 'Tom Bakker joined (list upload: Teams.xlsx)'],
    ]);
    expect(truncated).toBe(false);
    const call = (sql) => db.query.mock.calls.find(c => c[0] === sql)[1];
    expect(call(UNIT_HISTORY_SQL)).toEqual([30, UNIT, UNIT_TIMELINE_ROW_CAP]);
    // Whoever left in the window is still one of the people whose changes count.
    expect(call(PEOPLE_ACCOUNTS_SQL)).toEqual([UNIT, [MAX], []]);
    expect(call(PEOPLE_CHANGES_SQL)).toEqual([30, [SOPHIE], UNIT_TIMELINE_ROW_CAP]);
  });

  it('reads no account history without people, no names without ids, and says when a read hit the cap', async () => {
    const full = Array.from({ length: UNIT_TIMELINE_ROW_CAP }, () => ({ tableName: 'Other', operation: 'I', changedAt: 't', rowData: {} }));
    const db = fakeDb(new Map([[UNIT_HISTORY_SQL, full]]));
    const { events, truncated } = await loadUnitTimeline(db, UNIT, { sinceDays: 7 });
    expect(events).toEqual([]);
    expect(truncated).toBe(true);
    const sqls = db.query.mock.calls.map(c => c[0]);
    expect(sqls).not.toContain(PEOPLE_CHANGES_SQL);
    expect(sqls).not.toContain(NAMES_SQL);
  });
});

describe('the SQL', () => {
  it('reads memberships and the unit row by its id (the index), roles and requests by the context they name', () => {
    expect(UNIT_HISTORY_SQL).toMatch(/"tableName" = 'ContextMembers' AND "rowId" = \$2/);
    expect(UNIT_HISTORY_SQL).toMatch(/"tableName" = 'Contexts' AND "rowId" = \$2/);
    expect(UNIT_HISTORY_SQL).toMatch(/"tableName" = 'ContextRoles' AND "rowData"->>'contextId' = \$2/);
    expect(UNIT_HISTORY_SQL).toContain("'lastCalculatedAt'");
  });

  it('takes earlier joins only from before the membership history, and never a rule\'s', () => {
    expect(EARLIER_MEMBERS_SQL).toMatch(/"addedBy" <> 'algorithm'/);
    expect(EARLIER_MEMBERS_SQL).toMatch(/cm\."addedAt" < COALESCE\(\(SELECT min\(h\."changedAt"\)/);
  });
});

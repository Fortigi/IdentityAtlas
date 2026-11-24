import { describe, it, expect, vi } from 'vitest';
import {
  teamGrid, membershipChanges, roleChanges, latestChanges, loadTeamOverview,
  TEAM_ACCOUNTS_SQL, TEAM_HOLDINGS_SQL, ROLE_HISTORY_CAP, MAX_CHANGES, roleHistorySql, loadTeamGrid,
} from './teamOverview.js';
import { ROLE_CONTROL_SQL } from '../lib/businessRoleAccessModel.js';
import { UNIT_MEMBERSHIP_SQL, UNIT_HISTORY_SQL, NAMES_SQL, UNIT_TIMELINE_ROW_CAP } from './timeline/unitTimeline.js';

const GONE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ANN = { id: 'a', displayName: 'Ann', memberType: 'Principal' };
const BOB = { id: 'b', displayName: 'Bob', memberType: 'Identity' };
const FINANCE = { id: 'r1', displayName: 'Finance', origin: 'Automatic', originDetail: 'AutoAssign' };
const AUDIT = { id: 'r2', displayName: 'Audit' };

describe('teamGrid', () => {
  it('keeps someone without holdings as a column with zero counts', () => {
    const { people, roles } = teamGrid([ANN, BOB], [{ memberId: 'a', permissions: 7, ungoverned: 2, roles: [FINANCE] }]);
    expect(people).toEqual([
      { id: 'a', displayName: 'Ann', kind: 'user', permissions: 7, ungoverned: 2 },
      { id: 'b', displayName: 'Bob', kind: 'identity', permissions: 0, ungoverned: 0 },
    ]);
    expect(roles).toEqual([{ id: 'r1', displayName: 'Finance', control: 'Unknown', holders: ['a'], origins: { a: { origin: 'Automatic', originDetail: 'AutoAssign', control: 'Unknown' } } }]);
  });

  it('keeps how each person got the same role, and says null when the source does not', () => {
    const { roles } = teamGrid([ANN, BOB], [
      { memberId: 'a', permissions: 1, ungoverned: 0, roles: [FINANCE] },
      { memberId: 'b', permissions: 1, ungoverned: 0, roles: [{ id: 'r1', displayName: 'Finance' }] },
    ]);
    expect(roles[0].origins).toEqual({
      a: { origin: 'Automatic', originDetail: 'AutoAssign', control: 'Unknown' },
      b: { origin: null, originDetail: null, control: 'Unknown' },
    });
  });

  it('gives each role its primary type and each holder theirs', () => {
    const { roles } = teamGrid([ANN, BOB], [
      { memberId: 'a', permissions: 1, ungoverned: 0, roles: [{ ...FINANCE, linked: 'Automatic' }] },
      { memberId: 'b', permissions: 1, ungoverned: 0, roles: [{ id: 'r1', displayName: 'Finance', linked: null, origin: 'Requested' }] },
    ], new Map([['r1', 'Manual']]));
    expect(roles[0].control).toBe('Manual');
    expect(roles[0].origins.a.control).toBe('Automatic');
    expect(roles[0].origins.b.control).toBe('Manual');
  });

  it('orders roles by how many hold them, then by name', () => {
    const { roles } = teamGrid([ANN, BOB], [
      { memberId: 'a', permissions: 1, ungoverned: 0, roles: [{ id: 'z', displayName: 'Zed' }, AUDIT, FINANCE] },
      { memberId: 'b', permissions: 1, ungoverned: 0, roles: [FINANCE] },
    ]);
    expect(roles.map(r => [r.displayName, r.holders])).toEqual([
      ['Finance', ['a', 'b']], ['Audit', ['a']], ['Zed', ['a']],
    ]);
  });
});

describe('loadTeamGrid', () => {
  it('reads the primary type of exactly the roles the team holds', async () => {
    const db = { query: vi.fn(async (sql) => {
      if (sql === TEAM_ACCOUNTS_SQL) return { rows: [{ memberId: 'a', accountId: 'a', identityId: null }] };
      if (sql === TEAM_HOLDINGS_SQL) return { rows: [{ memberId: 'a', permissions: 1, ungoverned: 0, roles: [FINANCE, AUDIT] }] };
      if (sql === ROLE_CONTROL_SQL) return { rows: [{ resourceId: 'r1', policyCount: 1, inRule: true, outRule: true }] };
      return { rows: [] };
    }) };
    const { roles } = await loadTeamGrid(db, [ANN]);
    expect(db.query.mock.calls.find(([s]) => s === ROLE_CONTROL_SQL)[1]).toEqual([['r1', 'r2']]);
    expect(Object.fromEntries(roles.map(r => [r.id, r.control]))).toEqual({ r1: 'Automatic', r2: 'Unknown' });
  });

  it('asks nothing more for a team without roles', async () => {
    const db = { query: vi.fn(async (sql) => (sql === TEAM_ACCOUNTS_SQL ? { rows: [{ memberId: 'a', accountId: 'a' }] } : { rows: [] })) };
    await loadTeamGrid(db, [ANN]);
    expect(db.query.mock.calls.some(([s]) => s === ROLE_CONTROL_SQL)).toBe(false);
  });
});

describe('membershipChanges', () => {
  it('keeps joins and leaves and drops every other people event', () => {
    const joined = { at: 't1', operation: 'added', counterpartyKind: 'user', counterpartyId: 'a', counterpartyLabel: 'Ann', burst: { key: 'people:joined:rule' } };
    const left = { at: 't2', operation: 'removed', counterpartyKind: 'identity', counterpartyId: 'b', counterpartyLabel: 'Bob', burst: { key: 'people:left:' } };
    const title = { at: 't3', operation: 'changed', category: 'people', summary: 'job title' };
    const removedResource = { at: 't4', operation: 'removed', burst: { key: 'people:removed:' } };
    expect(membershipChanges([joined, left, title, removedResource])).toEqual([
      { at: 't1', type: 'joined', personKind: 'user', personId: 'a', personName: 'Ann' },
      { at: 't2', type: 'left', personKind: 'identity', personId: 'b', personName: 'Bob' },
    ]);
  });
});

describe('roleChanges', () => {
  const person = { id: 'a', kind: 'user', displayName: 'Ann' };
  const holder = (row) => (row.rowData?.principalId === 'acct' ? person : null);
  const at = '2026-11-05T10:00:00Z';

  it('reads a soft delete as a removal and a restore as an addition', () => {
    const removed = { operation: 'U', changedAt: at, roleName: 'Finance', prevData: { deletedAt: null }, rowData: { principalId: 'acct', resourceId: 'r1', deletedAt: at } };
    const restored = { operation: 'U', changedAt: '2026-11-06T10:00:00Z', roleName: 'Finance', prevData: { deletedAt: at }, rowData: { principalId: 'acct', resourceId: 'r1', deletedAt: null } };
    expect(roleChanges([removed, restored], holder).map(c => c.type)).toEqual(['role-removed', 'role-added']);
  });

  it('ignores an update that did not change the assignment, and rows of nobody on the team', () => {
    const backfill = { operation: 'U', changedAt: at, roleName: 'Finance', prevData: {}, rowData: { principalId: 'acct', resourceId: 'r1' } };
    const stranger = { operation: 'I', changedAt: at, roleName: 'Finance', rowData: { principalId: 'other', resourceId: 'r1' } };
    expect(roleChanges([backfill, stranger], holder)).toEqual([]);
  });

  it('counts one person changing the same role at the same moment once, but not two different roles', () => {
    const row = (resourceId, roleName) => ({ operation: 'I', changedAt: at, roleName, rowData: { principalId: 'acct', resourceId } });
    const out = roleChanges([row('r1', 'Finance'), row('r1', 'Finance'), row('r2', 'Audit')], holder);
    expect(out.map(c => c.roleName)).toEqual(['Finance', 'Audit']);
    expect(out[0]).toEqual({ at, type: 'role-added', personKind: 'user', personId: 'a', personName: 'Ann', roleName: 'Finance' });
  });
});

describe('latestChanges', () => {
  it('sorts newest first and applies the cap', () => {
    const changes = ['2026-01-01', '2026-03-01', '2026-02-01'].map(at => ({ at }));
    expect(latestChanges(changes, 2).map(c => c.at)).toEqual(['2026-03-01', '2026-02-01']);
  });
});

describe('the SQL', () => {
  it('reads only the requested history column', () => {
    expect(roleHistorySql('identityId')).toContain(`h."rowData"->>'identityId' = ANY`);
    expect(roleHistorySql('identityId')).not.toContain(`'principalId'`);
  });

  it('counts coverage from the shared governance view', () => {
    expect(TEAM_HOLDINGS_SQL).toContain('"vw_UserPermissionAssignmentViaBusinessRole"');
  });
});

describe('loadTeamOverview', () => {
  const ctx = { id: 'ctx', targetType: 'Principal' };

  function fakeDb({ accounts = [], holdings = [], accountHistory = [], identityHistory = [] } = {}) {
    return {
      query: vi.fn(async (sql, params) => {
        if (sql === TEAM_ACCOUNTS_SQL) return { rows: accounts };
        if (sql === TEAM_HOLDINGS_SQL) return { rows: holdings };
        if (sql === roleHistorySql('principalId')) return { rows: accountHistory, params };
        if (sql === roleHistorySql('identityId')) return { rows: identityHistory, params };
        return { rows: [] };
      }),
    };
  }

  it('answers an empty team without reading holdings or history', async () => {
    const db = fakeDb();
    const loadMembers = vi.fn(async () => ({ rows: [], total: 0 }));
    const out = await loadTeamOverview({ db, loadMembers }, ctx, { sinceDays: 30 });
    expect(out).toEqual({ sinceDays: 30, people: [], roles: [], changes: [], totalPeople: 0, truncated: false });
    expect(db.query.mock.calls.some(([sql]) => sql === TEAM_HOLDINGS_SQL)).toBe(false);
  });

  it('joins holdings to members, attributes a person-level role change, and passes the override choice on', async () => {
    const db = fakeDb({
      accounts: [{ memberId: 'a', accountId: 'acct', identityId: 'ident' }],
      holdings: [{ memberId: 'a', permissions: 5, ungoverned: 3, roles: [FINANCE] }],
      identityHistory: [{ operation: 'I', changedAt: '2026-11-05T10:00:00Z', roleName: 'Finance', rowData: { identityId: 'ident', resourceId: 'r1' } }],
    });
    const loadMembers = vi.fn(async () => ({ rows: [{ id: 'a', displayName: 'Ann' }], total: 1 }));
    const out = await loadTeamOverview({ db, loadMembers }, ctx, { sinceDays: 14, includeOverridden: true });
    expect(loadMembers.mock.calls[0][2]).toMatchObject({ includeOverridden: true, withTotal: true });
    expect(out.people[0]).toMatchObject({ id: 'a', ungoverned: 3, permissions: 5 });
    expect(out.changes).toEqual([{ at: '2026-11-05T10:00:00Z', type: 'role-added', personKind: 'user', personId: 'a', personName: 'Ann', roleName: 'Finance' }]);
    expect(out.truncated).toBe(false);
  });

  it('reports who joined and left from the membership history alone', async () => {
    const db = fakeDb({ accounts: [{ memberId: 'a', accountId: 'a', identityId: null }] });
    const inner = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (sql === UNIT_MEMBERSHIP_SQL) {
        return { rows: [
          { tableName: 'ContextMembers', operation: 'D', changedAt: '2026-11-06T10:00:00Z', rowData: { memberType: 'Principal', memberId: GONE, addedBy: 'algorithm' } },
          { tableName: 'ContextMembers', operation: 'I', changedAt: '2026-11-05T10:00:00Z', rowData: { memberType: 'Principal', memberId: NEW, addedBy: 'algorithm' } },
        ] };
      }
      if (sql === NAMES_SQL) return { rows: [{ kind: 'Principal', id: GONE, displayName: 'Gus Gone' }, { kind: 'Principal', id: NEW, displayName: 'Nia New' }] };
      return inner(sql, params);
    });
    const loadMembers = vi.fn(async () => ({ rows: [{ id: 'a', displayName: 'Ann' }], total: 1 }));
    const out = await loadTeamOverview({ db, loadMembers }, ctx, { sinceDays: 30 });
    expect(out.changes.map(c => [c.type, c.personName])).toEqual([['left', 'Gus Gone'], ['joined', 'Nia New']]);
    expect(db.query.mock.calls.some(([sql]) => sql === UNIT_HISTORY_SQL)).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it('says it is partial when the membership history hit its cap', async () => {
    const db = fakeDb();
    const inner = db.query.getMockImplementation();
    const full = Array.from({ length: UNIT_TIMELINE_ROW_CAP }, () => ({ tableName: 'ContextMembers', operation: 'I', changedAt: '2026-11-05T10:00:00Z', rowData: { memberType: 'Principal', memberId: NEW } }));
    db.query.mockImplementation(async (sql, params) => (sql === UNIT_MEMBERSHIP_SQL ? { rows: full } : inner(sql, params)));
    const loadMembers = vi.fn(async () => ({ rows: [], total: 0 }));
    expect((await loadTeamOverview({ db, loadMembers }, ctx, { sinceDays: 30 })).truncated).toBe(true);
  });

  it('says it is partial when the team is larger than the page', async () => {
    const db = fakeDb({ accounts: [{ memberId: 'a', accountId: 'acct', identityId: null }] });
    const loadMembers = vi.fn(async () => ({ rows: [{ id: 'a', displayName: 'Ann' }], total: 250 }));
    const out = await loadTeamOverview({ db, loadMembers }, ctx, { sinceDays: 30 });
    expect(out.totalPeople).toBe(250);
    expect(out.truncated).toBe(true);
  });

  it('says it is partial when the role history hit its cap, and caps the changes', async () => {
    const accountHistory = Array.from({ length: ROLE_HISTORY_CAP }, (_, i) => ({
      operation: 'I', changedAt: new Date(1e12 + i * 1000).toISOString(), roleName: 'Finance', rowData: { principalId: 'acct', resourceId: 'r1' },
    }));
    const db = fakeDb({ accounts: [{ memberId: 'a', accountId: 'acct', identityId: null }], accountHistory });
    const loadMembers = vi.fn(async () => ({ rows: [{ id: 'a', displayName: 'Ann' }], total: 1 }));
    const out = await loadTeamOverview({ db, loadMembers }, ctx, { sinceDays: 30 });
    expect(out.changes).toHaveLength(MAX_CHANGES);
    expect(out.truncated).toBe(true);
  });
});

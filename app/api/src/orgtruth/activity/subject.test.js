import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { getSubjectActivity, shapeSubject, chooseType, typesByRows, actorTotals } from './subject.js';

const C = 'c0000000-0000-4000-8000-000000000001';
const R = 'r0000000-0000-4000-8000-000000000001';

// roll-up rows (byMonth) for one subject
const row = (o) => ({ activityType: 'Uren', unit: 'h', actorType: 'Principal', actorId: 'a1', month: '2026-03', rowCount: 1, total: 1, firstOn: '2026-03-01', lastOn: '2026-03-01', ...o });

describe('typesByRows / chooseType', () => {
  const rows = [row({ activityType: 'Calls', rowCount: 2 }), row({ activityType: 'Uren', rowCount: 1 }), row({ activityType: 'Uren', rowCount: 2 }), row({ activityType: 'Audit', rowCount: 3 })];

  it('orders by rows, then name on a tie', () => {
    expect(typesByRows(rows)).toEqual(['Audit', 'Uren', 'Calls']);
  });

  it('takes the requested type when present, else the one with most rows', () => {
    expect(chooseType(rows, 'Calls').type).toBe('Calls');
    expect(chooseType(rows, 'Nope').type).toBe('Audit');
    expect(chooseType([], null)).toEqual({ types: [], type: null });
  });
});

describe('actorTotals', () => {
  it('per resolved actor over all months; unresolved rows are nobody', () => {
    expect(actorTotals([
      row({ month: '2026-03', total: 2, lastOn: '2026-03-01' }), row({ month: '2026-05', total: 3, lastOn: '2026-05-01' }),
      row({ actorType: null, actorId: null, total: 9 }),
    ])).toEqual([{ targetType: 'Principal', targetId: 'a1', total: 5, lastOn: '2026-05-01' }]);
  });
});

describe('shapeSubject', () => {
  const rows = [
    row({ actorType: 'Identity', actorId: 'iA', month: '2026-03', total: 8, firstOn: '2026-03-01', lastOn: '2026-03-01' }),
    row({ actorType: 'Identity', actorId: 'iA', month: '2026-09', total: 4.004, firstOn: '2026-09-01', lastOn: '2026-09-01' }),
    row({ actorId: 'b1', month: '2026-08', total: 5, firstOn: '2026-08-01', lastOn: '2026-08-01', unit: null }),
    row({ actorType: null, actorId: null, month: '2026-07', rowCount: 3, total: 2, firstOn: '2026-07-01', lastOn: '2026-07-01' }),
    row({ activityType: 'Calls', actorId: 'b1', month: '2025-01', total: 99, firstOn: '2025-01-01', lastOn: '2025-01-01' }),
  ];
  const labels = new Map([['Identity:iA', { label: 'Ann Example' }], ['Principal:b1', { label: 'Bob Example' }]]);
  const rolesOf = (t, id) => (t === 'Identity' && id === 'iA' ? ['eigenaar'] : []);
  const out = shapeSubject({ rows, requestedType: null, rolesOf, labels });

  it('the type with most rows, its totals and span, months ascending', () => {
    expect(out).toMatchObject({ type: 'Uren', types: ['Uren', 'Calls'], unit: 'h', total: 19, firstOn: '2026-03-01', lastOn: '2026-09-01', unresolvedRows: 3 });
    expect(out.months).toEqual([
      { month: '2026-03', total: 8 }, { month: '2026-07', total: 2 }, { month: '2026-08', total: 5 }, { month: '2026-09', total: 4 },
    ]);
  });

  it('actors most first, with membership and roles', () => {
    expect(out.actors).toEqual([
      { targetType: 'Identity', targetId: 'iA', label: 'Ann Example', total: 12, lastOn: '2026-09-01', isMember: true, memberRoles: ['eigenaar'] },
      { targetType: 'Principal', targetId: 'b1', label: 'Bob Example', total: 5, lastOn: '2026-08-01', isMember: false, memberRoles: [] },
    ]);
  });

  it('another type on request; nothing at all is empty, not an error', () => {
    const calls = shapeSubject({ rows, requestedType: 'Calls', rolesOf, labels });
    expect(calls).toMatchObject({ type: 'Calls', total: 99, unresolvedRows: 0 });
    expect(shapeSubject({ rows: [], requestedType: null, rolesOf, labels })).toEqual({
      type: null, types: [], unit: null, total: 0, firstOn: null, lastOn: null, months: [], actors: [], unresolvedRows: 0,
    });
  });
});

describe('getSubjectActivity', () => {
  beforeEach(() => query.mockReset());

  it('a collection entity: its member links decide membership, also through the actor\'s identity', async () => {
    query.mockImplementation(async (raw) => {
      const sql = String(raw);
      if (sql.includes('FROM "OrgActivities" a')) return { rows: [row({ actorId: 'a2' })] };
      if (sql.includes('FROM "OrgLinks"')) return { rows: [{ via: 'team', targetType: 'Principal', targetId: 'a1' }] };
      if (sql.includes('"IdentityMembers"')) return { rows: [{ principalId: 'a1', identityId: 'iA' }, { principalId: 'a2', identityId: 'iA' }] };
      return { rows: [{ id: 'a2', label: 'Ann Example (second account)' }] };
    });
    const out = await getSubjectActivity('OrgEntity', C);
    const act = query.mock.calls.find(([s]) => s.includes('FROM "OrgActivities" a'));
    expect(act[0]).toMatch(/sk\."targetType" = \$1 AND sk\."targetId" = \$2/);
    expect(act[1]).toEqual(['OrgEntity', C]);
    expect(query.mock.calls.find(([s]) => s.includes('FROM "OrgLinks"'))[1]).toEqual([C]);
    expect(out.actors[0]).toMatchObject({ targetId: 'a2', label: 'Ann Example (second account)', isMember: true, memberRoles: ['team'] });
  });

  it('a resource: the actors\' assignments to it are the membership, the assignment type the role', async () => {
    query.mockImplementation(async (raw) => {
      const sql = String(raw);
      if (sql.includes('FROM "OrgActivities" a')) return { rows: [row({ actorType: 'Identity', actorId: 'iA' })] };
      if (sql.includes('"ResourceAssignments"')) return { rows: [{ via: 'Direct', targetType: 'Principal', targetId: 'a1' }] };
      if (sql.includes('FROM "IdentityMembers" WHERE "principalId" = ANY')) return { rows: [{ principalId: 'a1', identityId: 'iA' }] };
      return { rows: [] };
    });
    const out = await getSubjectActivity('Resource', R, { type: 'Uren' });
    const ra = query.mock.calls.find(([s]) => s.includes('"ResourceAssignments"'));
    expect(ra[1]).toEqual([R, ['iA']]);
    expect(out.actors[0]).toMatchObject({ isMember: true, memberRoles: ['Direct'], label: null });
  });

  it('a resource nobody worked on reads no assignments', async () => {
    query.mockResolvedValue({ rows: [] });
    const out = await getSubjectActivity('Resource', R);
    expect(query).toHaveBeenCalledTimes(1);
    expect(out.type).toBeNull();
  });
});

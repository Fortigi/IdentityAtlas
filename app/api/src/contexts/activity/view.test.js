import { describe, it, expect, vi } from 'vitest';
import { contextActivity, activitySummary, requestedPeriod, requestedSubUnits } from './view.js';

const UNIT = { id: 'C', displayName: 'Northwind Traders', targetType: 'Identity', contextCategory: 'OrganizationalUnit', parentContextId: 'R' };
const ROOT = { id: 'R', displayName: 'Customers', targetType: 'Identity', contextCategory: 'OrganizationalUnit', parentContextId: null };

// Answers by the query; records the period each aggregate read was asked for.
function fakeDb({ context = UNIT, latest = '2026-04-18', below = [], aggregates = [], members = [] } = {}) {
  const asked = [];
  const db = {
    queryOne: vi.fn(async (sql) => {
      if (sql.includes('FROM "Contexts" WHERE id = $1')) return context;
      if (sql.includes('max("activityDate")')) return { latest };
      throw new Error(`unexpected queryOne: ${sql}`);
    }),
    query: vi.fn(async (sql, p) => {
      if (sql.includes('WITH RECURSIVE below')) return { rows: below };
      if (sql.includes('GROUP BY')) { asked.push({ ids: p[0], from: p[1], to: p[2] }); return { rows: aggregates }; }
      if (sql.includes('FROM "ContextMembers"')) return { rows: members };
      if (sql.includes('"displayName" FROM "Identities"')) return { rows: [{ id: 'I1', displayName: 'Vera Example' }] };
      if (sql.includes('"displayName" FROM "Principals"')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
  return { db, asked };
}

const agg = (over) => ({ contextId: 'C', principalId: 'P1', identityId: 'I1', subjectEmail: null, subjectName: 'Vera', month: '2026-04', unit: 'hours', amount: 2, rows: 1, firstDate: '2026-04-02', lastDate: '2026-04-02', ...over });

describe('requestedPeriod', () => {
  it('is null when nothing is asked, else both valid dates in order', () => {
    expect(requestedPeriod({})).toBeNull();
    expect(requestedPeriod({ from: '2026-01-01', to: '2026-03-31' })).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(requestedPeriod({ from: '2026-01-01', to: '2026-01-01' })).toEqual({ from: '2026-01-01', to: '2026-01-01' });
  });

  it('refuses one end only, a malformed date, a reversed or an over-long period', () => {
    for (const q of [{ from: '2026-01-01' }, { from: '2026-1-1', to: '2026-02-01' }, { from: '2026-13-45', to: '2026-12-31' }, { from: '2026-03-01', to: '2026-02-28' }, { from: '2010-01-01', to: '2026-01-01' }]) {
      expect(() => requestedPeriod(q), JSON.stringify(q)).toThrow(expect.objectContaining({ status: 400 }));
    }
    expect(requestedPeriod({ from: '2016-02-01', to: '2026-01-31' })).not.toBeNull();
  });
});

describe('contextActivity', () => {
  it('defaults to the twelve months up to the latest activity and groups the people', async () => {
    const { db, asked } = fakeDb({ aggregates: [agg()], members: [{ contextId: 'C', memberId: 'I1', memberType: 'Identity', displayName: 'Vera Example' }] });
    const v = await contextActivity(db, 'C');
    expect(asked).toEqual([{ ids: ['C'], from: '2025-05-01', to: '2026-04-18' }]);
    expect(v.period).toEqual({ from: '2025-05-01', to: '2026-04-18' });
    expect(v.months).toHaveLength(12);
    expect(v.groups[0]).toMatchObject({ key: 'memberAndActive', people: [expect.objectContaining({ displayName: 'Vera Example', amount: 2 })] });
  });

  it('reads exactly the period asked for', async () => {
    const { db, asked } = fakeDb();
    const v = await contextActivity(db, 'C', { from: '2026-02-01', to: '2026-03-31' });
    expect(asked[0]).toMatchObject({ from: '2026-02-01', to: '2026-03-31' });
    expect(v.months).toEqual(['2026-02', '2026-03']);
    expect(db.queryOne.mock.calls.some(c => c[0].includes('max('))).toBe(false);
  });

  it('without any activity says so and reads nothing more', async () => {
    const { db, asked } = fakeDb({ latest: null });
    expect(await contextActivity(db, 'C')).toEqual({ contextId: 'C', targetType: 'Identity', includeSubUnits: false, period: null, months: [], groups: [] });
    expect(asked).toEqual([]);
  });

  it('an unknown context is a 404', async () => {
    const { db } = fakeDb({ context: null });
    await expect(contextActivity(db, 'C')).rejects.toMatchObject({ status: 404 });
  });
});

describe('requestedSubUnits', () => {
  it('is null when not asked, else true or false', () => {
    expect(requestedSubUnits(undefined)).toBeNull();
    expect(['true', '1', 'false', '0'].map(requestedSubUnits)).toEqual([true, true, false, false]);
  });

  it('refuses anything else, an inherited property name included', () => {
    for (const v of ['yes', '', 'toString', 'constructor']) expect(() => requestedSubUnits(v), v).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('contextActivity on a parent — include sub-units', () => {
  const below = [{ id: 'C', parentContextId: 'R', displayName: 'Northwind Traders', depth: 1 }, { id: 'C1', parentContextId: 'C', displayName: 'Team', depth: 2 }];
  // Vera is a member of the team below; Ann of the root itself. Vera is active on the team.
  const members = [
    { contextId: 'C1', memberId: 'I1', memberType: 'Identity', displayName: 'Vera Example' },
    { contextId: 'R', memberId: 'I3', memberType: 'Identity', displayName: 'Ann Sample' },
    { contextId: 'C', memberId: 'I3', memberType: 'Identity', displayName: 'Ann Sample' },
  ];
  const group = (v, key) => v.groups.find(g => g.key === key).people;

  it('by default on a parent: the activity of the root and every unit below, against the members of all of them', async () => {
    const { db, asked } = fakeDb({ context: ROOT, below, members, aggregates: [agg({ contextId: 'C1' })] });
    const v = await contextActivity(db, 'R');
    expect(v.includeSubUnits).toBe(true);
    expect(asked[0].ids).toEqual(['R', 'C', 'C1']);
    expect(db.query.mock.calls.find(c => c[0].includes('FROM "ContextMembers"'))[1][0]).toEqual(['R', 'C', 'C1']);
    expect(group(v, 'memberAndActive').map(p => p.identityId)).toEqual(['I1']);
    // Ann is a member of two units of the tree: one member without activity, not two.
    expect(group(v, 'memberNoActivity').map(p => p.memberId)).toEqual(['I3']);
  });

  it('switched off: only the rows on the root itself, against its own members — and the tree is not read', async () => {
    const { db, asked } = fakeDb({ context: ROOT, below, members: members.filter(m => m.contextId === 'R'), aggregates: [] });
    const v = await contextActivity(db, 'R', { includeSubUnits: 'false' });
    expect(v.includeSubUnits).toBe(false);
    expect(asked[0].ids).toEqual(['R']);
    expect(db.query.mock.calls.some(c => c[0].includes('WITH RECURSIVE below'))).toBe(false);
  });

  it('switched on for a leaf it is just the leaf', async () => {
    const { db, asked } = fakeDb({ below: [], aggregates: [agg()] });
    const v = await contextActivity(db, 'C', { includeSubUnits: 'true' });
    expect(v.includeSubUnits).toBe(true);
    expect(asked[0].ids).toEqual(['C']);
  });
});

describe('activitySummary', () => {
  it('reads the root and every context below, and sums per direct sub-unit', async () => {
    const below = [{ id: 'C', parentContextId: 'R', displayName: 'Northwind Traders' }, { id: 'C1', parentContextId: 'C', displayName: 'Team' }];
    const { db, asked } = fakeDb({ context: ROOT, below, aggregates: [agg(), agg({ contextId: 'C1', amount: 3 })] });
    const s = await activitySummary(db, 'R');
    expect(asked[0].ids).toEqual(['R', 'C', 'C1']);
    expect(s.children).toEqual([expect.objectContaining({ contextId: 'C', total: 5, activePeople: 1, itself: false })]);
    expect(s.totals.total).toBe(5);
  });

  it('rows on the root itself make a first line "itself"', async () => {
    const below = [{ id: 'C', parentContextId: 'R', displayName: 'Northwind Traders' }];
    const { db } = fakeDb({ context: ROOT, below, aggregates: [agg({ amount: 4 }), agg({ contextId: 'R', amount: 1 })] });
    const s = await activitySummary(db, 'R');
    expect(s.children.map(c => [c.contextId, c.itself, c.total])).toEqual([['R', true, 1], ['C', false, 4]]); // first, though smaller
    expect(s.children[0].displayName).toBe('Customers');
    expect(s.totals.total).toBe(5);
  });

  it('a context without sub-units has no table', async () => {
    const { db, asked } = fakeDb({ context: ROOT, below: [] });
    expect(await activitySummary(db, 'R')).toEqual({ contextId: 'R', period: null, months: [], children: [], totals: null });
    expect(asked).toEqual([]);
  });
});

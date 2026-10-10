// SQL builders (snapshotQueries.js, asOfQuery.js, sqlParts.js). These tests pin
// the parts of the statements that carry a definition — joint grouping, the
// identity buckets, the bound values — and the period arithmetic. Whether the
// SQL is right against PostgreSQL is contract-tests/analyticsDatasets.contract.test.js.
import { describe, it, expect } from 'vitest';
import { resolveField } from './fields.js';
import {
  principalsCountSql, identitiesCountSql, identitiesExcludedSql, governedShareSql, governedExcludedSql,
} from './snapshotQueries.js';
import { monthPeriods, classifyPeriods, principalsAsOfSql, bindAsOf } from './asOfQuery.js';
import { NOT_LINKED, MULTIPLE_IDENTITIES, groupingClauses, liveAccountWhere } from './sqlParts.js';

function binder() {
  const params = [];
  return { params, bind: v => `$${params.push(v)}` };
}
const dim = (id, unknownLabel = '(unknown)') => ({ field: resolveField(id), dimension: { field: id, label: id, unknownLabel } });

describe('groupingClauses', () => {
  it('groups by every dimension at once jointly, by ordinal', () => {
    expect(groupingClauses(['a', 'b', 'c'])).toEqual({
      select: 'a AS d0,\n         b AS d1,\n         c AS d2,', groupBy: 'GROUP BY 1, 2, 3', orderBy: 'ORDER BY 1, 2, 3',
    });
    expect(groupingClauses([])).toEqual({ select: '', groupBy: '', orderBy: '' });
  });
});

describe('liveAccountWhere', () => {
  it('binds the group type and the scope, never inlines them', () => {
    const b = binder();
    const sql = liveAccountWhere({ systemIds: [3, 7] }, b.bind);
    expect(sql).toBe('p."deletedAt" IS NULL AND (p."principalType" IS NULL OR p."principalType" <> $1) AND p."systemId" = ANY($2::int[])');
    expect(b.params).toEqual(['#microsoft.graph.group', [3, 7]]);
    const u = binder();
    expect(liveAccountWhere({ systemIds: null }, u.bind)).not.toContain('systemId');
  });
});

describe('principalsCountSql', () => {
  it('buckets identity dimensions and joins identities only when one is used', () => {
    const b = binder();
    const sql = principalsCountSql({ dims: [dim('Principal.accountEnabled'), dim('Identity.department', 'n/a')], scope: { systemIds: null }, maxRows: 100, bind: b.bind });
    expect(sql).toContain('LEFT JOIN "Identities" i ON im.n = 1');
    expect(sql).toContain('GROUP BY 1, 2');
    expect(sql).toContain('HAVING COUNT(*) > 0');
    expect(b.params).toEqual(expect.arrayContaining([NOT_LINKED, MULTIPLE_IDENTITIES, 'n/a', 101]));
    expect(b.params.at(-1)).toBe(101);     // LIMIT maxRows + 1, so "over the limit" is detectable

    const p = binder();
    const plain = principalsCountSql({ dims: [dim('Principal.accountEnabled')], scope: { systemIds: null }, maxRows: 5, bind: p.bind });
    expect(plain).not.toContain('"Identities"');
    expect(p.params).not.toContain(NOT_LINKED);
  });
});

describe('identitiesCountSql', () => {
  it('reads identity values directly - no account buckets at identity grain', () => {
    const b = binder();
    const sql = identitiesCountSql({ dims: [dim('Identity.department')], scope: { systemIds: [1] }, maxRows: 10, bind: b.bind });
    expect(sql).toContain('JOIN live l ON l."identityId" = i."id"');
    expect(b.params).not.toContain(NOT_LINKED);
    expect(b.params).not.toContain(MULTIPLE_IDENTITIES);
  });

  it('counts exclusions over all identities without scope, over in-scope links with one', () => {
    const u = binder();
    expect(identitiesExcludedSql({ scope: { systemIds: null }, bind: u.bind })).toContain('FROM "Identities" i');
    const s = binder();
    const scoped = identitiesExcludedSql({ scope: { systemIds: [4] }, bind: s.bind });
    expect(scoped).toContain('COUNT(DISTINCT im."identityId")');
    expect(s.params.filter(p => Array.isArray(p))).toEqual([[4], [4]]);
  });
});

describe('governedShareSql', () => {
  it('reads the matrix views, hides business-role rows and counts holders', () => {
    const b = binder();
    const sql = governedShareSql({ dims: [dim('Resource.resourceType')], scope: { systemIds: null }, maxRows: 10, bind: b.bind });
    expect(sql).toContain('"vw_ResourceUserPermissionAssignments"');
    expect(sql).toContain('"vw_UserPermissionAssignmentViaBusinessRole"');
    expect(sql).toContain("NOT IN ('BusinessRole')");
    expect(sql).toContain('COUNT(DISTINCT pr.pid)::int AS holders');
    expect(sql).not.toContain('idmap');
    const e = binder();
    expect(governedExcludedSql({ scope: { systemIds: [2] }, bind: e.bind })).toContain('WHERE p."systemId" = ANY($1::int[])');
    expect(e.params).toEqual([[2], '#microsoft.graph.group']);
  });
});

describe('monthPeriods', () => {
  it('ends previous months at their last millisecond in UTC and measures the running month now', () => {
    const now = new Date('2026-03-15T10:00:00Z');
    expect(monthPeriods(3, now)).toEqual([
      { period: '2026-01', periodEnd: '2026-01-31T23:59:59.999Z', periodComplete: true },
      { period: '2026-02', periodEnd: '2026-02-28T23:59:59.999Z', periodComplete: true },
      { period: '2026-03', periodEnd: '2026-03-15T10:00:00.000Z', periodComplete: false },
    ]);
  });

  it('crosses a year boundary and returns only the running month for one period', () => {
    expect(monthPeriods(2, new Date('2026-01-02T00:00:00Z')).map(p => p.period)).toEqual(['2025-12', '2026-01']);
    expect(monthPeriods(1, new Date('2026-01-02T00:00:00Z'))).toHaveLength(1);
  });
});

describe('classifyPeriods', () => {
  const periods = monthPeriods(3, new Date('2026-03-15T10:00:00Z'));

  it('makes a month available exactly when its end is at or after historyStart', () => {
    const atEnd = classifyPeriods(periods, new Date('2026-01-31T23:59:59.999Z'));
    expect(atEnd.available.map(p => p.period)).toEqual(['2026-01', '2026-02', '2026-03']);
    const justAfter = classifyPeriods(periods, new Date('2026-02-01T00:00:00.000Z'));
    expect(justAfter.unavailable.map(p => p.period)).toEqual(['2026-01']);
  });

  it('without any history, answers only the running month', () => {
    const r = classifyPeriods(periods, null);
    expect(r.available.map(p => p.period)).toEqual(['2026-03']);
    expect(r.unavailable.map(p => p.period)).toEqual(['2026-01', '2026-02']);
  });
});

describe('principalsAsOfSql / bindAsOf', () => {
  it('filters tombstones, groups and systems not yet loaded, and binds the instant last', () => {
    const b = binder();
    const base = principalsAsOfSql({ dims: [dim('Principal.ext.tier')], scope: { systemIds: [9] }, maxRows: 50, bind: b.bind });
    expect(base).toContain("(sp.state ->> 'deletedAt') IS NULL");
    expect(base).toContain('NOT EXISTS (SELECT 1 FROM not_loaded nl');
    expect(b.params).toEqual(expect.arrayContaining(['tier', [9], '#microsoft.graph.group', 'initial-load:', 51]));
    const sql = bindAsOf(base, b.params);
    expect(sql).not.toContain(':ASOF:');
    expect(sql).toContain(`$${b.params.length + 1}::timestamptz`);
  });
});

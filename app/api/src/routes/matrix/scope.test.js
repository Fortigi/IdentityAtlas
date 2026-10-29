// Unit tests for routes/matrix/scope.js — filter-body validation plus the
// live-row (soft-delete) filters of the scope counts. All the SQL helpers are
// mocked; parseFilter returning null drives the 400 path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const sqls = [];
vi.mock('../../db/connection.js', () => ({ getPool: async () => ({}), queryOne: vi.fn() }));
vi.mock('../../perf/sqlTimer.js', () => ({
  timedQuery: async (_p, label, _res, sql) => { sqls.push({ label, sql }); return { rows: [] }; },
}));
vi.mock('../../db/matrixHelpers.js', () => ({
  buildAssignmentExprs: vi.fn(() => ({ subjectIdExpr: 'p."principalId"', assignmentJoin: '', assignmentWhere: ['1=1'] })),
}));
vi.mock('../../db/columnCache.js', () => ({ getPrincipalColumns: vi.fn(async () => []), getResourceColumns: vi.fn(async () => []) }));
vi.mock('../../matrix/scopeHistory.js', () => ({ generateSampleDates: vi.fn(() => []), buildScopeAsofSql: vi.fn(), historyStartSql: vi.fn() }));
vi.mock('../../matrix/attrExpr.js', () => ({ resolveAttrExpr: vi.fn(() => ({ attrExpr: 'u."department"' })) }));
// parseFilter returns null → every handler hits the "Invalid filter body" 400,
// unless a test stages a filter with mockReturnValueOnce.
vi.mock('./shared.js', () => ({
  parseFilter: vi.fn(() => null),
  buildSubqueries: vi.fn(async () => ({
    subject: () => ({ sql: null }), resource: () => ({ sql: '(RES)' }), warnings: [],
  })),
  subjectScopeClauses: vi.fn(() => ({ subjectTable: 'Principals', where: '' })),
  resourceScopeWhere: vi.fn((sql) => ` WHERE LIVE_RESOURCES(${sql})`),
  runCount: vi.fn(async (_p, label, _res, sql) => { sqls.push({ label, sql }); return 0; }),
  resolveContextTypes: vi.fn(),
}));

const shared = await import('./shared.js');
const { default: router } = await import('./scope.js');
const app = mountRouter(router);

beforeEach(() => { sqls.length = 0; });
const sqlOf = (label) => sqls.find(q => q.label === label).sql;

describe('matrix scope — invalid filter body', () => {
  it('POST /matrix/scope-stats 400 on an invalid filter', async () => {
    const res = await request(app).post('/api/matrix/scope-stats').send({});
    expect(res.status).toBe(400);
  });

  it('POST /matrix/scope-timeseries 400 on an invalid filter', async () => {
    const res = await request(app).post('/api/matrix/scope-timeseries').send({});
    expect(res.status).toBe(400);
  });
});

describe('matrix scope — soft-deleted rows stay out of the counts', () => {
  it('scope-stats counts resources through the live-row resource scope', async () => {
    shared.parseFilter.mockReturnValueOnce({ rowType: 'principal' });
    const res = await request(app).post('/api/matrix/scope-stats').send({ filter: {} });
    expect(res.status).toBe(200);
    expect(shared.resourceScopeWhere).toHaveBeenCalledWith('(RES)');
    expect(sqlOf('matrix-scope-resource')).toBe(
      'SELECT COUNT(*)::int AS c FROM "Resources" WHERE LIVE_RESOURCES((RES))');
  });

  it('scope-breakdown counts only live, non-group principals per group', async () => {
    shared.parseFilter.mockReturnValueOnce({ rowType: 'principal' });
    const res = await request(app).post('/api/matrix/scope-breakdown').send({ filter: {} });
    expect(res.status).toBe(200);
    expect(sqlOf('matrix-breakdown-principals')).toMatch(
      /WHERE u\."deletedAt" IS NULL AND \(u\."principalType" IS NULL/);
  });
});

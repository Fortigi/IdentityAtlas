// Unit tests for routes/matrix/scope.js — filter-body validation. All the SQL
// helpers are mocked; parseFilter returning null drives the 400 path.

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js', () => ({ getPool: async () => ({}), queryOne: vi.fn() }));
vi.mock('../../perf/sqlTimer.js', () => ({ timedQuery: async () => ({ rows: [] }) }));
vi.mock('../../db/matrixHelpers.js', () => ({ buildAssignmentExprs: vi.fn(() => ({})) }));
vi.mock('../../db/columnCache.js', () => ({ getPrincipalColumns: vi.fn(async () => []), getResourceColumns: vi.fn(async () => []) }));
vi.mock('../../matrix/scopeHistory.js', () => ({ generateSampleDates: vi.fn(() => []), buildScopeAsofSql: vi.fn(), historyStartSql: vi.fn() }));
vi.mock('../../matrix/attrExpr.js', () => ({ resolveAttrExpr: vi.fn(() => ({ expr: 'x' })) }));
// parseFilter returns null → every handler hits the "Invalid filter body" 400.
vi.mock('./shared.js', () => ({
  parseFilter: vi.fn(() => null),
  buildSubqueries: vi.fn(), subjectScopeClauses: vi.fn(), runCount: vi.fn(), resolveContextTypes: vi.fn(),
}));

const { default: router } = await import('./scope.js');
const app = mountRouter(router);

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

// Unit tests for routes/governance.js — summary mapping + branching. DB mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const stageQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  // governance.js's safeQuery now uses native timedQuery; normalise the staged
  // {recordset} to .rows so the existing test stagings keep working.
  timedQuery: async (_p, _l, _r, text, params) => {
    const r = await stageQuery(text, params);
    if (r == null) return r;
    const arr = r.rows ?? r.recordset ?? [];
    return { ...r, rows: arr, recordset: arr };
  },
  getQueryTimings: () => [],
}));
const query = vi.fn();
vi.mock('../db/connection.js', () => ({ getPool: async () => ({}), query: (...a) => query(...a) }));

const { default: router } = await import('./governance.js');
const app = mountRouter(router);

beforeEach(() => { stageQuery.mockReset(); query.mockReset(); });

describe('GET /governance/summary', () => {
  it('maps the aggregate row into the documented counts', async () => {
    stageQuery.mockResolvedValueOnce({ recordset: [{ totalAPs: 5, compliant: 3, overdue: 1, reviewedLate: 1, inProgress: 0 }] });
    const res = await request(app).get('/api/governance/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalAPs: 5, compliant: 3, overdue: 1, reviewedLate: 1, inProgress: 0 });
  });

  it('falls back to zeros when there is no aggregate row', async () => {
    stageQuery.mockResolvedValueOnce({ recordset: [] });
    const res = await request(app).get('/api/governance/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalAPs: 0, compliant: 0, overdue: 0 });
  });
});

describe('GET /governance/categories', () => {
  it('returns the category rows', async () => {
    stageQuery.mockResolvedValueOnce({ recordset: [{ id: 1, name: 'Finance' }] });
    const res = await request(app).get('/api/governance/categories');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, name: 'Finance' }]);
  });
});

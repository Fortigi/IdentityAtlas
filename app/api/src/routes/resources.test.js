// Unit tests for routes/resources.js — list filter-building + detail branching,
// DB mocked. The real SQL is covered by resources.contract.test.js; here we pin
// the handler logic (response shape, the resourceType filter branch, 400/404).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.USE_SQL = 'true';

// pool.request() recorder — captures the SQL + bound inputs of the list query
// and returns a controllable result.
let captured = { sql: '', inputs: {} };
let nextListResult = { recordsets: [[], [{ total: 0 }]] };
const mockPool = {
  request() {
    captured = { sql: '', inputs: {} };
    const r = {
      input(n, v) { captured.inputs[n] = v; return r; },
      query(sql) { captured.sql = sql; return Promise.resolve(nextListResult); },
    };
    return r;
  },
};

vi.mock('../db/connection.js', () => ({ getPool: async () => mockPool }));

// timedRequest is used only by GET /resources/:id.
const timedQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: () => ({ input() { return this; }, query: (sql) => timedQuery(sql) }),
  getQueryTimings: () => [],
}));

vi.mock('../db/columnCache.js', () => ({
  getResourceColumns: async () => [{ name: 'displayName' }, { name: 'resourceType' }],
  getResourceColumnValues: vi.fn(),
}));
vi.mock('./tags.js', () => ({
  ensureTagTables: async () => {},
  buildFilterWhere: () => '',
}));

const { default: router } = await import('./resources.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();

const VALID_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  timedQuery.mockReset();
  nextListResult = { recordsets: [[], [{ total: 0 }]] };
});

describe('GET /resources — list', () => {
  it('returns { data, total } with parsed tags and backward-compat aliases', async () => {
    nextListResult = {
      recordsets: [
        [{ id: 'r1', displayName: 'Eng', description: 'd', resourceType: 'EntraGroup', extendedAttributes: null, tagString: null }],
        [{ total: 1 }],
      ],
    };
    const res = await request(app).get('/api/resources');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: 'r1', groupId: 'r1', groupTypeCalculated: 'EntraGroup', tags: [] });
  });

  it('filters by resourceType when supplied', async () => {
    await request(app).get('/api/resources?resourceType=EntraGroup');
    expect(captured.sql).toContain('r."resourceType" = @resourceType');
    expect(captured.inputs.resourceType).toBe('EntraGroup');
  });

  it('excludes BusinessRole resources when no resourceType filter is given', async () => {
    await request(app).get('/api/resources');
    expect(captured.sql).toContain(`r."resourceType" <> 'BusinessRole'`);
  });
});

describe('GET /resources/:id — detail', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).get('/api/resources/not-a-uuid');
    expect(res.status).toBe(400);
    expect(timedQuery).not.toHaveBeenCalled();
  });

  it('404 when the resource does not exist', async () => {
    timedQuery.mockResolvedValueOnce({ recordset: [] });
    const res = await request(app).get(`/api/resources/${VALID_ID}`);
    expect(res.status).toBe(404);
  });
});

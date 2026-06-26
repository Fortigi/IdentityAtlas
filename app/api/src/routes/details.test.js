// Unit tests for routes/details.js — input validation + branching, DB mocked.
//
// details.js has the lowest route coverage in the API. These pin the cheap,
// high-value contracts: malformed ids are rejected before any query, and the
// entity-detail handlers 404 when the row is absent. The DB layer is mocked so
// no container is needed (contract tests cover the real SQL).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// useSql is captured at module load — enable it before importing the router.
process.env.USE_SQL = 'true';

// timedRequest(...).input(...).query(sql) → { recordset }. Route it through a
// controllable mock so each test can stage the rows the handler sees.
const timedQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: () => ({ input() { return this; }, query: (sql) => timedQuery(sql) }),
  getQueryTimings: () => [],
}));

const dbQuery = vi.fn();
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({}),
  query: (...a) => dbQuery(...a),
  queryOne: vi.fn(),
}));

const { default: router } = await import('./details.js');

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
  dbQuery.mockReset();
});

describe('details — id validation (400 before any query)', () => {
  for (const path of ['/api/user/not-a-uuid', '/api/group/xyz', '/api/access-package/short']) {
    it(`rejects ${path}`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(timedQuery).not.toHaveBeenCalled();
      expect(dbQuery).not.toHaveBeenCalled();
    });
  }
});

describe('GET /user/:id — branching', () => {
  it('404 when the principal does not exist', async () => {
    timedQuery.mockResolvedValueOnce({ recordset: [] }); // user-attributes query → no row
    const res = await request(app).get(`/api/user/${VALID_ID}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /group/:id — branching', () => {
  it('404 when the group does not exist', async () => {
    timedQuery.mockResolvedValueOnce({ recordset: [] }); // group-attributes query → no row
    const res = await request(app).get(`/api/group/${VALID_ID}`);
    expect(res.status).toBe(404);
  });
});

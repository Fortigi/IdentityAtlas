// Unit tests for routes/systems.js — id validation, 404, write-guards. DB mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const timedQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: () => ({ input() { return this; }, query: (sql) => timedQuery(sql) }),
  getQueryTimings: () => [],
}));
vi.mock('../db/connection.js', () => ({ getPool: async () => ({}) }));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));

const { default: router } = await import('./systems.js');
const app = mountRouter(router);
const VALID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => timedQuery.mockReset());

describe('systems', () => {
  it('400 on a malformed system id', async () => {
    const res = await request(app).get('/api/systems/bad');
    expect(res.status).toBe(400);
  });

  it('404 when the system is not found', async () => {
    timedQuery.mockResolvedValueOnce({ recordset: [] });
    const res = await request(app).get(`/api/systems/${VALID}`);
    expect(res.status).toBe(404);
  });

  it('PUT 400 when no updatable fields are supplied', async () => {
    const res = await request(app).put(`/api/systems/${VALID}`).send({});
    expect(res.status).toBe(400);
  });

  it('POST owners 400 when userId is missing/invalid', async () => {
    const res = await request(app).post(`/api/systems/${VALID}/owners`).send({ userId: 'nope' });
    expect(res.status).toBe(400);
  });
});

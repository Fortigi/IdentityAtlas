// Unit tests for routes/bulkLists.js — flat paginated listings of the
// join-table entities. DB mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../db/connection.js', () => ({
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
  default: {},
}));

const { default: router } = await import('./bulkLists.js');
const app = mountRouter(router);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

const endpoints = ['/api/assignments', '/api/identity-members', '/api/resource-relationships'];

describe('bulkLists happy paths', () => {
  for (const ep of endpoints) {
    it(`GET ${ep} returns { data, total }`, async () => {
      query.mockResolvedValueOnce({ rows: [{ a: 1 }, { a: 2 }] });
      queryOne.mockResolvedValueOnce({ total: 2 });
      const res = await request(app).get(ep);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 2 });
      expect(res.body.data).toHaveLength(2);
    });

    it(`GET ${ep}?systemId=3 applies the filter (param passed)`, async () => {
      query.mockResolvedValueOnce({ rows: [] });
      queryOne.mockResolvedValueOnce({ total: 0 });
      const res = await request(app).get(`${ep}?systemId=3&limit=50&offset=10`);
      expect(res.status).toBe(200);
      // systemId present → first data param should be 3
      expect(query.mock.calls[0][1][0]).toBe(3);
    });

    it(`GET ${ep} returns total 0 when count row missing`, async () => {
      query.mockResolvedValueOnce({ rows: [] });
      queryOne.mockResolvedValueOnce(null);
      const res = await request(app).get(ep);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
    });

    it(`GET ${ep} returns 500 when the query rejects`, async () => {
      query.mockRejectedValueOnce(new Error('db down'));
      queryOne.mockResolvedValueOnce({ total: 0 });
      const res = await request(app).get(ep);
      expect(res.status).toBe(500);
    });
  }
});

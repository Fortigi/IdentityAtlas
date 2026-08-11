// Unit tests for routes/bulkLists.js — flat paginated listings of the
// join-table entities. DB mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';

const { default: router } = await import('./bulkLists.js');
const app = mountRouter(router);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

const endpoints = [
  '/api/assignments', '/api/identity-members', '/api/resource-relationships',
  '/api/governance-catalogs', '/api/assignment-policies',
  '/api/assignment-requests', '/api/certification-decisions',
];

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

describe('bulkLists SQL shape', () => {
  // The export needs to distinguish governed from non-governed assignments —
  // the `governed` flag must be in the SELECT or the workbook can't split them.
  it('GET /api/assignments selects the governed flag', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    queryOne.mockResolvedValueOnce({ total: 0 });
    await request(app).get('/api/assignments');
    expect(query.mock.calls[0][0]).toContain('"governed"');
  });

  // Each governance feed must read its own table — a copy/paste slip would
  // silently point a feed at the wrong table.
  const tableByEndpoint = {
    '/api/governance-catalogs': 'GovernanceCatalogs',
    '/api/assignment-policies': 'AssignmentPolicies',
    '/api/assignment-requests': 'AssignmentRequests',
    '/api/certification-decisions': 'CertificationDecisions',
  };
  for (const [ep, table] of Object.entries(tableByEndpoint)) {
    it(`GET ${ep} reads "${table}"`, async () => {
      query.mockResolvedValueOnce({ rows: [] });
      queryOne.mockResolvedValueOnce({ total: 0 });
      await request(app).get(ep);
      expect(query.mock.calls[0][0]).toContain(`"${table}"`);
    });
  }
});

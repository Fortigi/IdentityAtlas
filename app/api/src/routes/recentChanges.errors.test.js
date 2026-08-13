// Error-path coverage for the recent-changes handlers (#1031). The data/routes
// tests cover the happy, empty and 400 paths; these pin that a failing history
// query is caught and surfaced as a 500 for every entity handler.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');            // picks up src/db/__mocks__/connection.js
import { query } from '../db/connection.js';

const { default: router } = await import('./recentChanges.js');
const app = mountRouter(router);

const ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  query.mockReset();
  query.mockRejectedValue(new Error('boom')); // the _history pull fails
});

describe('recent-changes handlers surface a query failure as 500', () => {
  for (const base of ['/api/user', '/api/resources', '/api/access-package', '/api/identities']) {
    it(`${base}/:id/recent-changes -> 500`, async () => {
      const res = await request(app).get(`${base}/${ID}/recent-changes`);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to load recent changes' });
    });
  }
});

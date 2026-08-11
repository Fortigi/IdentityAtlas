// Unit tests for routes/recentChanges.js handlers — id validation + empty-history
// happy paths. DB mocked. (The diff/buildEntityTimeline pure functions are
// covered by recentChanges.timeline.test.js; this exercises the route handlers.)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';

const { default: router } = await import('./recentChanges.js');
const app = mountRouter(router);

const VALID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  query.mockResolvedValue({ rows: [] });   // no _history rows + empty batch label queries
  queryOne.mockResolvedValue(null);
});

describe('recentChanges — id validation', () => {
  const paths = [
    '/api/user/nope/recent-changes',
    '/api/resources/nope/recent-changes',
    '/api/access-package/nope/recent-changes',
    '/api/identities/nope/recent-changes',
    '/api/user/nope/timeline',
    '/api/resources/nope/timeline',
    '/api/access-package/nope/timeline',
    '/api/identities/nope/timeline',
    '/api/contexts/nope/timeline',
  ];
  for (const path of paths) {
    it(`400 on a malformed id: ${path}`, async () => {
      expect((await request(app).get(path)).status).toBe(400);
    });
  }
});

describe('recentChanges — empty history (200)', () => {
  for (const base of ['/api/user', '/api/resources', '/api/access-package', '/api/identities']) {
    it(`GET ${base}/:id/recent-changes returns empty events`, async () => {
      const res = await request(app).get(`${base}/${VALID}/recent-changes`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ events: [], addedCount: 0, removedCount: 0 });
    });
  }

  for (const base of ['/api/user', '/api/resources', '/api/access-package', '/api/identities', '/api/contexts']) {
    it(`GET ${base}/:id/timeline returns empty events`, async () => {
      const res = await request(app).get(`${base}/${VALID}/timeline`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ events: [] });
    });
  }
});

// Mock-mode (USE_SQL unset) unit tests for the admin split.
//
// The SQL branches are covered by admin.test.js / admin.coverage.test.js (which
// load the router with USE_SQL=true). This file covers the complementary
// "database not configured" guards that every admin handler checks up front —
// the `if (!useSql)` / `if (process.env.USE_SQL !== 'true')` early returns the
// split moved into admin/{curatedData,riskConfig,maintenance,dashboard,settings}.js.
// Auth-settings has no such guard, so it still renders.

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'false';

vi.mock('../db/connection.js', () => ({ getPool: async () => ({}), query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
vi.mock('../config/authConfig.js', () => ({ getAuthState: () => ({ enabled: false, loaded: true }) }));
vi.mock('../ingest/tombstonePurge.js', () => ({ purgeExpiredTombstones: vi.fn() }));

const { default: router } = await import('./admin.js');
const app = mountRouter(router);

describe('admin — database-not-configured guards (USE_SQL off)', () => {
  it('GET /admin/risk-profile -> available:false', async () => {
    const res = await request(app).get('/api/admin/risk-profile');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });

  it('GET /admin/classifiers -> available:false', async () => {
    const res = await request(app).get('/api/admin/classifiers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });

  it('GET /admin/export/curated -> 400 (SQL mode required)', async () => {
    expect((await request(app).get('/api/admin/export/curated')).status).toBe(400);
  });

  it('POST /admin/import/curated -> 400 (SQL mode required)', async () => {
    expect((await request(app).post('/api/admin/import/curated').send({ tags: [], categories: [] })).status).toBe(400);
  });

  const guarded503 = [
    ['post', '/api/admin/clean-database'],
    ['post', '/api/admin/features/toggle'],
    ['get', '/api/admin/dashboard-stats'],
    ['get', '/api/admin/dashboard-timeseries'],
    ['get', '/api/admin/history-retention'],
    ['put', '/api/admin/history-retention'],
    ['post', '/api/admin/history-retention/prune'],
  ];
  for (const [method, path] of guarded503) {
    it(`${method.toUpperCase()} ${path} -> 503 (SQL not configured)`, async () => {
      const res = await request(app)[method](path).send({});
      expect(res.status).toBe(503);
    });
  }

  it('GET /admin/auth-settings still renders (no DB dependency)', async () => {
    const res = await request(app).get('/api/admin/auth-settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, platform: 'docker' });
  });
});

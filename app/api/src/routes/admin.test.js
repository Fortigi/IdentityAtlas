// Unit tests for routes/admin.js — feature toggle, retention, and dashboard
// read validation/branching. DB + authConfig + tombstonePurge mocked. The
// complex import/export/clean handlers are intentionally not covered here.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({ request: () => ({ input() { return this; }, query: async () => ({ recordset: [] }) }) }),
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
}));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
vi.mock('../config/authConfig.js', () => ({ getAuthState: () => ({ enabled: false }) }));
vi.mock('../ingest/tombstonePurge.js', () => ({ purgeExpiredTombstones: vi.fn(async () => ({ purged: 0 })) }));

const { default: router } = await import('./admin.js');
const app = mountRouter(router);

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('POST /admin/features/toggle', () => {
  it('400 on an unknown feature', async () => {
    expect((await request(app).post('/api/admin/features/toggle').send({ feature: 'nope', enabled: true })).status).toBe(400);
  });
  it('400 when enabled is not boolean', async () => {
    expect((await request(app).post('/api/admin/features/toggle').send({ feature: 'riskScoring', enabled: 'yes' })).status).toBe(400);
  });
  it('200 on a valid toggle', async () => {
    query.mockResolvedValueOnce({});
    const res = await request(app).post('/api/admin/features/toggle').send({ feature: 'riskScoring', enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ feature: 'riskScoring', enabled: true });
  });
});

describe('PUT /admin/history-retention', () => {
  it('400 when retentionDays is out of range', async () => {
    expect((await request(app).put('/api/admin/history-retention').send({ retentionDays: 5000 })).status).toBe(400);
  });
  it('400 when retentionDays is not a number', async () => {
    expect((await request(app).put('/api/admin/history-retention').send({ retentionDays: 'abc' })).status).toBe(400);
  });
  it('200 on a valid value', async () => {
    query.mockResolvedValueOnce({});
    const res = await request(app).put('/api/admin/history-retention').send({ retentionDays: 180 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ retentionDays: 180 });
  });
});

describe('GET /admin/risk-profile', () => {
  it('reports unavailable when there is no profile row', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/admin/risk-profile');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: false });
  });
});

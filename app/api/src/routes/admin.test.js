// Unit tests for routes/admin.js — feature toggle, retention, and dashboard
// read validation/branching. DB + authConfig + tombstonePurge mocked. The
// complex import/export/clean handlers are intentionally not covered here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const query = vi.fn();
const queryOne = vi.fn();
// Risk scoring is an experimental flag (off on a fresh install); these tests
// exercise the feature itself, so it starts on. Its OFF behaviour is asserted below.
const flags = vi.hoisted(() => ({ riskScoring: true }));
vi.mock('../featureFlags.js', async (orig) =>
  (await import('../../test-utils/featureFlagMock.js')).steeredFeatureFlags(await orig(), flags));
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({ request: () => ({ input() { return this; }, query: async () => ({ recordset: [] }) }) }),
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
}));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
const authState = vi.hoisted(() => ({ on: false }));
vi.mock('../config/authConfig.js', () => ({ getAuthState: () => ({ enabled: false }), isAuthEnabled: () => authState.on }));
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
  // The MCP server acts for the signed-in user: with sign-in off there is no one to act for.
  it('409 when switching the MCP server on while sign-in is off, and stores nothing', async () => {
    authState.on = false;
    const res = await request(app).post('/api/admin/features/toggle').send({ feature: 'mcpServer', enabled: true });
    expect(res.status).toBe(409);
    expect(query).not.toHaveBeenCalled();
  });
  it('lets the MCP server be switched off while sign-in is off, and on once it is on', async () => {
    query.mockResolvedValue({});
    authState.on = false;
    expect((await request(app).post('/api/admin/features/toggle').send({ feature: 'mcpServer', enabled: false })).status).toBe(200);
    authState.on = true;
    expect((await request(app).post('/api/admin/features/toggle').send({ feature: 'mcpServer', enabled: true })).status).toBe(200);
    expect(query.mock.calls.map(c => c[1])).toEqual([['FEATURE_MCP_SERVER', 'false'], ['FEATURE_MCP_SERVER', 'true']]);
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

// Risk scoring is experimental: while its flag is off, the read-only config the
// Risk Scoring tab shows does not exist, and the dashboard says nothing about it.
describe('with the riskScoring flag off', () => {
  afterEach(() => { flags.riskScoring = true; });

  it.each(['/api/admin/risk-profile', '/api/admin/classifiers'])('GET %s answers 404 without a query', async (path) => {
    flags.riskScoring = false;
    const res = await request(app).get(path);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'This feature is not enabled' });
    expect(query).not.toHaveBeenCalled();
  });

  it('the rest of the admin router is not gated by it', async () => {
    flags.riskScoring = false;
    queryOne.mockResolvedValueOnce({ configValue: '90' });
    const res = await request(app).get('/api/admin/history-retention');
    expect(res.status).not.toBe(404);
  });

  // Same stats row both times: only the flag differs, so a dashboard that
  // ignored it would answer identically.
  const STATS = { principals: 3, resources: 2, riskScores: 40, activeRiskProfile: 1, activeClassifiers: 2 };

  it('dashboard-stats drops every risk count and the LLM readiness', async () => {
    flags.riskScoring = false;
    queryOne.mockResolvedValueOnce({ ...STATS });
    const res = await request(app).get('/api/admin/dashboard-stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ principals: 3, resources: 2, hasData: true });
    // Only the stats SELECT ran — no LLM_CONFIG / Secrets lookups.
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('dashboard-stats keeps them, and checks the LLM, once the flag is on', async () => {
    queryOne
      .mockResolvedValueOnce({ ...STATS })
      .mockResolvedValueOnce({ '?column?': 1 })
      .mockResolvedValueOnce({ '?column?': 1 });
    const res = await request(app).get('/api/admin/dashboard-stats');
    expect(res.body).toEqual({ ...STATS, llmConfigured: true, hasData: true });
  });
});

// Unit tests for routes/riskScores.js — paginated list happy paths + single/
// override validation. DB + queryRiskScoresPage mocked. (riskScores.summary.test.js
// covers the GET /risk-scores summary LIMIT clauses.)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

// riskTableExists() runs one timed query and checks rows[0].tbl != null.
vi.mock('../perf/sqlTimer.js', () => ({
  timedQuery: async () => ({ rows: [{ tbl: 'public.RiskScores' }] }),
  getQueryTimings: () => [],
}));
vi.mock('../db/connection.js', () => ({ getPool: async () => ({}), query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));

const ROW = { id: 'x', riskScore: 80, riskTier: 'High', riskClassifierMatches: [], riskExplanation: {}, riskOverride: null };
const queryRiskScoresPage = vi.fn(async () => ({ data: [ROW], total: 1 }));
vi.mock('../db/queryHelpers.js', () => ({ queryRiskScoresPage: (...a) => queryRiskScoresPage(...a) }));

const { default: router } = await import('./riskScores.js');
const app = mountRouter(router);

const VALID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => { queryRiskScoresPage.mockClear(); });

describe('risk-scores — paginated lists (200)', () => {
  for (const path of ['users', 'groups', 'business-roles', 'contexts', 'identities']) {
    it(`GET /risk-scores/${path} returns { data, total, available }`, async () => {
      const res = await request(app).get(`/api/risk-scores/${path}`);
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.total).toBe(1);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({ id: 'x', effectiveScore: 80 });
    });
  }
});

describe('GET /risk-scores/:type/:id — validation', () => {
  it('400 on an invalid type', async () => {
    expect((await request(app).get(`/api/risk-scores/bogus/${VALID}`)).status).toBe(400);
  });
  it('400 on a malformed id', async () => {
    expect((await request(app).get('/api/risk-scores/users/not-a-uuid')).status).toBe(400);
  });
});

describe('PUT /risk-scores/:type/:id/override — validation', () => {
  it('400 when adjustment is out of range', async () => {
    const res = await request(app).put(`/api/risk-scores/users/${VALID}/override`).send({ adjustment: 100, reason: 'valid reason' });
    expect(res.status).toBe(400);
  });
  it('400 when reason is too short', async () => {
    const res = await request(app).put(`/api/risk-scores/users/${VALID}/override`).send({ adjustment: 5, reason: 'a' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /risk-scores/:type/:id/override — validation', () => {
  it('400 on an invalid type', async () => {
    expect((await request(app).delete(`/api/risk-scores/bogus/${VALID}/override`)).status).toBe(400);
  });
});

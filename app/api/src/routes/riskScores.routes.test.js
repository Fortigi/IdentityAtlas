// Unit tests for routes/riskScores.js — paginated list happy paths + single/
// override validation. DB + queryRiskScoresPage mocked. (riskScores.summary.test.js
// covers the GET /risk-scores summary LIMIT clauses.)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Risk scoring is an experimental flag (off on a fresh install); these tests
// exercise the feature itself, so it starts on. Its OFF behaviour is asserted below.
const flags = vi.hoisted(() => ({ riskScoring: true }));
vi.mock('../featureFlags.js', async (orig) =>
  (await import('../../test-utils/featureFlagMock.js')).steeredFeatureFlags(await orig(), flags));

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

  // A soft-deleted principal / resource is history: its score must not list.
  // Contexts, Identities and GovernanceCatalogs have no tombstone column.
  const fromClauseOf = async (path) => {
    await request(app).get(`/api/risk-scores/${path}`);
    return queryRiskScoresPage.mock.calls.at(-1)[2].fromClause;
  };
  it.each([
    ['users', 'p.id AND p."deletedAt" IS NULL'],
    ['groups', 'r.id AND r."deletedAt" IS NULL'],
    ['business-roles', `'BusinessRole' AND br."deletedAt" IS NULL`],
    ['contexts', 'ou."managerId" = p.id AND p."deletedAt" IS NULL'],
  ])('GET /risk-scores/%s joins only live rows', async (path, clause) => {
    expect(await fromClauseOf(path)).toContain(clause);
  });

  it('adds no live filter on tables without a tombstone (identities)', async () => {
    const from = await fromClauseOf('identities');
    expect(from).not.toContain('deletedAt');
    expect(from).not.toContain('1=1');
  });
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

// While the experimental riskScoring flag is off, stored scores stay in the
// database but are not served: every /risk-scores endpoint 404s before a query.
describe('with the riskScoring flag off', () => {
  afterEach(() => { flags.riskScoring = true; });
  const calls = [
    ['GET /risk-scores (summary)', a => request(a).get('/api/risk-scores')],
    ...['users', 'groups', 'business-roles', 'contexts', 'identities'].map(t =>
      [`GET /risk-scores/${t}`, a => request(a).get(`/api/risk-scores/${t}`)]),
    ['GET /risk-scores/:type/:id', a => request(a).get(`/api/risk-scores/users/${VALID}`)],
    ['PUT …/override', a => request(a).put(`/api/risk-scores/users/${VALID}/override`).send({ adjustment: 5, reason: 'valid reason' })],
    ['DELETE …/override', a => request(a).delete(`/api/risk-scores/users/${VALID}/override`)],
  ];

  it.each(calls)('%s answers 404 without reading any score', async (_name, call) => {
    flags.riskScoring = false;
    const res = await call(app);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'This feature is not enabled' });
    expect(queryRiskScoresPage).not.toHaveBeenCalled();
  });

  it('gates only /risk-scores, not the rest of the shared /api mount', async () => {
    flags.riskScoring = false;
    const a = mountRouter(router);
    a.get('/api/risk-scoresheet', (_req, res) => res.json({ ok: true }));
    expect((await request(a).get('/api/risk-scoresheet')).status).toBe(200);
  });
});

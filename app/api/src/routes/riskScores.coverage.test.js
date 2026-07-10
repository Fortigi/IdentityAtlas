// Coverage-focused unit tests for routes/riskScores.js. DB layer + sqlTimer +
// queryRiskScoresPage all mocked (no network, no real pg). Targets the single-
// entity GET and the PUT/DELETE override handlers — the read/write paths that
// riskScores.routes.test.js (validation only) and riskScores.summary.test.js
// (the summary endpoint) leave uncovered.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

// A flexible timedRequest mock: each call returns a chainable request object
// whose .query() resolves a recordset chosen by the SQL it's handed. Tests push
// scripted responses onto `recordsetQueue` keyed loosely by label; the default
// is the table-check returning a present table.
let tableExists = true;
const queryScript = []; // FIFO of { match?: RegExp, recordset } applied to .query() calls (excluding the table check)

vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: (_p, label) => ({
    _inputs: {},
    input(name, value) { this._inputs[name] = value; return this; },
    async query(sql) {
      if (/to_regclass/.test(sql)) {
        return { recordset: [{ tbl: tableExists ? 'public.RiskScores' : null }] };
      }
      // Pop the next scripted response (if any) for non-table-check queries.
      // Push an Error to simulate a failing query (exercises the 500 catch paths).
      const next = queryScript.shift();
      if (next === undefined) return { recordset: [] };
      if (next instanceof Error) throw next;
      return { recordset: next };
    },
  }),
  getQueryTimings: () => [],
}));

vi.mock('../db/connection.js', () => ({ getPool: async () => ({}), query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));

const queryRiskScoresPage = vi.fn(async () => ({ data: [], total: 0 }));
vi.mock('../db/queryHelpers.js', () => ({ queryRiskScoresPage: (...a) => queryRiskScoresPage(...a) }));

const { default: router } = await import('./riskScores.js');
const app = mountRouter(router);

const VALID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  tableExists = true;
  queryScript.length = 0;
  queryRiskScoresPage.mockClear();
});

// ─── paginated lists — filter branches ──────────────────────────────
describe('risk-scores lists — filter/pagination branches', () => {
  it('users — applies tier/search/department/overridesOnly filters', async () => {
    queryRiskScoresPage.mockResolvedValueOnce({ data: [{ id: 'u', riskScore: 50, riskOverride: 10 }], total: 1 });
    const res = await request(app)
      .get('/api/risk-scores/users?tier=High&search=bob&department=IT&overridesOnly=true&limit=5&offset=2');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    // effectiveScore = 50 + 10 override = 60
    expect(res.body.data[0].effectiveScore).toBe(60);
    const opts = queryRiskScoresPage.mock.calls[0][2];
    expect(opts.limit).toBe(5);
    expect(opts.offset).toBe(2);
    expect(opts.whereClause).toContain('riskOverride');
  });

  it('groups — applies resourceType filter', async () => {
    const res = await request(app).get('/api/risk-scores/groups?resourceType=Group&search=x&tier=Low');
    expect(res.status).toBe(200);
    expect(res.body.useResources).toBe(true);
    expect(queryRiskScoresPage.mock.calls[0][2].whereClause).toContain('resourceType');
  });

  it('business-roles — search + overridesOnly', async () => {
    const res = await request(app).get('/api/risk-scores/business-roles?search=role&overridesOnly=true');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  it('contexts — search filter', async () => {
    const res = await request(app).get('/api/risk-scores/contexts?search=dept&tier=Medium');
    expect(res.status).toBe(200);
  });

  it('identities — search filter', async () => {
    const res = await request(app).get('/api/risk-scores/identities?search=person');
    expect(res.status).toBe(200);
  });

  it('users — 500 when queryRiskScoresPage rejects', async () => {
    queryRiskScoresPage.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/api/risk-scores/users');
    expect(res.status).toBe(500);
  });
});

// ─── GET /risk-scores/:type/:id ─────────────────────────────────────
describe('GET /risk-scores/:type/:id', () => {
  it('200 — returns the score with a denormalized displayName', async () => {
    queryScript.push([{ id: 'x', entityType: 'Principal', riskScore: 70, riskOverride: null }]); // single score
    queryScript.push([{ displayName: 'Bob' }]);                                                   // entity name
    const res = await request(app).get(`/api/risk-scores/users/${VALID}`);
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Bob');
    expect(res.body.effectiveScore).toBe(70);
  });

  it('404 when no score row exists', async () => {
    queryScript.push([]); // single-score query → empty
    const res = await request(app).get(`/api/risk-scores/groups/${VALID}`);
    expect(res.status).toBe(404);
  });

  it('400 on an invalid type', async () => {
    expect((await request(app).get(`/api/risk-scores/bogus/${VALID}`)).status).toBe(400);
  });

  it('400 on a malformed id', async () => {
    expect((await request(app).get('/api/risk-scores/users/not-a-uuid')).status).toBe(400);
  });
});

// ─── PUT /risk-scores/:type/:id/override ────────────────────────────
describe('PUT /risk-scores/:type/:id/override', () => {
  it('200 — sets an override on a Principal (with denorm)', async () => {
    queryScript.push([{ riskDirectScore: 10, riskMembershipScore: 5, riskStructuralScore: 0, riskPropagatedScore: 0 }]); // read
    queryScript.push([]); // update RiskScores
    queryScript.push([]); // denorm Principals
    const res = await request(app).put(`/api/risk-scores/users/${VALID}/override`).send({ adjustment: 10, reason: 'elevated access' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.riskScore).toBe(25); // 15 base + 10
    expect(res.body.riskTier).toBe('Low');
  });

  it('200 — sets an override on a Resource (group) clamps at 100', async () => {
    queryScript.push([{ riskDirectScore: 60, riskMembershipScore: 40, riskStructuralScore: 20, riskPropagatedScore: 0 }]);
    queryScript.push([]);
    queryScript.push([]);
    const res = await request(app).put(`/api/risk-scores/groups/${VALID}/override`).send({ adjustment: 50, reason: 'critical' });
    expect(res.status).toBe(200);
    expect(res.body.riskScore).toBe(100);
    expect(res.body.riskTier).toBe('Critical');
  });

  it('404 when the entity has no score row', async () => {
    queryScript.push([]); // read → empty
    const res = await request(app).put(`/api/risk-scores/users/${VALID}/override`).send({ adjustment: 5, reason: 'valid reason' });
    expect(res.status).toBe(404);
  });

  it('500 when the update query fails', async () => {
    queryScript.push([{ riskDirectScore: 10, riskMembershipScore: 0, riskStructuralScore: 0, riskPropagatedScore: 0 }]); // read ok
    queryScript.push(new Error('update boom')); // risk-override-set throws
    const res = await request(app).put(`/api/risk-scores/users/${VALID}/override`).send({ adjustment: 5, reason: 'valid reason' });
    expect(res.status).toBe(500);
  });

  it('400 on an invalid type', async () => {
    expect((await request(app).put(`/api/risk-scores/bogus/${VALID}/override`).send({ adjustment: 5, reason: 'valid reason' })).status).toBe(400);
  });
  it('400 on a malformed id', async () => {
    expect((await request(app).put('/api/risk-scores/users/bad/override').send({ adjustment: 5, reason: 'valid reason' })).status).toBe(400);
  });
  it('400 when adjustment is not an integer', async () => {
    expect((await request(app).put(`/api/risk-scores/users/${VALID}/override`).send({ adjustment: 2.5, reason: 'valid reason' })).status).toBe(400);
  });
  it('400 when adjustment is out of range', async () => {
    expect((await request(app).put(`/api/risk-scores/users/${VALID}/override`).send({ adjustment: 99, reason: 'valid reason' })).status).toBe(400);
  });
  it('400 when reason is too short', async () => {
    expect((await request(app).put(`/api/risk-scores/users/${VALID}/override`).send({ adjustment: 5, reason: 'a' })).status).toBe(400);
  });
  it('400 when reason is too long', async () => {
    const longReason = 'x'.repeat(501);
    expect((await request(app).put(`/api/risk-scores/users/${VALID}/override`).send({ adjustment: 5, reason: longReason })).status).toBe(400);
  });
});

// ─── DELETE /risk-scores/:type/:id/override ─────────────────────────
describe('DELETE /risk-scores/:type/:id/override', () => {
  it('200 — clears an override on a Principal', async () => {
    queryScript.push([{ riskDirectScore: 30, riskMembershipScore: 30, riskStructuralScore: 25, riskPropagatedScore: 0 }]); // read
    queryScript.push([]); // clear update
    queryScript.push([]); // denorm
    const res = await request(app).delete(`/api/risk-scores/users/${VALID}/override`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.riskScore).toBe(85); // sum=85
    // 85 is High on the canonical 90/70 scale (engine tierFor). Previously this
    // route used a divergent 80/60 computeTier that mis-labelled 85 as Critical —
    // that drift is now fixed by sharing riskscoring/tiers.js.
    expect(res.body.riskTier).toBe('High');
  });

  it('200 — clears an override on a Resource', async () => {
    queryScript.push([{ riskDirectScore: 5, riskMembershipScore: 0, riskStructuralScore: 0, riskPropagatedScore: 0 }]);
    queryScript.push([]);
    queryScript.push([]);
    const res = await request(app).delete(`/api/risk-scores/groups/${VALID}/override`);
    expect(res.status).toBe(200);
    expect(res.body.riskTier).toBe('Minimal'); // 5 → Minimal
  });

  it('404 when no score row exists', async () => {
    queryScript.push([]);
    const res = await request(app).delete(`/api/risk-scores/users/${VALID}/override`);
    expect(res.status).toBe(404);
  });

  it('500 when the clear query fails', async () => {
    queryScript.push([{ riskDirectScore: 10, riskMembershipScore: 0, riskStructuralScore: 0, riskPropagatedScore: 0 }]); // read ok
    queryScript.push(new Error('clear boom')); // risk-override-clear throws
    const res = await request(app).delete(`/api/risk-scores/users/${VALID}/override`);
    expect(res.status).toBe(500);
  });

  it('400 on an invalid type', async () => {
    expect((await request(app).delete(`/api/risk-scores/bogus/${VALID}/override`)).status).toBe(400);
  });
  it('400 on a malformed id', async () => {
    expect((await request(app).delete('/api/risk-scores/users/bad/override')).status).toBe(400);
  });
});

// Unit tests for routes/riskScoringRuns.js — start/list/get scoring runs.
// DB + scoring engine mocked. Auth disabled by default so the gate passes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

// Risk scoring is an experimental flag (off on a fresh install); these tests
// exercise the feature itself, so it starts on. Its OFF behaviour is asserted below.
const flags = vi.hoisted(() => ({ riskScoring: true }));
vi.mock('../featureFlags.js', async (orig) =>
  (await import('../../test-utils/featureFlagMock.js')).steeredFeatureFlags(await orig(), flags));
vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';

const runScoring = vi.fn(() => Promise.resolve());
vi.mock('../riskscoring/engine.js', () => ({ runScoring: (...a) => runScoring(...a) }));

const { default: router } = await import('./riskScoringRuns.js');
const app = mountRouter(router);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  runScoring.mockClear();
});

describe('POST /risk-scoring/runs', () => {
  it('uses the supplied classifier and returns 202', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 11 })           // classifier exists
      .mockResolvedValueOnce({ id: 99, status: 'pending' }); // inserted run
    const res = await request(app).post('/api/risk-scoring/runs').send({ classifierId: 11 });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: 99 });
    expect(runScoring).toHaveBeenCalledWith(99, 11);
  });

  it('409 without starting the engine when a run is already in progress (SEC-2026-09 L-11)', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 5 })  // active classifier
      .mockResolvedValueOnce(null);      // conditional insert found an active run
    const res = await request(app).post('/api/risk-scoring/runs').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/);
    expect(runScoring).not.toHaveBeenCalled();
    const [sql, params] = queryOne.mock.calls[1];
    expect(sql).toMatch(/WHERE NOT EXISTS/);
    expect(sql).toContain("status IN ('pending', 'running')");
    expect(params).toEqual([5, 'system', 360]);
  });

  it('404 when supplied classifier not found', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).post('/api/risk-scoring/runs').send({ classifierId: 7 });
    expect(res.status).toBe(404);
  });

  it('falls back to the active classifier when none supplied', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 5 })            // active classifier
      .mockResolvedValueOnce({ id: 100, status: 'pending' });
    const res = await request(app).post('/api/risk-scoring/runs').send({});
    expect(res.status).toBe(202);
    expect(runScoring).toHaveBeenCalledWith(100, 5);
  });

  it('412 when no classifier supplied and none active', async () => {
    queryOne.mockResolvedValueOnce(null); // no active
    const res = await request(app).post('/api/risk-scoring/runs').send({});
    expect(res.status).toBe(412);
  });

  it('500 when insert rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('db'));
    const res = await request(app).post('/api/risk-scoring/runs').send({});
    expect(res.status).toBe(500);
  });
});

describe('GET /risk-scoring/runs', () => {
  it('lists runs', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const res = await request(app).get('/api/risk-scoring/runs');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('500 when list rejects', async () => {
    query.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).get('/api/risk-scoring/runs');
    expect(res.status).toBe(500);
  });
});

describe('GET /risk-scoring/runs/:id', () => {
  it('400 on non-numeric id', async () => {
    const res = await request(app).get('/api/risk-scoring/runs/abc');
    expect(res.status).toBe(400);
  });

  it('404 when not found', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/risk-scoring/runs/3');
    expect(res.status).toBe(404);
  });

  it('returns the run', async () => {
    queryOne.mockResolvedValueOnce({ id: 3, status: 'done' });
    const res = await request(app).get('/api/risk-scoring/runs/3');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 3 });
  });

  it('500 when query rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).get('/api/risk-scoring/runs/3');
    expect(res.status).toBe(500);
  });
});

// While the experimental riskScoring flag is off, no run starts and no run
// history is shown — the Logs page reads the list for every role.
describe('with the riskScoring flag off', () => {
  afterEach(() => { flags.riskScoring = true; });
  const calls = [
    ['POST /risk-scoring/runs', a => request(a).post('/api/risk-scoring/runs').send({})],
    ['GET /risk-scoring/runs', a => request(a).get('/api/risk-scoring/runs')],
    ['GET /risk-scoring/runs/:id', a => request(a).get('/api/risk-scoring/runs/3')],
  ];

  it.each(calls)('%s answers 404 without reading the database or starting the engine', async (_name, call) => {
    flags.riskScoring = false;
    const res = await call(app);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'This feature is not enabled' });
    expect(query).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalled();
    expect(runScoring).not.toHaveBeenCalled();
  });
});

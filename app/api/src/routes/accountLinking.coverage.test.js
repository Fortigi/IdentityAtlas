// Unit tests for routes/accountLinking.js — config + run endpoints. DB,
// engine, and default-rules dependencies mocked. Auth is disabled by default
// so requirePermission gates pass through.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query, queryOne } from '../db/connection.js';

const runLinking = vi.fn(() => Promise.resolve());
vi.mock('../accountlinking/engine.js', () => ({ runLinking: (...a) => runLinking(...a) }));
// A stand-in shipped dictionary, with two signals so the effective-dictionary
// merge below has something to merge. The real merge (rulesMerge.js) runs
// against this, so the test states what the ROUTE serves without restating the
// merge's own rules — those are pinned in accountlinking/rulesMerge.test.js.
vi.mock('../accountlinking/defaultRules.js', () => ({
  DEFAULT_RULES: {
    sample: true,
    signals: [{ name: 'shippedEarly', type: 'exact', weight: 10 }, { name: 'shippedLater', type: 'loginName', weight: 55 }],
  },
}));

const { default: router } = await import('./accountLinking.js');
const app = mountRouter(router);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  runLinking.mockClear();
});

describe('GET /account-linking/config', () => {
  it('returns the active config row', async () => {
    queryOne.mockResolvedValueOnce({
      id: 7, rules: { a: 1 }, schedules: [], isActive: true,
      updatedAt: 't', updatedBy: 'me',
    });
    const res = await request(app).get('/api/account-linking/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 7, isActive: true, updatedBy: 'me' });
  });

  it('serves the EFFECTIVE dictionary, not the stored one (#1469)', async () => {
    // The settings editor shows this response and Save writes it back, so a raw
    // echo of the stored rules both hides the signals this tenant is missing and
    // re-persists the stale list on the next Save. Here the tenant reweighted
    // one shipped signal and saved before the second one existed: their weight
    // stands, the signal they predate is added with its shipped definition.
    queryOne.mockResolvedValueOnce({
      id: 7, rules: { signals: [{ name: 'shippedEarly', type: 'exact', weight: 99 }], linkThreshold: 85 },
      schedules: [], isActive: true, updatedAt: 't', updatedBy: 'me',
    });
    const res = await request(app).get('/api/account-linking/config');

    expect(res.status).toBe(200);
    expect(res.body.rules.signals).toEqual([
      { name: 'shippedEarly', type: 'exact', weight: 99 },
      { name: 'shippedLater', type: 'loginName', weight: 55 },
    ]);
    expect(res.body.rules.linkThreshold).toBe(85); // the tenant's own value is untouched
    expect(res.body.rules.sample).toBe(true);      // …as are shipped keys they never saved
  });

  it('returns shipped defaults when no row exists', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/account-linking/config');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: null, defaults: true });
  });

  it('500 when the query rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/account-linking/config');
    expect(res.status).toBe(500);
  });
});

describe('PUT /account-linking/config', () => {
  it('400 when rules missing', async () => {
    const res = await request(app).put('/api/account-linking/config').send({});
    expect(res.status).toBe(400);
  });

  it('inserts when no existing row', async () => {
    queryOne
      .mockResolvedValueOnce(null) // existing lookup
      .mockResolvedValueOnce({ id: 1, rules: { x: 1 }, schedules: [], isActive: true });
    const res = await request(app).put('/api/account-linking/config').send({ rules: { x: 1 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 1 });
  });

  it('updates when a row exists', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 9 }) // existing
      .mockResolvedValueOnce({ id: 9, rules: { x: 2 }, schedules: [], isActive: false });
    const res = await request(app).put('/api/account-linking/config').send({ rules: { x: 2 }, isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 9, isActive: false });
  });

  it('500 when save rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).put('/api/account-linking/config').send({ rules: { x: 1 } });
    expect(res.status).toBe(500);
  });
});

describe('POST /account-linking/runs', () => {
  it('202 + run row and fires the engine', async () => {
    queryOne
      .mockResolvedValueOnce({ id: 3 }) // active config
      .mockResolvedValueOnce({ id: 42, status: 'pending' }); // inserted run
    const res = await request(app).post('/api/account-linking/runs').send({});
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: 42 });
    expect(runLinking).toHaveBeenCalledWith(42, 3);
  });

  it('500 when insert rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('insert failed'));
    const res = await request(app).post('/api/account-linking/runs').send({});
    expect(res.status).toBe(500);
  });
});

describe('GET /account-linking/runs', () => {
  it('lists runs', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
    const res = await request(app).get('/api/account-linking/runs');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('500 when list rejects', async () => {
    query.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).get('/api/account-linking/runs');
    expect(res.status).toBe(500);
  });
});

describe('GET /account-linking/runs/:id', () => {
  it('400 on non-numeric id', async () => {
    const res = await request(app).get('/api/account-linking/runs/abc');
    expect(res.status).toBe(400);
  });

  it('404 when run not found', async () => {
    queryOne.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/account-linking/runs/5');
    expect(res.status).toBe(404);
  });

  it('returns the run', async () => {
    queryOne.mockResolvedValueOnce({ id: 5, status: 'done' });
    const res = await request(app).get('/api/account-linking/runs/5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5 });
  });

  it('500 when query rejects', async () => {
    queryOne.mockRejectedValueOnce(new Error('x'));
    const res = await request(app).get('/api/account-linking/runs/5');
    expect(res.status).toBe(500);
  });
});

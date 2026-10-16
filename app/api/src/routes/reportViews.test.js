// Unit tests for the report-view routes.
//
// The permission gate is mocked to deny whichever permission the request names
// in `x-deny`, so a test can prove which permission a route asks for — not just
// that some gate exists.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mountRouterAs } from '../../test-utils/routeTestKit.js';

vi.mock('../db/connection.js');
vi.mock('../middleware/auth.js', () => ({
  requirePermission: (permission) => (req, res, next) => (
    req.headers['x-deny'] === permission ? res.status(403).json({ error: 'Forbidden' }) : next()),
}));
import { query, queryOne } from '../db/connection.js';
import { registerReport } from '../reports/registry.js';
import router from './reportViews.js';

const app = mountRouterAs(router, () => ({ email: 'ann@example.com' }));
const ID = '33333333-3333-3333-3333-333333333333';

const BASE = {
  name: 'test-route-viewable', displayName: 'Viewable', form: 'list',
  parametersSchema: { properties: { scope: { type: 'array' } } },
  columns: [{ key: 'x', label: 'X' }], run: async () => ({ rows: [] }),
};
const stored = (over = {}) => ({
  id: ID, reportName: BASE.name, name: 'Ledger', description: null, params: { scope: ['c1'] },
  createdBy: 'ann@example.com', updatedBy: 'ann@example.com', updatedAt: new Date('2026-10-16T08:00:00Z'), ...over,
});
const body = {
  id: ID, report: `view-${ID}`, reportName: BASE.name, name: 'Ledger', description: null, params: { scope: ['c1'] },
  createdBy: 'ann@example.com', updatedBy: 'ann@example.com', updatedAt: '2026-10-16T08:00:00.000Z',
};

let unregister;
beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  unregister = registerReport(BASE);
});
afterEach(() => { unregister(); vi.restoreAllMocks(); });

describe('GET /api/report-views/:id', () => {
  it('returns the view with the report name it runs under, to anyone who can read', async () => {
    queryOne.mockResolvedValue(stored());
    const res = await request(app).get(`/api/report-views/${ID}`).set('x-deny', 'data.write.reports').expect(200);
    expect(res.body).toEqual(body);
  });

  it('404s on an unknown or malformed id without a malformed query', async () => {
    queryOne.mockResolvedValue(null);
    await request(app).get(`/api/report-views/${ID}`).expect(404);
    queryOne.mockClear();
    await request(app).get('/api/report-views/nope').expect(404);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('answers a failure generically', async () => {
    queryOne.mockRejectedValue(new Error('relation "ReportViews" does not exist'));
    const res = await request(app).get(`/api/report-views/${ID}`).expect(500);
    expect(res.body).toEqual({ error: 'Request failed' });
  });
});

describe('POST /api/report-views', () => {
  it('saves the view as the caller and answers with it', async () => {
    queryOne.mockResolvedValue(stored());
    const res = await request(app).post('/api/report-views')
      .send({ reportName: BASE.name, name: 'Ledger', params: { scope: ['c1'], junk: 'x' } }).expect(201);
    expect(res.body).toEqual(body);
    const params = queryOne.mock.calls[0][1];
    expect(params.slice(1)).toEqual([BASE.name, 'Ledger', null, '{"scope":["c1"]}', 'ann@example.com']);
  });

  it('needs data.write.reports', async () => {
    await request(app).post('/api/report-views').set('x-deny', 'data.write.reports')
      .send({ reportName: BASE.name, name: 'Ledger' }).expect(403);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('refuses a body without a name or a viewable report, saying why', async () => {
    const res = await request(app).post('/api/report-views').send({ reportName: 'nope' }).expect(400);
    expect(res.body.errors).toEqual(['A name is required', 'A view needs a standard report that takes parameters']);
    expect(res.body.error).toBe('A name is required; A view needs a standard report that takes parameters');
  });

  it('answers a duplicate name with 409, and a failure with 500', async () => {
    queryOne.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const dup = await request(app).post('/api/report-views').send({ reportName: BASE.name, name: 'Ledger' }).expect(409);
    expect(dup.body.error).toBe('A view with that name already exists');
    queryOne.mockRejectedValueOnce(new Error('down'));
    await request(app).post('/api/report-views').send({ reportName: BASE.name, name: 'Ledger' }).expect(500);
  });
});

describe('PUT /api/report-views/:id', () => {
  it('updates the view, keeping it a view of the report it was made from', async () => {
    queryOne.mockResolvedValueOnce(stored()).mockResolvedValueOnce(stored({ name: 'Renamed' }));
    const res = await request(app).put(`/api/report-views/${ID}`)
      .send({ reportName: 'something-else', name: 'Renamed', params: { scope: 'c2' } }).expect(200);
    expect(res.body.name).toBe('Renamed');
    expect(queryOne.mock.calls[1][1]).toEqual([ID, 'Renamed', null, '{"scope":"c2"}', 'ann@example.com']);
  });

  it('needs data.write.reports', async () => {
    await request(app).put(`/api/report-views/${ID}`).set('x-deny', 'data.write.reports').send({ name: 'x' }).expect(403);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('404s on a malformed id, a missing view, or one deleted while saving', async () => {
    await request(app).put('/api/report-views/nope').send({ name: 'x' }).expect(404);
    queryOne.mockResolvedValueOnce(null);
    await request(app).put(`/api/report-views/${ID}`).send({ name: 'x' }).expect(404);
    queryOne.mockResolvedValueOnce(stored()).mockResolvedValueOnce(null);
    await request(app).put(`/api/report-views/${ID}`).send({ name: 'x' }).expect(404);
  });

  it('refuses a blank name, and answers a duplicate with 409 and a failure with 500', async () => {
    queryOne.mockResolvedValueOnce(stored());
    const bad = await request(app).put(`/api/report-views/${ID}`).send({ name: ' ' }).expect(400);
    expect(bad.body.errors).toEqual(['A name is required']);

    queryOne.mockResolvedValueOnce(stored()).mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await request(app).put(`/api/report-views/${ID}`).send({ name: 'Taken' }).expect(409);
    queryOne.mockRejectedValueOnce(new Error('down'));
    await request(app).put(`/api/report-views/${ID}`).send({ name: 'x' }).expect(500);
  });
});

describe('DELETE /api/report-views/:id', () => {
  it('deletes, and 404s when there was nothing to delete', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await request(app).delete(`/api/report-views/${ID}`).expect(204);
    query.mockResolvedValueOnce({ rowCount: 0 });
    await request(app).delete(`/api/report-views/${ID}`).expect(404);
  });

  it('needs data.write.reports, and answers a failure with 500', async () => {
    await request(app).delete(`/api/report-views/${ID}`).set('x-deny', 'data.write.reports').expect(403);
    expect(query).not.toHaveBeenCalled();
    query.mockRejectedValueOnce(new Error('down'));
    await request(app).delete(`/api/report-views/${ID}`).expect(500);
  });
});

// Unit tests for routes/matrix/savedFilters.js — CRUD validation. DB mocked.
// UUID_RE comes from the real filterSql.js (a pure regex — not mocked).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../../db/connection.js', () => ({ query: (...a) => query(...a), queryOne: (...a) => queryOne(...a) }));

const { default: router } = await import('./savedFilters.js');
const app = mountRouter(router);

const VALID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('matrix saved-filters', () => {
  it('GET /matrix/saved-filters returns the rows', async () => {
    // Blanket-mock db.query so the handler's SELECT returns rows (the table is
    // created by migrations 023/028 now, not a runtime ensure step).
    query.mockResolvedValue({ rows: [{ id: VALID, name: 'Mine' }] });
    const res = await request(app).get('/api/matrix/saved-filters');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: VALID, name: 'Mine' }]);
  });

  it('POST 400 when name is missing', async () => {
    expect((await request(app).post('/api/matrix/saved-filters').send({ filter: {} })).status).toBe(400);
  });

  it('POST 400 when filter is missing/not an object', async () => {
    expect((await request(app).post('/api/matrix/saved-filters').send({ name: 'X' })).status).toBe(400);
  });

  it('PUT 400 on a malformed id', async () => {
    expect((await request(app).put('/api/matrix/saved-filters/nope').send({ name: 'X' })).status).toBe(400);
  });

  it('PUT 400 when there are no updatable fields', async () => {
    expect((await request(app).put(`/api/matrix/saved-filters/${VALID}`).send({})).status).toBe(400);
  });

  it('DELETE 400 on a malformed id', async () => {
    expect((await request(app).delete('/api/matrix/saved-filters/nope')).status).toBe(400);
  });

  it('POST 201 creates a filter and returns the stored row', async () => {
    query.mockResolvedValue({});                                   // INSERT
    queryOne.mockResolvedValue({ id: VALID, name: 'New', filter: {} }); // SELECT back
    const res = await request(app).post('/api/matrix/saved-filters').send({ name: 'New', filter: { rowType: 'user' } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: VALID, name: 'New', filter: {} });
  });

  it('POST 409 on a duplicate name', async () => {
    query.mockRejectedValue({ code: '23505' });
    const res = await request(app).post('/api/matrix/saved-filters').send({ name: 'Dup', filter: {} });
    expect(res.status).toBe(409);
  });

  it('PUT 200 updates a filter', async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ id: VALID, name: 'Renamed', isDefault: true }] });
    const res = await request(app).put(`/api/matrix/saved-filters/${VALID}`)
      .send({ name: 'Renamed', description: null, filter: { rowType: 'group' }, isDefault: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: VALID, name: 'Renamed', isDefault: true });
  });

  it('PUT 404 when the filter does not exist', async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await request(app).put(`/api/matrix/saved-filters/${VALID}`).send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  it('DELETE 204 removes a filter', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    expect((await request(app).delete(`/api/matrix/saved-filters/${VALID}`)).status).toBe(204);
  });

  it('DELETE 404 when the filter does not exist', async () => {
    query.mockResolvedValue({ rowCount: 0 });
    expect((await request(app).delete(`/api/matrix/saved-filters/${VALID}`)).status).toBe(404);
  });

  it('GET /matrix/default-filter returns the default row', async () => {
    queryOne.mockResolvedValue({ id: VALID, name: 'Default', isDefault: true });
    const res = await request(app).get('/api/matrix/default-filter');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: VALID, name: 'Default', isDefault: true });
  });
});

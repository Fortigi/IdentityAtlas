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
});

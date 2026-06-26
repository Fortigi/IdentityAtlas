// Unit tests for routes/categories.js — list + CRUD validation. DB mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

let nextResult = { recordset: [] };
const mockPool = { request() { const r = { input() { return r; }, query() { return Promise.resolve(nextResult); } }; return r; } };
vi.mock('../db/connection.js', () => ({ getPool: async () => mockPool }));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));

const { default: router } = await import('./categories.js');
const app = mountRouter(router);

beforeEach(() => { nextResult = { recordset: [] }; });

describe('categories', () => {
  it('GET /categories returns the rows', async () => {
    nextResult = { recordset: [{ id: 1, name: 'Finance', color: '#3b82f6' }] };
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, name: 'Finance', color: '#3b82f6' }]);
  });

  it('POST /categories 400 when name is missing', async () => {
    expect((await request(app).post('/api/categories').send({})).status).toBe(400);
  });

  it('POST /categories 400 on a non-hex color', async () => {
    expect((await request(app).post('/api/categories').send({ name: 'X', color: 'red' })).status).toBe(400);
  });

  it('PATCH /categories/:id 400 on a non-integer id', async () => {
    expect((await request(app).patch('/api/categories/abc').send({ name: 'Y' })).status).toBe(400);
  });

  it('DELETE /categories/:id 400 on a non-integer id', async () => {
    expect((await request(app).delete('/api/categories/abc')).status).toBe(400);
  });

  it('POST /categories/:id/assign 400 when resourceId is missing', async () => {
    expect((await request(app).post('/api/categories/1/assign').send({})).status).toBe(400);
  });
});

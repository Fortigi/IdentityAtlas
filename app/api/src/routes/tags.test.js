// Unit tests for routes/tags.js — list + tag CRUD/assign validation. DB and the
// column-cache / bootstrap / memberCounts helpers mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({}),
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
}));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));
vi.mock('../db/columnCache.js', () => ({
  getGroupColumns: vi.fn(async () => []), getResourceColumns: vi.fn(async () => []),
  getPrincipalOrUserColumns: vi.fn(async () => []), getPrincipalOrUserColumnValues: vi.fn(async () => []),
  getGroupColumnValues: vi.fn(async () => []), getResourceColumnValues: vi.fn(async () => []),
}));
vi.mock('../bootstrap.js', () => ({ getOrCreateTagRoot: vi.fn(async () => 'root-id') }));
vi.mock('../contexts/memberCounts.js', () => ({ recalcMemberCountsForChain: vi.fn(async () => {}) }));

const { default: router } = await import('./tags.js');
const app = mountRouter(router);

const VALID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('tags', () => {
  it('GET /tags returns the rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: VALID, name: 'PII', color: '#3b82f6' }] });
    const res = await request(app).get('/api/tags');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: VALID, name: 'PII', color: '#3b82f6' }]);
  });

  it('POST /tags 400 when name/entityType are missing', async () => {
    expect((await request(app).post('/api/tags').send({})).status).toBe(400);
  });

  it('POST /tags 400 on an invalid entityType', async () => {
    expect((await request(app).post('/api/tags').send({ name: 'X', entityType: 'nope' })).status).toBe(400);
  });

  it('POST /tags 400 on a non-hex color', async () => {
    expect((await request(app).post('/api/tags').send({ name: 'X', entityType: 'user', color: 'red' })).status).toBe(400);
  });

  it('PATCH /tags/:id 400 on a malformed id', async () => {
    expect((await request(app).patch('/api/tags/nope').send({ name: 'X' })).status).toBe(400);
  });

  it('POST /tags/:id/assign 400 on a malformed id', async () => {
    expect((await request(app).post('/api/tags/nope/assign').send({ entityIds: ['a'] })).status).toBe(400);
  });

  it('POST /tags/:id/assign 400 when entityIds is not a non-empty array', async () => {
    expect((await request(app).post(`/api/tags/${VALID}/assign`).send({ entityIds: [] })).status).toBe(400);
  });

  it('GET /entity-tags 400 on an invalid entityType', async () => {
    expect((await request(app).get('/api/entity-tags?entityType=nope')).status).toBe(400);
  });
});

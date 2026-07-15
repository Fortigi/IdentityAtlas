// Unit tests for routes/systems.js — id validation, 404/409/500, write-guards.
// DB mocked (control-flow only; the real SQL shape is pinned by
// contract-tests/systemsOwners.contract.test.js).
//
// Systems.id is an INTEGER (SERIAL) and SystemOwners.userId / Principals.id are
// UUIDs — the routes validate each param against its own type. These tests use
// the real shapes (integer system id, uuid user id) so they'd catch a regression
// to the old "everything is a UUID" validation that returned 400 for real ids.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const timedQuery = vi.fn();
vi.mock('../perf/sqlTimer.js', () => ({
  timedQuery: (...args) => timedQuery(...args),
  getQueryTimings: () => [],
}));
vi.mock('../db/connection.js', () => ({ getPool: async () => ({}) }));
vi.mock('../middleware/auth.js', () => ({ requirePermission: () => (_q, _s, next) => next() }));

const { default: router } = await import('./systems.js');
const app = mountRouter(router);
const SYSTEM = '5';                                      // Systems.id — integer
const USER = '11111111-1111-1111-1111-111111111111';    // Principals.id — uuid

beforeEach(() => timedQuery.mockReset());

describe('GET /systems (list)', () => {
  it('returns the recordset', async () => {
    timedQuery.mockResolvedValueOnce({ rows: [{ id: 5, displayName: 'S' }] });
    const res = await request(app).get('/api/systems');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 5, displayName: 'S' }]);
  });

  it('returns [] when the query throws', async () => {
    timedQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get('/api/systems');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('GET /systems/:id', () => {
  it('400 on a non-integer id', async () => {
    const res = await request(app).get('/api/systems/bad');
    expect(res.status).toBe(400);
  });

  it('200 with the row for an integer id', async () => {
    timedQuery.mockResolvedValueOnce({ rows: [{ id: 5, displayName: 'S' }] });
    const res = await request(app).get(`/api/systems/${SYSTEM}`);
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('S');
  });

  it('404 when the system is not found', async () => {
    timedQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/systems/${SYSTEM}`);
    expect(res.status).toBe(404);
  });

  it('500 when the query throws', async () => {
    timedQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/api/systems/${SYSTEM}`);
    expect(res.status).toBe(500);
  });
});

describe('PUT /systems/:id', () => {
  it('400 on a non-integer id', async () => {
    const res = await request(app).put('/api/systems/bad').send({ displayName: 'X' });
    expect(res.status).toBe(400);
  });

  it('400 when no updatable fields are supplied', async () => {
    const res = await request(app).put(`/api/systems/${SYSTEM}`).send({});
    expect(res.status).toBe(400);
  });

  it('200 updates displayName, description and enabled', async () => {
    timedQuery.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    const res = await request(app)
      .put(`/api/systems/${SYSTEM}`)
      .send({ displayName: 'A', description: 'B', enabled: true });
    expect(res.status).toBe(200);
  });

  it('404 when the update matches no row', async () => {
    timedQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).put(`/api/systems/${SYSTEM}`).send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it('500 when the update throws', async () => {
    timedQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).put(`/api/systems/${SYSTEM}`).send({ displayName: 'A' });
    expect(res.status).toBe(500);
  });
});

describe('GET /systems/:id/owners', () => {
  it('400 on a non-integer id', async () => {
    const res = await request(app).get('/api/systems/bad/owners');
    expect(res.status).toBe(400);
  });

  it('200 returns the owner rows', async () => {
    timedQuery.mockResolvedValueOnce({ rows: [{ systemId: 5, userId: USER, userDisplayName: 'Z' }] });
    const res = await request(app).get(`/api/systems/${SYSTEM}/owners`);
    expect(res.status).toBe(200);
    expect(res.body[0].userDisplayName).toBe('Z');
  });

  it('returns [] when the query throws', async () => {
    timedQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(`/api/systems/${SYSTEM}/owners`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /systems/:id/owners', () => {
  it('400 on a non-integer system id', async () => {
    const res = await request(app).post('/api/systems/bad/owners').send({ userId: USER });
    expect(res.status).toBe(400);
  });

  it('400 when userId is missing/invalid', async () => {
    const res = await request(app).post(`/api/systems/${SYSTEM}/owners`).send({ userId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('201 when the owner is added', async () => {
    timedQuery.mockResolvedValueOnce({ rows: [{ systemId: 5, userId: USER }] });
    const res = await request(app).post(`/api/systems/${SYSTEM}/owners`).send({ userId: USER });
    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(USER);
  });

  it('409 on a postgres duplicate-key (code 23505)', async () => {
    timedQuery.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const res = await request(app).post(`/api/systems/${SYSTEM}/owners`).send({ userId: USER });
    expect(res.status).toBe(409);
  });

  it('500 on any other error', async () => {
    timedQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post(`/api/systems/${SYSTEM}/owners`).send({ userId: USER });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /systems/:id/owners/:userId', () => {
  it('400 on a non-integer system id', async () => {
    const res = await request(app).delete(`/api/systems/bad/owners/${USER}`);
    expect(res.status).toBe(400);
  });

  it('400 on a non-uuid user id', async () => {
    const res = await request(app).delete(`/api/systems/${SYSTEM}/owners/nope`);
    expect(res.status).toBe(400);
  });

  it('200 when the owner is removed', async () => {
    timedQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).delete(`/api/systems/${SYSTEM}/owners/${USER}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('500 when the delete throws', async () => {
    timedQuery.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).delete(`/api/systems/${SYSTEM}/owners/${USER}`);
    expect(res.status).toBe(500);
  });
});

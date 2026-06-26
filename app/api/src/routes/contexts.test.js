// Unit tests for routes/contexts.js — create validation + branching, DB mocked.
//
// Covers the POST /contexts validation gauntlet and the parent-lookup branches
// without a database. The recursive-CTE SQL itself is covered by the contract
// tests; here we pin the handler logic.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

process.env.USE_SQL = 'true';

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../db/connection.js', () => ({
  getPool: async () => ({}),
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
}));
// Auth gate is asserted elsewhere; here it's a passthrough so we reach the logic.
vi.mock('../middleware/auth.js', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

const { default: router } = await import('./contexts.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  return app;
}
const app = makeApp();

const VALID_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe('GET /contexts/:id — validation', () => {
  it('400 on a malformed id', async () => {
    const res = await request(app).get('/api/contexts/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('POST /contexts — body validation', () => {
  const base = { targetType: 'Principal', contextType: 'Department', displayName: 'Eng' };

  it('400 when targetType is missing/invalid', async () => {
    const res = await request(app).post('/api/contexts').send({ ...base, targetType: 'Nope' });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('400 when contextType is missing', async () => {
    const { contextType, ...noType } = base;
    const res = await request(app).post('/api/contexts').send(noType);
    expect(res.status).toBe(400);
  });

  it('400 when displayName is missing', async () => {
    const { displayName, ...noName } = base;
    const res = await request(app).post('/api/contexts').send(noName);
    expect(res.status).toBe(400);
  });

  it('400 when parentContextId is not a uuid', async () => {
    const res = await request(app).post('/api/contexts').send({ ...base, parentContextId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400 when the parent context does not exist', async () => {
    queryOne.mockResolvedValueOnce(null); // parent lookup → not found
    const res = await request(app).post('/api/contexts').send({ ...base, parentContextId: VALID_ID });
    expect(res.status).toBe(400);
  });

  it('400 when the parent has a different targetType', async () => {
    queryOne.mockResolvedValueOnce({ targetType: 'Resource' }); // parent of a different type
    const res = await request(app).post('/api/contexts').send({ ...base, parentContextId: VALID_ID });
    expect(res.status).toBe(400);
  });

  it('201 and returns the created row on a valid body', async () => {
    query.mockResolvedValueOnce({}); // INSERT
    queryOne.mockResolvedValueOnce({ id: 'new-id', displayName: 'Eng' }); // SELECT back
    const res = await request(app).post('/api/contexts').send(base);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'new-id', displayName: 'Eng' });
  });
});

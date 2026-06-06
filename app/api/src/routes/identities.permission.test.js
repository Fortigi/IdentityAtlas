/**
 * Permission-gating tests for the analyst-override endpoints.
 *
 * The new `data.write.identity` permission gates:
 *   PUT    /identities/:id/members/:userId/override
 *   DELETE /identities/:id/members/:userId/override
 *
 * identities.override.test.js relies on auth being DISABLED (requirePermission
 * short-circuits to next()), so it cannot observe a 403. Here we mock
 * ../middleware/auth.js with an enforcing requirePermission that checks
 * req.user.permissions, and inject req.user via a tiny pre-router middleware to
 * simulate a caller with / without the permission.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const VALID_ID  = '11111111-1111-1111-1111-111111111111';
const VALID_ID2 = '22222222-2222-2222-2222-222222222222';

const { mockReq } = vi.hoisted(() => {
  process.env.USE_SQL = 'true';
  const mockReq = {
    input: vi.fn().mockReturnThis(),
    query: vi.fn().mockResolvedValue({ recordset: [] }),
  };
  return { mockReq };
});

vi.mock('../db/connection.js', () => ({
  getPool: vi.fn().mockResolvedValue({ request: () => mockReq }),
  queryOne: vi.fn().mockResolvedValue({ t: 'Identities' }),
  query:    vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('../perf/sqlTimer.js', () => ({
  timedRequest: (_pool, _label, _res) => mockReq,
  getQueryTimings: () => [],
}));

// Enforcing requirePermission: deny with 403 unless the caller's permission set
// (set on req.user.permissions by the harness below) includes a required perm
// or the wildcard '*'.
vi.mock('../middleware/auth.js', () => ({
  requirePermission: (...required) => (req, res, next) => {
    const perms = req.user?.permissions;
    if (!perms) return res.status(403).json({ error: 'No permissions', required });
    if (perms.has('*') || required.some(p => perms.has(p))) return next();
    return res.status(403).json({ error: 'Insufficient permissions', required });
  },
}));

const { default: identitiesRouter } = await import('./identities.js');

// Build an app whose req.user carries the given permission set.
function appWithPerms(perms) {
  const app = express().use(express.json());
  app.use((req, _res, next) => { req.user = { permissions: new Set(perms) }; next(); });
  app.use(identitiesRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReq.input.mockReturnThis();
  mockReq.query.mockResolvedValue({ recordset: [] });
});

describe('PUT /identities/:id/members/:userId/override — permission gate', () => {
  it('returns 403 when the caller lacks data.write.identity', async () => {
    const res = await request(appWithPerms(['data.read']))
      .put(`/identities/${VALID_ID}/members/${VALID_ID2}/override`)
      .send({ action: 'confirmed' });
    expect(res.status).toBe(403);
    expect(res.body.required).toContain('data.write.identity');
  });

  it('succeeds when the caller has data.write.identity', async () => {
    const res = await request(appWithPerms(['data.write.identity']))
      .put(`/identities/${VALID_ID}/members/${VALID_ID2}/override`)
      .send({ action: 'confirmed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, action: 'confirmed' });
  });

  it('succeeds for a wildcard (*) caller', async () => {
    const res = await request(appWithPerms(['*']))
      .put(`/identities/${VALID_ID}/members/${VALID_ID2}/override`)
      .send({ action: 'confirmed' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /identities/:id/members/:userId/override — permission gate', () => {
  it('returns 403 when the caller lacks data.write.identity', async () => {
    const res = await request(appWithPerms(['data.read']))
      .delete(`/identities/${VALID_ID}/members/${VALID_ID2}/override`);
    expect(res.status).toBe(403);
    expect(res.body.required).toContain('data.write.identity');
  });

  it('succeeds when the caller has data.write.identity', async () => {
    const res = await request(appWithPerms(['data.write.identity']))
      .delete(`/identities/${VALID_ID}/members/${VALID_ID2}/override`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

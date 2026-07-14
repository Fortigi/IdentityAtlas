/**
 * Unit tests for identities.js — analyst override endpoints and account-matrix.
 *
 * Covers the changes introduced in the identity-aggregate-view feature:
 * - PUT /identities/:id/members/:userId/override no longer requires a reason
 * - Both override endpoints use principalId (not userId) in the UPDATE WHERE clause
 * - GET /identities/:id/account-matrix is a new endpoint
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const VALID_ID  = '11111111-1111-1111-1111-111111111111';
const VALID_ID2 = '22222222-2222-2222-2222-222222222222';

// ── Mocks (hoisted so they are in place before the module initialises) ────────

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
  // Native #663 path (account-matrix in detail.js) — forward to the same mockReq
  // staging so query-order + SQL assertions still hold; normalise .recordset→.rows.
  timedQuery: async (_pool, _label, _res, text, params) => {
    const r = await mockReq.query(text, params);
    if (r == null) return r;
    const arr = r.rows ?? r.recordset ?? [];
    return { ...r, rows: arr, recordset: arr };
  },
  getQueryTimings: () => [],
}));

const { default: identitiesRouter } = await import('./identities.js');
const app = express().use(express.json()).use(identitiesRouter);

beforeEach(() => {
  vi.clearAllMocks();
  mockReq.input.mockReturnThis();
  mockReq.query.mockResolvedValue({ recordset: [] });
});

// ── GET /identities/:id/account-matrix ───────────────────────────────────────

describe('GET /identities/:id/account-matrix', () => {
  it('returns 400 for a non-UUID identity id', async () => {
    const res = await request(app).get('/identities/not-a-uuid/account-matrix');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid identity id/i);
  });

  it('returns accounts and memberships arrays', async () => {
    mockReq.query
      .mockResolvedValueOnce({ recordset: [{ id: VALID_ID2, displayName: 'Alice', accountType: 'admin', isPrimary: false }] })
      .mockResolvedValueOnce({ recordset: [{ principalId: VALID_ID2, resourceId: VALID_ID, membershipType: 'Direct' }] });

    const res = await request(app).get(`/identities/${VALID_ID}/account-matrix`);
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.memberships).toHaveLength(1);
    expect(res.body.accounts[0].displayName).toBe('Alice');
  });
});

// ── PUT /identities/:id/members/:userId/override ─────────────────────────────

describe('PUT /identities/:id/members/:userId/override', () => {
  it('returns 400 for an invalid identity UUID', async () => {
    const res = await request(app)
      .put(`/identities/bad-id/members/${VALID_ID2}/override`)
      .send({ action: 'confirmed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id format/i);
  });

  it('returns 400 for an invalid member UUID', async () => {
    const res = await request(app)
      .put(`/identities/${VALID_ID}/members/bad-id/override`)
      .send({ action: 'confirmed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid id format/i);
  });

  it('returns 400 for an unrecognised action', async () => {
    const res = await request(app)
      .put(`/identities/${VALID_ID}/members/${VALID_ID2}/override`)
      .send({ action: 'delete' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/confirmed.*rejected.*moved/i);
  });

  it('accepts confirmed without a reason', async () => {
    const res = await request(app)
      .put(`/identities/${VALID_ID}/members/${VALID_ID2}/override`)
      .send({ action: 'confirmed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, action: 'confirmed' });
  });

  it('accepts rejected without a reason', async () => {
    const res = await request(app)
      .put(`/identities/${VALID_ID}/members/${VALID_ID2}/override`)
      .send({ action: 'rejected' });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('rejected');
  });

  it('passes principalId (not userId) to the UPDATE query', async () => {
    await request(app)
      .put(`/identities/${VALID_ID}/members/${VALID_ID2}/override`)
      .send({ action: 'confirmed' });

    const querySql = mockReq.query.mock.calls[0][0];
    expect(querySql).toMatch(/"principalId"\s*=\s*@userId/);
    expect(querySql).not.toMatch(/"userId"\s*=/);
  });
});

// ── DELETE /identities/:id/members/:userId/override ──────────────────────────

describe('DELETE /identities/:id/members/:userId/override', () => {
  it('returns 400 for invalid UUIDs', async () => {
    const res = await request(app)
      .delete(`/identities/bad/members/${VALID_ID2}/override`);
    expect(res.status).toBe(400);
  });

  it('succeeds with valid UUIDs', async () => {
    const res = await request(app)
      .delete(`/identities/${VALID_ID}/members/${VALID_ID2}/override`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('uses principalId in the DELETE UPDATE query', async () => {
    await request(app)
      .delete(`/identities/${VALID_ID}/members/${VALID_ID2}/override`);

    const querySql = mockReq.query.mock.calls[0][0];
    expect(querySql).toMatch(/"principalId"\s*=\s*@userId/);
  });
});

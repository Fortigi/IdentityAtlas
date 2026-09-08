// Unit tests for routes/matrix/shares.js — matrix share links (#1166). DB mocked.
//
// The permission gate is a no-op here (auth disabled in the test env); the
// allow/deny matrix for `data.share` is covered by auth/permissionMatrix.test.js
// against the real app. What is tested here is the handler behaviour the gate
// lets through: snapshot validation, hash-only storage, the 404/410 split, the
// usage upsert, and idempotent revocation.
//
// Inputs are chosen to discriminate: a share is created with a NON-default
// displayMode/managed pair and an invalid one, so a handler that ignored the
// snapshot fields (or stored them unfiltered) fails.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../../test-utils/routeTestKit.js';
import { hashToken, generateShareToken } from '../../auth/shareTokens.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');
const { query, queryOne } = await import('../../db/connection.js');

const { default: router } = await import('./shares.js');
const app = mountRouter(router);

const SHARE_ID = '11111111-1111-1111-1111-111111111111';
const FILTER = { rowType: 'user', subject: { include: [{ column: 'department', values: ['Sales'] }] } };

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('POST /api/matrix/shares', () => {
  it('400s without a name', async () => {
    const res = await request(app).post('/api/matrix/shares').send({ filter: FILTER });
    expect(res.status).toBe(400);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('400s when the filter is missing or not an object', async () => {
    expect((await request(app).post('/api/matrix/shares').send({ name: 'Team' })).status).toBe(400);
    expect((await request(app).post('/api/matrix/shares').send({ name: 'Team', filter: 'nope' })).status).toBe(400);
    // An array is an object to typeof — it must still be rejected.
    expect((await request(app).post('/api/matrix/shares').send({ name: 'Team', filter: [] })).status).toBe(400);
  });

  it('201s with a one-time fgs_ token and stores only its hash + the snapshot', async () => {
    queryOne.mockResolvedValue({ id: SHARE_ID, name: 'Sales team', filter: FILTER });
    const res = await request(app)
      .post('/api/matrix/shares')
      .send({ name: '  Sales team  ', filter: FILTER, displayMode: 'rotated', managed: 'gaps' });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^fgs_[A-Za-z0-9_-]{20,}$/);

    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO "MatrixShares"/);
    expect(params[1]).toBe('Sales team');          // trimmed
    expect(params[2]).toEqual(FILTER);             // snapshot, verbatim
    expect(params[3]).toBe('rotated');             // display mode preserved
    expect(params[4]).toBe('gaps');                // managed toggle preserved
    expect(params[5]).toBe(hashToken(res.body.token));
    // The plaintext must never be a stored parameter.
    expect(params).not.toContain(res.body.token);
  });

  it('drops a displayMode / managed value the UI cannot render', async () => {
    queryOne.mockResolvedValue({ id: SHARE_ID });
    await request(app)
      .post('/api/matrix/shares')
      .send({ name: 'Odd', filter: FILTER, displayMode: 'hologram', managed: 'sometimes' });

    const params = queryOne.mock.calls[0][1];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  it('500s when the insert fails', async () => {
    queryOne.mockRejectedValue(new Error('boom'));
    const res = await request(app).post('/api/matrix/shares').send({ name: 'X', filter: FILTER });
    expect(res.status).toBe(500);
    expect(res.body.token).toBeUndefined();
  });
});

describe('GET /api/matrix/shares', () => {
  it('returns every share with its usage aggregate', async () => {
    const rows = [
      { id: SHARE_ID, name: 'Sales team', accessCount: 3, userCount: 2, usage: [{ userKey: 'mgr@x.com', accessCount: 2 }] },
      { id: '22222222-2222-2222-2222-222222222222', name: 'Never opened', accessCount: 0, userCount: 0, usage: [] },
    ];
    query.mockResolvedValue({ rows });
    const res = await request(app).get('/api/matrix/shares');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    // The token hash must not be selected into a list any analyst can read.
    expect(query.mock.calls[0][0]).not.toMatch(/tokenHash/);
  });

  it('500s when the list query fails', async () => {
    query.mockRejectedValue(new Error('boom'));
    expect((await request(app).get('/api/matrix/shares')).status).toBe(500);
  });
});

describe('POST /api/matrix/shares/:id/revoke', () => {
  it('400s on a malformed id', async () => {
    expect((await request(app).post('/api/matrix/shares/not-a-uuid/revoke')).status).toBe(400);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('404s when the share does not exist', async () => {
    queryOne.mockResolvedValue(null);
    expect((await request(app).post(`/api/matrix/shares/${SHARE_ID}/revoke`)).status).toBe(404);
  });

  it('soft-revokes and keeps the first revocation timestamp', async () => {
    queryOne.mockResolvedValue({ id: SHARE_ID, revokedAt: '2026-09-01T10:00:00Z', revokedBy: 'someone@x.com' });
    const res = await request(app).post(`/api/matrix/shares/${SHARE_ID}/revoke`);
    expect(res.status).toBe(200);
    expect(res.body.revokedAt).toBe('2026-09-01T10:00:00Z');
    const sql = queryOne.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE "MatrixShares"/);
    expect(sql).toMatch(/COALESCE\(s\."revokedAt", now\(\)\)/);
    expect(sql).not.toMatch(/DELETE/);
  });

  it('500s when the update fails', async () => {
    queryOne.mockRejectedValue(new Error('boom'));
    expect((await request(app).post(`/api/matrix/shares/${SHARE_ID}/revoke`)).status).toBe(500);
  });
});

describe('POST /api/matrix/shares/resolve', () => {
  const token = generateShareToken();

  it('404s a malformed token without touching the database', async () => {
    for (const bad of [undefined, '', 'fgs_', 'fgr_something', 42]) {
      const res = await request(app).post('/api/matrix/shares/resolve').send({ token: bad });
      expect(res.status).toBe(404);
    }
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('404s an unknown token', async () => {
    queryOne.mockResolvedValue(null);
    const res = await request(app).post('/api/matrix/shares/resolve').send({ token });
    expect(res.status).toBe(404);
    expect(queryOne.mock.calls[0][1]).toEqual([hashToken(token)]);
    expect(query).not.toHaveBeenCalled();   // no usage stamped for a miss
  });

  it('410s a revoked share and does not stamp usage', async () => {
    queryOne.mockResolvedValue({ id: SHARE_ID, name: 'Old', filter: FILTER, revokedAt: '2026-09-01T10:00:00Z' });
    const res = await request(app).post('/api/matrix/shares/resolve').send({ token });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/no longer shared/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns the snapshot and upserts the per-user usage row', async () => {
    queryOne.mockResolvedValue({
      id: SHARE_ID, shareType: 'matrix', name: 'Sales team', filter: FILTER,
      displayMode: 'rotated', managed: 'gaps', revokedAt: null,
    });
    query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/matrix/shares/resolve').send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: SHARE_ID, shareType: 'matrix', name: 'Sales team',
      filter: FILTER, displayMode: 'rotated', managed: 'gaps',
    });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO "MatrixShareAccesses"/);
    expect(sql).toMatch(/ON CONFLICT \("shareId", "userKey"\) DO UPDATE/);
    expect(sql).toMatch(/"accessCount"\s*=\s*"MatrixShareAccesses"\."accessCount" \+ 1/);
    // No signed-in user in the mocked request → the auth-off 'anonymous' key.
    expect(params).toEqual([SHARE_ID, 'anonymous']);
  });

  it('500s when the lookup fails', async () => {
    queryOne.mockRejectedValue(new Error('boom'));
    expect((await request(app).post('/api/matrix/shares/resolve').send({ token })).status).toBe(500);
  });
});

// Unit tests for routes/matrix/shares.js — matrix share links (#1166). DB mocked.
//
// The permission gate is a no-op here (auth disabled in the test env); the
// allow/deny matrix for `data.share` is covered by auth/permissionMatrix.test.js
// against the real app. What is tested here is the handler behaviour the gate
// lets through: snapshot validation, hash-only storage, the 404/410/403 split,
// the recipient gate, the usage upsert, and idempotent revocation.
//
// Inputs are chosen to discriminate: a share is created with a NON-default
// displayMode/managed pair and an invalid one, so a handler that ignored the
// snapshot fields (or stored them unfiltered) fails.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mountRouter } from '../../../test-utils/routeTestKit.js';
import { hashToken, generateShareToken } from '../../auth/shareTokens.js';

process.env.USE_SQL = 'true';

vi.mock('../../db/connection.js');
const { query, queryOne } = await import('../../db/connection.js');

// The recipient gate only engages on an auth-enabled install, so the flag has
// to be steerable per test.
vi.mock('../../config/authConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAuthEnabled: vi.fn(() => false),
}));
const { isAuthEnabled } = await import('../../config/authConfig.js');

const { default: router } = await import('./shares.js');
const app = mountRouter(router);

// The same router with a signed-in caller in front of it, for the paths that
// depend on WHO is asking.
function appAs(user) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = user; next(); });
  a.use('/api', router);
  return a;
}

const SHARE_ID = '11111111-1111-1111-1111-111111111111';
const FILTER = { rowType: 'user', subject: { include: [{ column: 'department', values: ['Sales'] }] } };
const RECIPIENTS = [{ principalId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', userKey: 'Ann@contoso.com', displayName: 'Ann Manager' }];

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });
afterEach(() => { isAuthEnabled.mockReturnValue(false); });

describe('POST /api/matrix/shares', () => {
  // The create path runs inside db.tx, whose mock forwards the client's calls
  // to the `query` spy: call 0 is the share insert, call 1 the recipient insert.
  function stageCreate(row = { id: SHARE_ID, name: 'Sales team', filter: FILTER }) {
    query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
  }

  it('400s without a name', async () => {
    const res = await request(app).post('/api/matrix/shares').send({ filter: FILTER, recipients: RECIPIENTS });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('400s when the filter is missing or not an object', async () => {
    const send = filter => request(app).post('/api/matrix/shares').send({ name: 'Team', filter, recipients: RECIPIENTS });
    expect((await send(undefined)).status).toBe(400);
    expect((await send('nope')).status).toBe(400);
    // An array is an object to typeof — it must still be rejected.
    expect((await send([])).status).toBe(400);
  });

  it('400s when nobody is named — a share is addressed, never open to the link', async () => {
    for (const recipients of [undefined, [], [{ userKey: '  ' }], ['']]) {
      const res = await request(app).post('/api/matrix/shares').send({ name: 'Team', filter: FILTER, recipients });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least one person/i);
    }
    // Nothing was written — no share exists that nobody could open.
    expect(query).not.toHaveBeenCalled();
  });

  it('201s with a one-time fgs_ token and stores only its hash + the snapshot', async () => {
    stageCreate();
    const res = await request(app)
      .post('/api/matrix/shares')
      .send({ name: '  Sales team  ', filter: FILTER, displayMode: 'rotated', managed: 'gaps', recipients: RECIPIENTS });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^fgs_[A-Za-z0-9_-]{20,}$/);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO "MatrixShares"/);
    expect(params[1]).toBe('Sales team');          // trimmed
    expect(params[2]).toEqual(FILTER);             // snapshot, verbatim
    expect(params[3]).toBe('rotated');             // display mode preserved
    expect(params[4]).toBe('gaps');                // managed toggle preserved
    expect(params[5]).toBe(hashToken(res.body.token));
    // The plaintext must never be a stored parameter.
    expect(params).not.toContain(res.body.token);
  });

  it('stores each named recipient against the new share, keyed for matching', async () => {
    stageCreate();
    const res = await request(app).post('/api/matrix/shares').send({
      name: 'Sales team', filter: FILTER,
      recipients: [...RECIPIENTS, { userKey: 'bob@contoso.com' }, { userKey: 'ANN@CONTOSO.COM' }],
    });

    expect(res.status).toBe(201);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO "MatrixShareRecipients"/);
    // The share id, then (principalId, userKey, displayName) per DEDUPED person:
    // the case-variant duplicate of Ann must not become a second row.
    expect(params).toEqual([
      params[0],
      '3fa85f64-5717-4562-b3fc-2c963f66afa6', 'ann@contoso.com', 'Ann Manager',
      null, 'bob@contoso.com', null,
    ]);
    // Both inserts name the same share.
    expect(params[0]).toBe(query.mock.calls[0][1][0]);
    // The response echoes who it was addressed to, so the UI can confirm it.
    expect(res.body.recipients.map(r => r.userKey)).toEqual(['ann@contoso.com', 'bob@contoso.com']);
  });

  it('drops a displayMode / managed value the UI cannot render', async () => {
    stageCreate({ id: SHARE_ID });
    await request(app)
      .post('/api/matrix/shares')
      .send({ name: 'Odd', filter: FILTER, displayMode: 'hologram', managed: 'sometimes', recipients: RECIPIENTS });

    const params = query.mock.calls[0][1];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  it('500s when the insert fails', async () => {
    query.mockRejectedValue(new Error('boom'));
    const res = await request(app).post('/api/matrix/shares').send({ name: 'X', filter: FILTER, recipients: RECIPIENTS });
    expect(res.status).toBe(500);
    expect(res.body.token).toBeUndefined();
  });
});

describe('GET /api/matrix/shares', () => {
  it('returns every share with its usage aggregate and the people it is for', async () => {
    const rows = [
      { id: SHARE_ID, name: 'Sales team', accessCount: 3, userCount: 2, usage: [{ userKey: 'mgr@x.com', accessCount: 2 }], recipients: [{ userKey: 'mgr@x.com', displayName: 'Mgr' }] },
      { id: '22222222-2222-2222-2222-222222222222', name: 'Never opened', accessCount: 0, userCount: 0, usage: [], recipients: [] },
    ];
    query.mockResolvedValue({ rows });
    const res = await request(app).get('/api/matrix/shares');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    const sql = query.mock.calls[0][0];
    // The token hash must not be selected into a list any analyst can read.
    expect(sql).not.toMatch(/tokenHash/);
    // "Shared with whom" comes from the recipient rows, not from usage.
    expect(sql).toMatch(/FROM "MatrixShareRecipients"/);
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

// The point of the feature: a link that is forwarded to somebody it wasn't
// meant for opens nothing. Auth is ON for this block — the check is skipped on
// an auth-disabled install, where there is no identity to match.
describe('POST /api/matrix/shares/resolve — recipient gate', () => {
  const token = generateShareToken();
  const SHARE = {
    id: SHARE_ID, shareType: 'matrix', name: 'Sales team', filter: FILTER,
    displayMode: null, managed: null, revokedAt: null, createdBy: 'analyst@contoso.com',
  };

  beforeEach(() => { isAuthEnabled.mockReturnValue(true); });

  // queryOne is called twice: the share lookup, then the recipient check.
  function stageResolve({ addressed }) {
    queryOne.mockResolvedValueOnce(SHARE).mockResolvedValueOnce(addressed ? { ok: 1 } : null);
    query.mockResolvedValue({ rows: [] });
  }

  it('opens the view for a named recipient and stamps their usage', async () => {
    stageResolve({ addressed: true });
    const res = await request(appAs({ preferred_username: 'Ann@Contoso.com' }))
      .post('/api/matrix/shares/resolve').send({ token });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Sales team');
    // Matched on the lower-cased sign-in name and (when present) the oid.
    const [sql, params] = queryOne.mock.calls[1];
    expect(sql).toMatch(/FROM "MatrixShareRecipients"/);
    expect(params).toEqual([SHARE_ID, ['ann@contoso.com'], null]);
    expect(query).toHaveBeenCalled();
  });

  it('403s somebody the link was forwarded to, and records no usage', async () => {
    stageResolve({ addressed: false });
    const res = await request(appAs({ preferred_username: 'stranger@contoso.com' }))
      .post('/api/matrix/shares/resolve').send({ token });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/specific people/i);
    // Not an opener — the usage log must stay clean.
    expect(query).not.toHaveBeenCalled();
  });

  it('matches on the directory object id, so a renamed recipient keeps access', async () => {
    stageResolve({ addressed: true });
    const oid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const res = await request(appAs({ oid: oid.toUpperCase(), preferred_username: 'ann.new@contoso.com' }))
      .post('/api/matrix/shares/resolve').send({ token });

    expect(res.status).toBe(200);
    expect(queryOne.mock.calls[1][1]).toEqual([SHARE_ID, ['ann.new@contoso.com'], oid]);
  });

  it('lets the sharer open their own link without listing themselves', async () => {
    queryOne.mockResolvedValueOnce(SHARE);
    query.mockResolvedValue({ rows: [] });
    const res = await request(appAs({ email: 'analyst@contoso.com' }))
      .post('/api/matrix/shares/resolve').send({ token });

    expect(res.status).toBe(200);
    // Short-circuited in memory — no recipient lookup was needed.
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('403s an anonymous caller on an auth-enabled install', async () => {
    stageResolve({ addressed: false });
    const res = await request(app).post('/api/matrix/shares/resolve').send({ token });
    expect(res.status).toBe(403);
    // No claims to match on — the lookup runs with an empty key list.
    expect(queryOne.mock.calls[1][1]).toEqual([SHARE_ID, [], null]);
  });
});

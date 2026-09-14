// Unit tests for routes/matrix/shares.js — matrix share links (#1166, #1202).
// DB mocked.
//
// The permission gate is a no-op here (auth disabled in the test env); the
// allow/deny matrix for `data.share` is covered by auth/permissionMatrix.test.js
// against the real app. What is tested here is the handler behaviour the gate
// lets through: the save+share merge and its 409s, recipient replacement, the
// 404/410/403 split, the recipient gate, the usage upsert, and idempotent
// revocation.
//
// Inputs are chosen to discriminate: a share is created with a NON-default
// displayMode/managed pair and an invalid one, so a handler that ignored the
// view-state fields (or stored them unfiltered) fails; resolve is driven with a
// LINKED share whose saved matrix disagrees with the frozen copy, so a handler
// that still answered from the snapshot fails.

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

// The matrixSharing flag gates the whole router. requireFeature's own resolution
// (override vs env, 404 body) is tested in featureFlags.test.js; here it is
// replaced by a gate steered per test, which records the flag it was built for.
const flagState = { on: true };
vi.mock('../../featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()),
  requireFeature: vi.fn(() => (_req, res, next) => (flagState.on
    ? next()
    : res.status(404).json({ error: 'This feature is not enabled' }))),
}));
const { requireFeature } = await import('../../featureFlags.js');

const { default: router } = await import('./shares.js');
// Captured at import: the gate is built once, when the router module loads.
const gatedFlags = requireFeature.mock.calls.map(c => c[0]);
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
const SAVED_ID = '44444444-4444-4444-4444-444444444444';
const FILTER = { rowType: 'user', subject: { include: [{ column: 'department', values: ['Sales'] }] } };
const RECIPIENTS = [{ principalId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', userKey: 'Ann@contoso.com', displayName: 'Ann Manager' }];

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });
afterEach(() => { isAuthEnabled.mockReturnValue(false); flagState.on = true; });

describe('with the matrixSharing flag off', () => {
  // Every route, resolve included: a link sent while sharing was on must stop
  // opening once it is switched off. None may touch the database.
  const token = generateShareToken();
  const calls = [
    ['create', () => request(app).post('/api/matrix/shares').send({ name: 'x', filter: FILTER, recipients: RECIPIENTS })],
    ['list', () => request(app).get('/api/matrix/shares')],
    ['revoke', () => request(app).post(`/api/matrix/shares/${SHARE_ID}/revoke`)],
    ['recipients', () => request(app).put(`/api/matrix/shares/${SHARE_ID}/recipients`).send({ recipients: RECIPIENTS })],
    ['resolve', () => request(app).post('/api/matrix/shares/resolve').send({ token })],
  ];

  it('is built for the matrixSharing flag', () => {
    expect(gatedFlags).toEqual(['matrixSharing']);
  });

  it.each(calls)('%s answers 404 without reading the database', async (_name, call) => {
    flagState.on = false;
    const res = await call();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'This feature is not enabled' });
    expect(query).not.toHaveBeenCalled();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('gates only the share paths, not the rest of the matrix router', async () => {
    flagState.on = false;
    const a = express();
    a.use('/api', router);
    a.get('/api/matrix/other', (_req, res) => res.json({ ok: true }));
    const res = await request(a).get('/api/matrix/other');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('POST /api/matrix/shares — save and share in one act (#1202)', () => {
  // The create path runs inside db.tx, whose mock forwards the client's calls
  // to the `query` spy: call 0 resolves the saved matrix (a SELECT when the
  // caller passed savedFilterId, an INSERT when they passed one name), call 1
  // is the share insert, call 2 the recipient insert.
  function stageNewMatrix(saved = { id: SAVED_ID, name: 'Sales team', filter: FILTER }) {
    query
      .mockResolvedValueOnce({ rows: [saved] })
      .mockResolvedValueOnce({ rows: [{ id: SHARE_ID, name: saved.name, savedFilterId: saved.id }] })
      .mockResolvedValueOnce({ rows: [] });
  }

  it('400s without a name when the matrix is not saved yet', async () => {
    const res = await request(app).post('/api/matrix/shares').send({ filter: FILTER, recipients: RECIPIENTS });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it('400s when the filter is missing or not an object', async () => {
    const send = filter => request(app).post('/api/matrix/shares').send({ name: 'Team', filter, recipients: RECIPIENTS });
    expect((await send(undefined)).status).toBe(400);
    expect((await send('nope')).status).toBe(400);
    // An array is an object to typeof — it must still be rejected.
    expect((await send([])).status).toBe(400);
  });

  it('400s on a malformed savedFilterId rather than silently saving a second copy', async () => {
    const res = await request(app).post('/api/matrix/shares')
      .send({ savedFilterId: 'not-a-uuid', recipients: RECIPIENTS });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/saved matrix id/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('400s when nobody is named — a share is addressed, never open to the link', async () => {
    for (const recipients of [undefined, [], [{ userKey: '  ' }], ['']]) {
      const res = await request(app).post('/api/matrix/shares').send({ name: 'Team', filter: FILTER, recipients });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least one person/i);
    }
    // Nothing was written — no stray saved matrix, no share nobody could open.
    expect(query).not.toHaveBeenCalled();
  });

  it('saves the matrix under the one name given, then shares it', async () => {
    stageNewMatrix();
    const res = await request(app)
      .post('/api/matrix/shares')
      .send({ name: '  Sales team  ', filter: FILTER, displayMode: 'rotated', managed: 'gaps', recipients: RECIPIENTS });

    expect(res.status).toBe(201);

    const [savedSql, savedParams] = query.mock.calls[0];
    expect(savedSql).toMatch(/INSERT INTO "SavedMatrixFilters"/);
    expect(savedParams[1]).toBe('Sales team');                     // trimmed, one name
    // The governed toggle is folded into the saved filter — the same shape the
    // wizard's own save writes, so there is one source of truth for it.
    expect(savedParams[2]).toEqual({ ...FILTER, managed: 'gaps' });

    const [shareSql, shareParams] = query.mock.calls[1];
    expect(shareSql).toMatch(/INSERT INTO "MatrixShares"/);
    expect(shareParams[1]).toBe('Sales team');     // at-share-time name, for history
    expect(shareParams[3]).toBe('rotated');        // display mode preserved
    expect(shareParams[4]).toBe('gaps');           // managed toggle preserved
    expect(shareParams[5]).toBe(SAVED_ID);         // …and it points at the saved matrix
  });

  it('mints no token — the link addresses the share by id, so it can be copied again later', async () => {
    stageNewMatrix();
    const res = await request(app).post('/api/matrix/shares')
      .send({ name: 'Sales team', filter: FILTER, recipients: RECIPIENTS });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeUndefined();
    expect(res.body.shareAddress).toBe(SHARE_ID);
    // No hash is stored either — there is no plaintext it could be the hash of.
    expect(query.mock.calls[1][0]).not.toMatch(/tokenHash/);
    expect(query.mock.calls[1][1].some(p => typeof p === 'string' && p.startsWith('fgs_'))).toBe(false);
  });

  it('shares an already-saved matrix without asking for a name again', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: SAVED_ID, name: 'Existing', filter: FILTER }] })
      .mockResolvedValueOnce({ rows: [{ id: SHARE_ID, name: 'Existing', savedFilterId: SAVED_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/matrix/shares')
      .send({ savedFilterId: SAVED_ID, recipients: RECIPIENTS });

    expect(res.status).toBe(201);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/SELECT id, "name", "filter" FROM "SavedMatrixFilters"/);
    expect(params).toEqual([SAVED_ID]);
    // Nothing was saved a second time, and the share took the matrix's own name.
    expect(query.mock.calls.some(([s]) => /INSERT INTO "SavedMatrixFilters"/.test(s))).toBe(false);
    expect(query.mock.calls[1][1][1]).toBe('Existing');
  });

  it('404s when the saved matrix it should share is gone', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/api/matrix/shares')
      .send({ savedFilterId: SAVED_ID, recipients: RECIPIENTS });
    expect(res.status).toBe(404);
  });

  it('409s on a name that is taken, naming it — never a silent overwrite', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'ix_SavedMatrixFilters_name' }));
    const res = await request(app).post('/api/matrix/shares')
      .send({ name: 'Sales team', filter: FILTER, recipients: RECIPIENTS });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/"Sales team" already exists/);
    expect(res.body.error).toMatch(/different name/i);
  });

  it('409s with a different message when the matrix already has a live share', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: SAVED_ID, name: 'Existing', filter: FILTER }] })
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'ix_MatrixShares_activeSavedFilter' }));
    const res = await request(app).post('/api/matrix/shares')
      .send({ savedFilterId: SAVED_ID, recipients: RECIPIENTS });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already shared/i);
    expect(res.body.error).not.toMatch(/different name/i);
  });

  it('stores each named recipient against the new share, keyed for matching', async () => {
    stageNewMatrix();
    const res = await request(app).post('/api/matrix/shares').send({
      name: 'Sales team', filter: FILTER,
      recipients: [...RECIPIENTS, { userKey: 'bob@contoso.com' }, { userKey: 'ANN@CONTOSO.COM' }],
    });

    expect(res.status).toBe(201);
    const [sql, params] = query.mock.calls[2];
    expect(sql).toMatch(/INSERT INTO "MatrixShareRecipients"/);
    // The share id, then (principalId, userKey, displayName) per DEDUPED person:
    // the case-variant duplicate of Ann must not become a second row.
    expect(params).toEqual([
      params[0],
      '3fa85f64-5717-4562-b3fc-2c963f66afa6', 'ann@contoso.com', 'Ann Manager',
      null, 'bob@contoso.com', null,
    ]);
    // Both inserts name the same share.
    expect(params[0]).toBe(query.mock.calls[1][1][0]);
    // The response echoes who it was addressed to, so the UI can confirm it.
    expect(res.body.recipients.map(r => r.userKey)).toEqual(['ann@contoso.com', 'bob@contoso.com']);
  });

  it('drops a displayMode / managed value the UI cannot render', async () => {
    stageNewMatrix({ id: SAVED_ID, name: 'Odd', filter: FILTER });
    await request(app)
      .post('/api/matrix/shares')
      .send({ name: 'Odd', filter: FILTER, displayMode: 'hologram', managed: 'sometimes', recipients: RECIPIENTS });

    // Neither on the share…
    const shareParams = query.mock.calls[1][1];
    expect(shareParams[3]).toBeNull();
    expect(shareParams[4]).toBeNull();
    // …nor folded into the saved matrix.
    expect(query.mock.calls[0][1][2]).toEqual(FILTER);
  });

  it('500s when the insert fails', async () => {
    query.mockRejectedValue(new Error('boom'));
    const res = await request(app).post('/api/matrix/shares').send({ name: 'X', filter: FILTER, recipients: RECIPIENTS });
    expect(res.status).toBe(500);
    expect(res.body.id).toBeUndefined();
  });
});

describe('PUT /api/matrix/shares/:id/recipients — adjust in place (#1202)', () => {
  it('400s on a malformed id', async () => {
    expect((await request(app).put('/api/matrix/shares/nope/recipients').send({ recipients: RECIPIENTS })).status).toBe(400);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('400s on an empty list — a share with nobody on it is unreachable', async () => {
    const res = await request(app).put(`/api/matrix/shares/${SHARE_ID}/recipients`).send({ recipients: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one person/i);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('404s an unknown or already-revoked share', async () => {
    queryOne.mockResolvedValue(null);
    const res = await request(app).put(`/api/matrix/shares/${SHARE_ID}/recipients`).send({ recipients: RECIPIENTS });
    expect(res.status).toBe(404);
    expect(queryOne.mock.calls[0][0]).toMatch(/"revokedAt" IS NULL/);
    expect(query).not.toHaveBeenCalled();
  });

  it('replaces the list and keeps the link: dropped people are deleted, the rest upserted', async () => {
    queryOne.mockResolvedValue({ id: SHARE_ID });
    query.mockResolvedValue({ rows: [] });

    const res = await request(app).put(`/api/matrix/shares/${SHARE_ID}/recipients`)
      .send({ recipients: [{ userKey: 'Bob@contoso.com', displayName: 'Bob' }] });

    expect(res.status).toBe(200);
    expect(res.body.recipients.map(r => r.userKey)).toEqual(['bob@contoso.com']);

    // The delete keeps only the people still named — Ann, who is no longer on
    // the list, is removed and the addressed-to gate turns her away at once.
    const [delSql, delParams] = query.mock.calls[0];
    expect(delSql).toMatch(/DELETE FROM "MatrixShareRecipients"/);
    expect(delParams).toEqual([SHARE_ID, ['bob@contoso.com']]);
    // Nothing re-mints the link: no token, no new share row.
    expect(query.mock.calls.some(([s]) => /INSERT INTO "MatrixShares"/.test(s))).toBe(false);
    expect(query.mock.calls[1][0]).toMatch(/INSERT INTO "MatrixShareRecipients"/);
    expect(query.mock.calls[1][0]).toMatch(/ON CONFLICT \("shareId", "userKey"\) DO UPDATE/);
  });

  it('500s when the replacement fails', async () => {
    queryOne.mockResolvedValue({ id: SHARE_ID });
    query.mockRejectedValue(new Error('boom'));
    const res = await request(app).put(`/api/matrix/shares/${SHARE_ID}/recipients`).send({ recipients: RECIPIENTS });
    expect(res.status).toBe(500);
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
    // The name shown is the saved matrix's live one, falling back to the
    // at-share-time copy for a legacy or orphaned share (#1202).
    expect(sql).toMatch(/COALESCE\(f\."name", s\."name"\) AS "name"/);
    expect(sql).toMatch(/LEFT JOIN "SavedMatrixFilters" f ON f\.id = s\."savedFilterId"/);
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

  it('404s a malformed address without touching the database', async () => {
    for (const bad of [undefined, '', 'fgs_', 'fgr_something', 42, 'not-a-uuid']) {
      const res = await request(app).post('/api/matrix/shares/resolve').send({ token: bad });
      expect(res.status).toBe(404);
    }
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('404s an unknown token, looked up by its hash only', async () => {
    queryOne.mockResolvedValue(null);
    const res = await request(app).post('/api/matrix/shares/resolve').send({ token });
    expect(res.status).toBe(404);
    // Hash arm armed, id arm null — a legacy link must never match by id.
    expect(queryOne.mock.calls[0][1]).toEqual([hashToken(token), null]);
    expect(query).not.toHaveBeenCalled();   // no usage stamped for a miss
  });

  it('resolves a new-style link by share id, without hashing anything', async () => {
    queryOne.mockResolvedValue({ id: SHARE_ID, name: 'Sales team', filter: FILTER, revokedAt: null });
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).post('/api/matrix/shares/resolve').send({ token: SHARE_ID });

    expect(res.status).toBe(200);
    expect(queryOne.mock.calls[0][1]).toEqual([null, SHARE_ID]);
  });

  it('410s a revoked share and does not stamp usage', async () => {
    queryOne.mockResolvedValue({ id: SHARE_ID, name: 'Old', filter: FILTER, revokedAt: '2026-09-01T10:00:00Z' });
    const res = await request(app).post('/api/matrix/shares/resolve').send({ token });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/no longer shared/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('answers with the LIVE saved matrix, not the frozen copy (#1202)', async () => {
    // The saved matrix has moved on since it was shared: a different name, a
    // different filter, a different governed toggle, and back to the grid. A
    // handler still answering from the share's own columns fails every line.
    const liveFilter = { ...FILTER, rowType: 'identity', managed: 'managed' };
    queryOne.mockResolvedValue({
      id: SHARE_ID, shareType: 'matrix', name: 'Renamed since', filter: FILTER,
      displayMode: 'rotated', managed: 'gaps', revokedAt: null,
      savedFilterId: SAVED_ID, liveFilter,
    });
    query.mockResolvedValue({ rows: [] });

    const res = await request(app).post('/api/matrix/shares/resolve').send({ token: SHARE_ID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: SHARE_ID, shareType: 'matrix', name: 'Renamed since',
      filter: liveFilter,
      // The saved filter's own orientation decides how it renders, so there is
      // no second display-mode field to disagree with it.
      displayMode: null,
      managed: 'managed',
    });
  });

  it('falls back to the snapshot when a linked matrix stores no governed toggle', async () => {
    queryOne.mockResolvedValue({
      id: SHARE_ID, shareType: 'matrix', name: 'Live', filter: FILTER,
      displayMode: 'rotated', managed: 'gaps', revokedAt: null,
      savedFilterId: SAVED_ID, liveFilter: FILTER,
    });
    query.mockResolvedValue({ rows: [] });
    const res = await request(app).post('/api/matrix/shares/resolve').send({ token: SHARE_ID });
    expect(res.body.managed).toBe('gaps');
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

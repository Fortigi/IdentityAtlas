// Tests for GET /api/auth-me's `me` payload — the signed-in user mapped onto
// crawled data (auth/resolveMe.js), plus the photo attached alongside it.
//
// This endpoint is the UI's bootstrap call: it gates every write control, and
// the header avatar and any first-person feature ("my groups") read `me` from
// it. So the cases that matter are the failure ones — a caller who matches
// nothing, and a photo lookup that breaks — neither of which may take the
// permission payload down with them.

import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.hoisted(() => { process.env.USE_SQL = 'true'; });
import request from 'supertest';

vi.mock('./config/authConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAuthEnabled: vi.fn(() => true),
}));
// Pass the request through with a fixed identity; the JWT path itself is
// covered by middleware/jwtValidation.test.js.
vi.mock('./middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal()),
  authMiddleware: (req, _res, next) => {
    req.user = { oid: 'p1', roles: ['Admin'], permissions: new Set(['*', 'data.read']) };
    next();
  },
  requirePermission: () => (_req, _res, next) => next(),
}));
vi.mock('./auth/resolveMe.js', () => ({
  resolveMe: vi.fn(),
  getPrincipalPhoto: vi.fn(),
  toPhotoDataUri: vi.fn(),
}));

const { createApp } = await import('./app.js');
const { isAuthEnabled } = await import('./config/authConfig.js');
const { resolveMe, getPrincipalPhoto } = await import('./auth/resolveMe.js');

const PRINCIPAL = { id: 'p1', displayName: 'Ada Lovelace', hasPhoto: false };
const PHOTO = 'data:image/jpeg;base64,AQID';

let app;
beforeEach(() => {
  vi.clearAllMocks();
  isAuthEnabled.mockReturnValue(true);
  app = createApp();
});

describe('GET /api/auth-me — me', () => {
  it('returns the resolved principal and identity', async () => {
    const identity = { id: 'i1', displayName: 'Ada Lovelace', accountCount: 2 };
    resolveMe.mockResolvedValue({ principal: PRINCIPAL, identity, matchedOn: 'oid' });

    const res = await request(app).get('/api/auth-me');

    expect(res.status).toBe(200);
    expect(res.body.me).toMatchObject({ principal: PRINCIPAL, identity, matchedOn: 'oid' });
  });

  it('does not read the photo when the principal has none', async () => {
    // The blob is TOASTed out of line; reading it for the (majority) of
    // accounts without one would be a wasted round trip on every bootstrap.
    resolveMe.mockResolvedValue({ principal: PRINCIPAL, identity: null, matchedOn: 'oid' });

    const res = await request(app).get('/api/auth-me');

    expect(getPrincipalPhoto).not.toHaveBeenCalled();
    expect(res.body.me.photo).toBeUndefined();
  });

  it('attaches the photo when the principal has one', async () => {
    resolveMe.mockResolvedValue({
      principal: { ...PRINCIPAL, hasPhoto: true }, identity: null, matchedOn: 'oid',
    });
    getPrincipalPhoto.mockResolvedValue(PHOTO);

    const res = await request(app).get('/api/auth-me');

    expect(res.body.me.photo).toBe(PHOTO);
    // Looked up by the principal the resolver returned, not by a token claim.
    expect(getPrincipalPhoto).toHaveBeenCalledWith(expect.anything(), 'p1');
  });

  it('still returns permissions when nothing in the crawled data matches', async () => {
    // A fresh deployment, or an admin who is not in the crawled tenant. The UI
    // must still learn what they may do.
    resolveMe.mockResolvedValue(null);

    const res = await request(app).get('/api/auth-me');

    expect(res.status).toBe(200);
    expect(res.body.me).toBeNull();
    expect(res.body.hasWildcard).toBe(true);
    expect(res.body.permissions).toContain('data.read');
  });

  it('keeps the rest of the payload when the photo lookup throws', async () => {
    // A missing face is cosmetic; losing this response would hide every write
    // control in the UI. The mapping itself must survive too.
    resolveMe.mockResolvedValue({
      principal: { ...PRINCIPAL, hasPhoto: true }, identity: null, matchedOn: 'oid',
    });
    getPrincipalPhoto.mockRejectedValue(new Error('pool exhausted'));

    const res = await request(app).get('/api/auth-me');

    expect(res.status).toBe(200);
    expect(res.body.me.principal).toEqual({ ...PRINCIPAL, hasPhoto: true });
    expect(res.body.me.photo).toBeUndefined();
    expect(res.body.hasWildcard).toBe(true);
  });

  it('reports me as null and resolves nobody when auth is disabled', async () => {
    // Open mode has no caller to map. Returning a stale or guessed identity
    // here would let the header show a face belonging to nobody in particular.
    isAuthEnabled.mockReturnValue(false);
    app = createApp();

    const res = await request(app).get('/api/auth-me');

    expect(res.body).toMatchObject({ enabled: false, me: null, hasWildcard: true });
    expect(resolveMe).not.toHaveBeenCalled();
  });
});

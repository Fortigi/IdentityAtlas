// Unit tests for the read-API-token path of authMiddleware.
//
// The JWT path is covered by the existing auth integration tests; here we
// pin the security-critical behaviours unique to the `fgr_…` credential:
//
//   - Accepted ONLY on GET requests (POST/PUT/PATCH/DELETE → 403).
//   - Accepted ONLY on non-admin paths (/api/admin/* → 403).
//   - Accepted ONLY when the token resolves to an active, non-expired,
//     non-revoked row in ReadApiKeys.
//   - Falls through to next() on success, attaching req.readToken so
//     downstream code can audit.
//
// Auth is enabled by mocking authConfig.isAuthEnabled() = true — otherwise
// the middleware short-circuits and these scoping checks never run.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks. Vitest lifts vi.mock calls to the top of the module.
const findActive = vi.fn();
vi.mock('../auth/readTokens.js', async () => {
  const actual = await vi.importActual('../auth/readTokens.js');
  return {
    ...actual,
    findActiveByPlaintext: (...args) => findActive(...args),
  };
});

const isAuthEnabledMock = vi.fn(() => true);
vi.mock('../config/authConfig.js', () => ({
  isAuthEnabled: (...args) => isAuthEnabledMock(...args),
  getJwksClient: () => null,
  getTenantId: () => 'test-tenant',
  getClientId: () => 'test-client',
  getRequiredRoles: () => [],
}));

const { authMiddleware } = await import('./auth.js');

// Minimal express-ish req/res/next stand-ins. res captures status + json body.
function makeReq({ path = '/api/users', method = 'GET', token }) {
  return {
    path,
    method,
    originalUrl: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}
function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return res;
}
async function run(req) {
  const res = makeRes();
  let called = false;
  const next = () => { called = true; };
  authMiddleware(req, res, next);
  // authMiddleware's fgr_ path is async (promise resolves off the call
  // stack) — give the microtask queue a tick to drain before asserting.
  await new Promise(r => setImmediate(r));
  return { res, nextCalled: called };
}

beforeEach(() => {
  findActive.mockReset();
  isAuthEnabledMock.mockReturnValue(true);
});

const GOOD_TOKEN = 'fgr_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdefg';

describe('authMiddleware — fgr_ token on GET non-admin endpoints', () => {
  it('accepts and calls next() when the token is active', async () => {
    findActive.mockResolvedValue({ id: 7, name: 'Analyst workbook', expiresAt: null, revoked: false });
    const { res, nextCalled } = await run(makeReq({ token: GOOD_TOKEN }));
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('rejects with 401 when the token is unknown', async () => {
    findActive.mockResolvedValue(null);
    const { res, nextCalled } = await run(makeReq({ token: GOOD_TOKEN }));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('attaches req.readToken on success so downstream code can audit', async () => {
    findActive.mockResolvedValue({ id: 7, name: 'CI export', expiresAt: null, revoked: false });
    const req = makeReq({ token: GOOD_TOKEN });
    await run(req);
    expect(req.readToken).toEqual({ id: 7, name: 'CI export' });
  });
});

describe('authMiddleware — fgr_ token scoping', () => {
  it('rejects any method other than GET with 403', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      findActive.mockResolvedValue({ id: 7, name: 'x', expiresAt: null, revoked: false });
      const { res, nextCalled } = await run(makeReq({ method, token: GOOD_TOKEN }));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toMatch(/GET/);
    }
  });

  it('rejects any /api/admin/* path with 403 (even on GET)', async () => {
    findActive.mockResolvedValue({ id: 7, name: 'x', expiresAt: null, revoked: false });
    for (const path of ['/api/admin/read-tokens', '/api/admin/crawlers', '/api/admin/export/curated']) {
      const { res, nextCalled } = await run(makeReq({ path, token: GOOD_TOKEN }));
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toMatch(/admin/i);
    }
  });

  it('short-circuits: admin-path check happens before the DB lookup', async () => {
    // Defence in depth: even with a valid token, never touch the DB on a
    // path we're going to reject anyway. Keeps a leaked token that's
    // pointed at admin endpoints from driving load on ReadApiKeys.
    findActive.mockResolvedValue({ id: 7, name: 'x', expiresAt: null, revoked: false });
    await run(makeReq({ path: '/api/admin/anything', token: GOOD_TOKEN }));
    expect(findActive).not.toHaveBeenCalled();
  });

  it('short-circuits: method check happens before the DB lookup', async () => {
    findActive.mockResolvedValue({ id: 7, name: 'x', expiresAt: null, revoked: false });
    await run(makeReq({ method: 'POST', token: GOOD_TOKEN }));
    expect(findActive).not.toHaveBeenCalled();
  });
});

describe('authMiddleware — auth disabled bypass', () => {
  it('skips all checks entirely when isAuthEnabled() is false', async () => {
    isAuthEnabledMock.mockReturnValue(false);
    // No token at all — still should call next.
    const { res, nextCalled } = await run(makeReq({ token: null }));
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
    expect(findActive).not.toHaveBeenCalled();
  });
});

describe('authMiddleware — header hygiene', () => {
  it('returns 401 when no Authorization header is set and auth is on', async () => {
    const { res, nextCalled } = await run(makeReq({ token: null }));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the header does not start with Bearer', async () => {
    const req = {
      path: '/api/users', method: 'GET', originalUrl: '/api/users',
      headers: { authorization: GOOD_TOKEN },  // missing "Bearer "
    };
    const { res, nextCalled } = await run(req);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

// Unit tests for the requirePermission() gate factory in middleware/auth.js.
//
// These pin the gate's decision logic in isolation (no HTTP, no routers):
//   - open mode (auth disabled) → always next()
//   - wildcard '*' → next()
//   - has one of the required permissions → next()
//   - missing all required → 403 (and reports `required`/`have`)
//   - fgr_ read token → only data.read endpoints
//   - no resolved permissions → 403 (fail closed, not crash)
//
// The route-level wiring (which endpoint requires which permission) is covered
// end-to-end in auth/permissionMatrix.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const isAuthEnabledMock = vi.fn(() => true);
vi.mock('../config/authConfig.js', () => ({
  isAuthEnabled: (...a) => isAuthEnabledMock(...a),
  getJwksClient: () => null,
  getTenantId: () => 'test-tenant',
  getClientId: () => 'test-client',
  getRequiredRoles: () => null,
  getRolePermissions: () => ({}),
}));

const { requirePermission } = await import('./auth.js');

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}
function run(gate, req) {
  const res = makeRes();
  let nextCalled = false;
  gate(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}
const userWith = (...perms) => ({ user: { permissions: new Set(perms) } });

beforeEach(() => isAuthEnabledMock.mockReturnValue(true));

describe('requirePermission — construction', () => {
  it('throws if called with no permission names', () => {
    expect(() => requirePermission()).toThrow(/at least one permission/i);
  });
});

describe('requirePermission — decision logic', () => {
  it('calls next() in open mode regardless of permissions', () => {
    isAuthEnabledMock.mockReturnValue(false);
    const { nextCalled, res } = run(requirePermission('admin.crawlers'), {});
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('calls next() when the user holds the required permission', () => {
    const { nextCalled } = run(requirePermission('admin.crawlers'), userWith('admin.crawlers'));
    expect(nextCalled).toBe(true);
  });

  it('calls next() when the user holds ANY of several required permissions', () => {
    const { nextCalled } = run(requirePermission('admin.systems', 'admin.crawlers'), userWith('admin.crawlers'));
    expect(nextCalled).toBe(true);
  });

  it('calls next() for a wildcard user', () => {
    const { nextCalled } = run(requirePermission('admin.crawlers'), userWith('*'));
    expect(nextCalled).toBe(true);
  });

  it('403s when the user lacks the required permission (and reports it)', () => {
    const { nextCalled, res } = run(requirePermission('admin.crawlers'), userWith('data.read'));
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.required).toContain('admin.crawlers');
    expect(res.body.have).toContain('data.read');
  });

  it('403s (fail closed) when no permissions were resolved at all', () => {
    const { nextCalled, res } = run(requirePermission('admin.crawlers'), { user: {} });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe('requirePermission — fgr_ read tokens', () => {
  it('allows a read token on a data.read endpoint', () => {
    const { nextCalled } = run(requirePermission('data.read'), { readToken: { id: 1, name: 'wb' } });
    expect(nextCalled).toBe(true);
  });

  it('403s a read token on a non-data.read endpoint', () => {
    const { nextCalled, res } = run(requirePermission('admin.read-tokens'), { readToken: { id: 1, name: 'wb' } });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

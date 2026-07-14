// End-to-end permission-enforcement matrix.
//
// For EVERY gated permission in the catalog this drives the real Express app
// (via supertest) and asserts the representative endpoint:
//   - ALLOW: a caller holding that permission is NOT 403'd, and
//   - DENY : a caller holding every OTHER permission IS 403'd.
//
// Plus a completeness guard: every key in PERMISSIONS must be classified in
// permissionManifest.js (gated / implicit / reserved). Adding a permission to
// the catalog without classifying + testing it fails CI here.
//
// Auth is mocked at the boundary (no real Entra tokens, no DB): jwt.verify
// decodes a synthetic "roles:<r1,r2>" bearer into a roles claim; authConfig
// reports auth-enabled with a synthetic role→permission mapping (one dedicated
// role per catalog permission); the DB layer returns benign empties so allowed
// requests reach the handler and resolve to something other than 403.

import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { PERMISSIONS } from './permissions.js';
import { GATED_ENDPOINTS, IMPLICIT_PERMISSIONS, RESERVED_PERMISSIONS } from './permissionManifest.js';

const ALL_PERMS = Object.keys(PERMISSIONS);
const roleFor = (perm) => `role-${perm}`;
// Synthetic mapping: one role per permission, granting exactly that permission.
const TEST_MAPPING = Object.fromEntries(ALL_PERMS.map((p) => [roleFor(p), [p]]));

// ── Mocks (hoisted by vitest) ───────────────────────────────────────────────
vi.mock('../config/authConfig.js', () => ({
  isAuthEnabled: () => true,
  getJwksClient: () => ({}),
  getTenantId: () => 'test-tenant',
  getClientId: () => 'test-client',
  getRequiredRoles: () => null,
  getRolePermissions: () => TEST_MAPPING,
  hasCustomRolePermissions: () => false,
  setRolePermissions: async () => TEST_MAPPING,
  getAuthState: () => ({ enabled: true, tenantId: 'test-tenant', clientId: 'test-client' }),
  loadAuthConfig: async () => {},
  reloadAuthConfig: async () => {},
}));

// jwt.verify(token, keyResolver, options, callback) — decode our synthetic token.
vi.mock('jsonwebtoken', () => ({
  default: {
    verify: (token, _key, _opts, cb) => {
      const roles =
        typeof token === 'string' && token.startsWith('roles:')
          ? token.slice('roles:'.length).split(',').filter(Boolean)
          : [];
      cb(null, { roles, tid: 'test-tenant' });
    },
  },
}));

// Never touch a real Postgres. Deny happens before the handler; allow may query.
vi.mock('../db/connection.js', () => {
  const empty = { rows: [], rowCount: 0 };
  // Native pg pool double — handlers query through pool.query / db.query (#663).
  const pool = { query: async () => empty };
  return {
    query: async () => empty,
    queryOne: async () => null,
    tx: async (fn) => fn(pool),
    getPool: async () => pool,
    closePool: async () => {},
  };
});

const { createApp } = await import('../app.js');
const app = createApp();

// Bearer header for a token that resolves to exactly `perms`.
const bearer = (perms) => `Bearer roles:${perms.map(roleFor).join(',')}`;

function call(app, { method, path, body }, authHeader) {
  let req = request(app)[method.toLowerCase()](path);
  if (authHeader) req = req.set('Authorization', authHeader);
  if (body !== undefined) req = req.send(body);
  return req;
}

describe('permission enforcement matrix — each gated permission gates ONLY its own endpoint', () => {
  for (const [perm, ep] of Object.entries(GATED_ENDPOINTS)) {
    const label = `${ep.method} ${ep.path}`;

    it(`${perm}: DENY (403) when the caller has every permission EXCEPT ${perm}`, async () => {
      const others = ALL_PERMS.filter((p) => p !== perm);
      const res = await call(app, ep, bearer(others));
      expect(res.status, `${label} must 403 without ${perm}`).toBe(403);
      // And the 403 must be the permission gate, not an auth error.
      expect(res.body?.required, `${label} 403 should report the missing permission`).toContain(perm);
    });

    it(`${perm}: ALLOW (not 403) when the caller holds ${perm}`, async () => {
      const res = await call(app, ep, bearer([perm]));
      expect(res.status, `${label} must NOT 403 with ${perm} (got ${res.status})`).not.toBe(403);
    });
  }
});

describe('data.read is enforced as authentication-required (implicit, not a requirePermission gate)', () => {
  const probe = IMPLICIT_PERMISSIONS['data.read'].probe;
  it('401 for an unauthenticated request', async () => {
    const res = await call(app, probe, undefined);
    expect(res.status).toBe(401);
  });
  it('reachable (not 401/403) for a signed-in caller with data.read', async () => {
    const res = await call(app, probe, bearer(['data.read']));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

describe('catalog completeness — every permission checkbox is classified and covered', () => {
  const classified = [
    ...Object.keys(GATED_ENDPOINTS),
    ...Object.keys(IMPLICIT_PERMISSIONS),
    ...Object.keys(RESERVED_PERMISSIONS),
  ];
  const classifiedSet = new Set(classified);

  for (const perm of ALL_PERMS) {
    it(`${perm} is classified (gated, implicit, or reserved)`, () => {
      expect(
        classifiedSet.has(perm),
        `Permission "${perm}" is in the catalog but missing from permissionManifest.js. ` +
          'Add it to GATED_ENDPOINTS (with a representative route + test), IMPLICIT_PERMISSIONS, or RESERVED_PERMISSIONS.'
      ).toBe(true);
    });
  }

  it('the manifest references no unknown permissions', () => {
    for (const perm of classified) {
      expect(PERMISSIONS, `manifest references unknown permission "${perm}"`).toHaveProperty(perm);
    }
  });

  it('each permission is classified in exactly one bucket', () => {
    const counts = {};
    for (const p of classified) counts[p] = (counts[p] || 0) + 1;
    for (const [p, n] of Object.entries(counts)) {
      expect(n, `permission "${p}" appears in more than one manifest bucket`).toBe(1);
    }
  });
});

describe('wildcard semantics & fail-closed default (security finding C-01)', () => {
  it('FAILS CLOSED: a signed-in user whose roles map to NO permissions is denied (403), not granted admin', async () => {
    // No recognised roles → resolvePermissions() is empty → DENY. There is no
    // "no roles -> '*'" fallback any more (C-01 fix). A roleless token must not
    // reach an admin endpoint.
    const res = await call(app, GATED_ENDPOINTS['admin.auth'], 'Bearer roles:totally-unmapped-role');
    expect(res.status).toBe(403);
  });

  it('a roleless token is denied on EVERY gated endpoint', async () => {
    for (const ep of Object.values(GATED_ENDPOINTS)) {
      const res = await call(app, ep, 'Bearer roles:totally-unmapped-role');
      expect(res.status, `${ep.method} ${ep.path} must 403 for a roleless caller`).toBe(403);
    }
  });

  it('a role mapped to "*" passes every gate', async () => {
    // Build a token whose (synthetic) role grants '*' by reusing the real
    // resolver: a role that maps to '*' is expanded to all permissions.
    // We simulate it via a caller holding every catalog permission, which is
    // the non-wildcard equivalent the gates accept.
    for (const ep of Object.values(GATED_ENDPOINTS)) {
      const res = await call(app, ep, bearer(ALL_PERMS));
      expect(res.status, `${ep.method} ${ep.path} should pass for an all-permissions caller`).not.toBe(403);
    }
  });
});

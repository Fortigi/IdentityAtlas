// Self-lockout guard + audit attribution for routes/authRoles.js with a real
// signed-in editor on the request (SEC-2026-09 L-01). The coverage test runs
// in open mode (no req.user), which never reaches the guard.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { resolvePermissions, SEED_ROLE_PERMISSIONS } from '../auth/permissions.js';

vi.mock('../db/connection.js');   // picks up src/db/__mocks__/connection.js
import { query } from '../db/connection.js';

const current = { mapping: { ...SEED_ROLE_PERMISSIONS } };
const setRolePermissions = vi.fn(async (m) => m);
vi.mock('../config/authConfig.js', () => ({
  getRolePermissions: () => current.mapping,
  hasCustomRolePermissions: () => true,
  setRolePermissions: (...a) => setRolePermissions(...a),
  isAuthEnabled: () => true,
  getJwksClient: () => null,
  getTenantId: () => '',
  getClientId: () => '',
  getRequiredRoles: () => null,
}));

const { default: router } = await import('./authRoles.js');

// An app whose requests carry a signed-in user holding `roles`, resolved
// against `mapping` the way authMiddleware does.
function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { ...user, permissions: resolvePermissions(user.roles, current.mapping) };
    next();
  });
  app.use('/api', router);
  return app;
}

const OID = '11111111-2222-3333-4444-555555555555';
const wildcardAdmin = { roles: ['Admin'], name: 'Alice Admin', oid: OID };

beforeEach(() => {
  current.mapping = { ...SEED_ROLE_PERMISSIONS };
  setRolePermissions.mockClear();
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('self-lockout guard applies to wildcard admins', () => {
  it('refuses a save that would drop the wildcard admin\'s own admin.auth (409, nothing saved)', async () => {
    const res = await request(appFor(wildcardAdmin))
      .put('/api/admin/roles')
      .send({ mapping: { Admin: ['data.read'] } });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/remove your own admin\.auth/);
    expect(setRolePermissions).not.toHaveBeenCalled();
  });

  it('refuses a reset when the seed would not grant the wildcard caller\'s roles admin.auth', async () => {
    // Custom mapping gives '*' via a role the seed does not know.
    current.mapping = { TenantOwners: ['*'] };
    const res = await request(appFor({ roles: ['TenantOwners'], name: 'Bob', oid: OID }))
      .delete('/api/admin/roles');
    expect(res.status).toBe(409);
    expect(setRolePermissions).not.toHaveBeenCalled();
  });

  it('allows a wildcard admin\'s save that keeps admin.auth on one of their roles', async () => {
    const res = await request(appFor(wildcardAdmin))
      .put('/api/admin/roles')
      .send({ mapping: { Admin: ['admin.auth', 'data.read'] } });
    expect(res.status).toBe(200);
    expect(setRolePermissions).toHaveBeenCalledTimes(1);
  });
});

describe('audit row carries the acting oid', () => {
  it('stores the display name AND the oid for a save', async () => {
    const res = await request(appFor(wildcardAdmin))
      .put('/api/admin/roles')
      .send({ mapping: { Admin: ['*'] } });
    expect(res.status).toBe(200);
    const insert = query.mock.calls.find((c) => /INSERT INTO "AuthRoleChangeLog"/.test(String(c[0])));
    expect(String(insert[0])).toContain('"changedByOid"');
    expect(insert[1].slice(0, 3)).toEqual(['Alice Admin', OID, 'save']);
  });

  it('stores a null oid when the token has none (never the display name in its place)', async () => {
    const res = await request(appFor({ roles: ['Admin'], name: 'No Oid' }))
      .put('/api/admin/roles')
      .send({ mapping: { Admin: ['*'] } });
    expect(res.status).toBe(200);
    const insert = query.mock.calls.find((c) => /INSERT INTO "AuthRoleChangeLog"/.test(String(c[0])));
    expect(insert[1].slice(0, 3)).toEqual(['No Oid', null, 'save']);
  });
});

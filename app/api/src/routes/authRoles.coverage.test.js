// Unit tests for routes/authRoles.js — role→permission mapping admin surface.
// authConfig (the persistence layer) is mocked; the real permissions catalog
// drives validation. Auth is disabled by default so requirePermission passes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { mountRouter } from '../../test-utils/routeTestKit.js';

process.env.USE_SQL = 'true';

const query = vi.fn();
const queryOne = vi.fn();
vi.mock('../db/connection.js', () => ({
  query: (...a) => query(...a),
  queryOne: (...a) => queryOne(...a),
  default: {},
}));

const getRolePermissions = vi.fn(() => ({ Admin: ['*'] }));
const hasCustomRolePermissions = vi.fn(() => false);
const setRolePermissions = vi.fn(async () => ({ Admin: ['*'] }));
vi.mock('../config/authConfig.js', () => ({
  getRolePermissions: (...a) => getRolePermissions(...a),
  hasCustomRolePermissions: (...a) => hasCustomRolePermissions(...a),
  setRolePermissions: (...a) => setRolePermissions(...a),
  // middleware/auth.js (used by requirePermission) imports these — keep auth
  // disabled so the gate is a pass-through.
  isAuthEnabled: () => false,
  getJwksClient: () => null,
  getTenantId: () => '',
  getClientId: () => '',
  getRequiredRoles: () => null,
}));

const { default: router } = await import('./authRoles.js');
const app = mountRouter(router);

beforeEach(() => {
  getRolePermissions.mockClear();
  hasCustomRolePermissions.mockClear();
  setRolePermissions.mockClear();
  setRolePermissions.mockResolvedValue({ Admin: ['*'] });
});

describe('GET /admin/roles', () => {
  it('returns the snapshot', async () => {
    const res = await request(app).get('/api/admin/roles');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('catalog');
    expect(res.body).toHaveProperty('groups');
    expect(res.body).toHaveProperty('mapping');
    expect(Array.isArray(res.body.catalog)).toBe(true);
  });
});

describe('PUT /admin/roles validation', () => {
  it('400 when mapping not an object', async () => {
    const res = await request(app).put('/api/admin/roles').send({ mapping: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400 when mapping is an array', async () => {
    const res = await request(app).put('/api/admin/roles').send({ mapping: [] });
    expect(res.status).toBe(400);
  });

  it('400 when a role maps to a non-array', async () => {
    const res = await request(app).put('/api/admin/roles').send({ mapping: { Admin: 'x' } });
    expect(res.status).toBe(400);
  });

  it('400 on a non-string permission entry', async () => {
    const res = await request(app).put('/api/admin/roles').send({ mapping: { Admin: [123] } });
    expect(res.status).toBe(400);
  });

  it('400 on an unknown permission', async () => {
    const res = await request(app).put('/api/admin/roles').send({ mapping: { Admin: ['nope.invalid'] } });
    expect(res.status).toBe(400);
  });

  it('saves a valid mapping', async () => {
    setRolePermissions.mockResolvedValueOnce({ Admin: ['admin.auth'] });
    const res = await request(app).put('/api/admin/roles').send({ mapping: { Admin: ['admin.auth'] } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(setRolePermissions).toHaveBeenCalled();
  });

  it('500 when save rejects', async () => {
    setRolePermissions.mockRejectedValueOnce(new Error('db'));
    const res = await request(app).put('/api/admin/roles').send({ mapping: { Admin: ['admin.auth'] } });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /admin/roles', () => {
  it('resets to seed', async () => {
    const res = await request(app).delete('/api/admin/roles');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, isCustom: false });
    expect(setRolePermissions).toHaveBeenCalledWith(null);
  });

  it('500 when reset rejects', async () => {
    setRolePermissions.mockRejectedValueOnce(new Error('db'));
    const res = await request(app).delete('/api/admin/roles');
    expect(res.status).toBe(500);
  });
});

// Round-trip test: "uncheck a permission box → access actually changes."
//
// Unlike permissionMatrix.test.js (which INJECTS a synthetic mapping), this
// uses the REAL authConfig: it drives setRolePermissions() — exactly what the
// Admin → Roles & Permissions save does — and asserts the live app's gates
// change accordingly, with no restart. It also confirms a saved mapping is
// persisted (to WorkerConfig) and survives a config reload.
//
// Still no Entra tenant required: jwt.verify is mocked to decode a synthetic
// "roles:<role>" bearer, and the DB layer is a small in-memory stand-in that
// stores the AUTH_ROLE_PERMISSIONS row so reloadAuthConfig() can read it back.

import { describe, it, expect, afterAll } from 'vitest';
import { vi } from 'vitest';
import request from 'supertest';

const TENANT = '00000000-0000-0000-0000-000000000000';

// authConfig captures USE_SQL at import and AUTH_* at loadAuthConfig() — both of
// which run at this module's top level (below), BEFORE any beforeAll hook. So we
// must set the env here, in source order, before the dynamic imports.
const ORIG = {};
for (const k of ['USE_SQL', 'AUTH_ENABLED', 'AUTH_TENANT_ID', 'AUTH_CLIENT_ID']) ORIG[k] = process.env[k];
process.env.USE_SQL = 'true';
process.env.AUTH_ENABLED = 'true';
process.env.AUTH_TENANT_ID = TENANT;
process.env.AUTH_CLIENT_ID = '11111111-1111-1111-1111-111111111111';
afterAll(() => {
  for (const k of Object.keys(ORIG)) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

// jwt.verify → decode our synthetic token into a roles claim (real authConfig
// resolves those roles to permissions, so the mapping under test is exercised).
vi.mock('jsonwebtoken', () => ({
  default: {
    verify: (token, _key, _opts, cb) => {
      const roles =
        typeof token === 'string' && token.startsWith('roles:')
          ? token.slice('roles:'.length).split(',').filter(Boolean)
          : [];
      cb(null, { roles, tid: '00000000-0000-0000-0000-000000000000' });
    },
  },
}));

// In-memory WorkerConfig so setRolePermissions() persists and reloadAuthConfig()
// reads back. All other queries return empty so route handlers don't crash.
vi.mock('../db/connection.js', () => {
  const workerConfig = new Map(); // configKey -> configValue
  const empty = { rows: [], rowCount: 0, recordset: [] };
  const poolish = { query: async () => empty, request: () => ({ input() { return this; }, query: async () => empty }) };
  return {
    query: async (sql, params = []) => {
      const s = String(sql);
      if (s.includes('FROM "WorkerConfig"') && s.includes('SELECT')) {
        const rows = [...workerConfig.entries()].map(([configKey, configValue]) => ({ configKey, configValue }));
        return { rows, rowCount: rows.length };
      }
      if (s.includes('INSERT INTO "WorkerConfig"')) {
        workerConfig.set('AUTH_ROLE_PERMISSIONS', params[0]); // setRolePermissions VALUES ('AUTH_ROLE_PERMISSIONS', $1)
        return empty;
      }
      if (s.includes('DELETE FROM "WorkerConfig"')) {
        workerConfig.delete('AUTH_ROLE_PERMISSIONS');
        return empty;
      }
      return empty;
    },
    queryOne: async () => null,
    tx: async (fn) => fn(poolish),
    getPool: async () => poolish,
    closePool: async () => {},
  };
});

const authConfig = await import('../config/authConfig.js');
const { createApp } = await import('../app.js');

await authConfig.loadAuthConfig(); // enabled via env; seed mapping until a save
const app = createApp();

const get = (path, role) => request(app).get(path).set('Authorization', `Bearer roles:${role}`);

describe('role→permission mapping round-trip (real authConfig, live gates)', () => {
  it('granting a permission makes the endpoint reachable; revoking it returns 403 — no restart', async () => {
    // Grant a custom "Auditor" role just admin.crawlers (as if ticking that box).
    await authConfig.setRolePermissions({ Auditor: ['admin.crawlers'] });
    let res = await get('/api/admin/crawlers', 'Auditor');
    expect(res.status, 'Auditor with admin.crawlers should reach /api/admin/crawlers').not.toBe(403);

    // Untick admin.crawlers (leave only data.read). Save takes effect immediately.
    await authConfig.setRolePermissions({ Auditor: ['data.read'] });
    res = await get('/api/admin/crawlers', 'Auditor');
    expect(res.status, 'Auditor without admin.crawlers should be 403').toBe(403);
    expect(res.body?.required).toContain('admin.crawlers');
  });

  it('a different permission box is independent (admin.llm grants llm config, not crawlers)', async () => {
    await authConfig.setRolePermissions({ Auditor: ['admin.llm'] });
    const llm = await get('/api/admin/llm/config', 'Auditor');
    expect(llm.status, 'admin.llm should reach llm config').not.toBe(403);
    const crawlers = await get('/api/admin/crawlers', 'Auditor');
    expect(crawlers.status, 'admin.llm must NOT grant crawlers').toBe(403);
  });

  it('a saved mapping persists and survives a config reload', async () => {
    await authConfig.setRolePermissions({ Auditor: ['admin.systems'] });
    await authConfig.reloadAuthConfig(); // re-reads WorkerConfig from the in-memory DB
    expect(authConfig.getRolePermissions().Auditor).toEqual(['admin.systems']);
    expect(authConfig.hasCustomRolePermissions()).toBe(true);
  });

  it('clearing the mapping reverts to the built-in seed', async () => {
    await authConfig.setRolePermissions(null);
    await authConfig.reloadAuthConfig();
    expect(authConfig.hasCustomRolePermissions()).toBe(false);
    expect(authConfig.getRolePermissions().Admin).toContain('*'); // seed Admin = ['*']
  });
});

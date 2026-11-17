// ROLE → PERMISSION MAPPING, LIVE — sign-in ON, real PostgreSQL, real HTTP.
//
// Admin → Roles & Permissions saves the mapping through PUT/DELETE
// /api/admin/roles. The other sign-in-ON suites pin getRolePermissions() to a
// fixed map, so none of them shows that a saved mapping is what the next request
// is judged by. Here only the token check is replaced
// (test-utils/signInOnLiveMapping.js); the mapping, its persistence in
// WorkerConfig and the middleware that applies it are all real. With nothing
// saved, the mapping is the built-in seed:
//   Admin = '*', RoleMiner = data.read + export/share/write.reports/contexts,
//   Servicedesk = data.read.
//
// How the mapping is held (what these tests pin down): the API process keeps
// it in memory (config/authConfig.js _state). A save or reset updates that copy
// AND the WorkerConfig row in the same call, so the change applies on the very
// next request; the row is read back only when the config is (re)loaded at
// startup. An edit made straight in the database therefore waits for a restart.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';
import { bearerFor } from '../test-utils/signInOnLiveMapping.js';

vi.mock('../src/config/authConfig.js', async (importOriginal) =>
  (await import('../test-utils/signInOnLiveMapping.js')).signInOnLiveMapping(await importOriginal()));
vi.mock('jsonwebtoken', async () =>
  (await import('../test-utils/signInOnLiveMapping.js')).claimsAsTokenJwt());

const SEED = {
  Admin: ['*'],
  RoleMiner: ['data.read', 'data.read.reports', 'data.export.ui', 'data.export.apikey', 'data.share', 'data.write.reports', 'data.write.contexts'],
  Servicedesk: ['data.read'],
};
// A route gated on one specific admin permission, and a plain read route that
// only refuses callers whose roles map to nothing.
const ADMIN_ONLY = '/api/admin/read-tokens';   // requirePermission('admin.read-tokens')
const PLAIN_READ = '/api/systems';

let agent;
let pool;
let authConfig;

const as = (roles, opts) => ({ get: (path) => agent.get(path).set('Authorization', bearerFor(roles, opts)) });
const save = (mapping, roles = ['Admin'], opts) =>
  agent.put('/api/admin/roles').set('Authorization', bearerFor(roles, opts)).send({ mapping });
const reset = (roles = ['Admin']) => agent.delete('/api/admin/roles').set('Authorization', bearerFor(roles));
const currentMapping = async () => {
  const res = await as(['Admin']).get('/api/admin/roles');
  expect(res.status).toBe(200);
  return res.body;
};
const storedRow = async () => (await pool.query(
  `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = 'AUTH_ROLE_PERMISSIONS'`)).rows[0];
const auditCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM "AuthRoleChangeLog"`)).rows[0].n;

async function backToSeed() {
  await pool.query(`DELETE FROM "WorkerConfig" WHERE "configKey" = 'AUTH_ROLE_PERMISSIONS'`);
  await authConfig.setRolePermissions(null);
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  // The mocked module (real mapping functions); imported after boot so it loads
  // with USE_SQL set and writes to the contract database.
  authConfig = await import('../src/config/authConfig.js');
});

beforeEach(backToSeed);

afterAll(async () => {
  if (pool && authConfig) await backToSeed();
  await pool?.end();
  delete process.env.USE_SQL;
});

describe('a saved mapping governs the very next request', () => {
  it('starts from the seed: Servicedesk reads data but not the admin token list', async () => {
    const snap = await currentMapping();
    expect(snap.isCustom).toBe(false);
    expect(snap.mapping).toEqual(SEED);
    expect((await as(['Servicedesk']).get(PLAIN_READ)).status).toBe(200);
    expect((await as(['Servicedesk']).get(ADMIN_ONLY)).status).toBe(403);
  });

  it('granting a permission opens the route at once; taking it away closes it again', async () => {
    const adminOid = '11111111-2222-3333-4444-555555555555';
    const before = await auditCount();
    const grant = await save({ ...SEED, Servicedesk: ['data.read', 'admin.read-tokens'] }, ['Admin'], { oid: adminOid });
    expect(grant.status).toBe(200);
    expect(grant.body.isCustom).toBe(true);
    expect(grant.body.mapping.Servicedesk).toEqual(['data.read', 'admin.read-tokens']);

    const opened = await as(['Servicedesk']).get(ADMIN_ONLY);
    expect(opened.status).toBe(200);
    expect(Array.isArray(opened.body)).toBe(true);
    // Persisted, and audited with who made the change.
    expect(JSON.parse((await storedRow()).configValue).Servicedesk).toEqual(['data.read', 'admin.read-tokens']);
    expect(await auditCount()).toBe(before + 1);
    const audit = (await pool.query(
      `SELECT "action", "changedByOid" FROM "AuthRoleChangeLog" ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(audit).toEqual({ action: 'save', changedByOid: adminOid });

    expect((await save({ ...SEED, Servicedesk: ['data.read'] })).status).toBe(200);
    expect((await as(['Servicedesk']).get(ADMIN_ONLY)).status).toBe(403);
    expect((await as(['Servicedesk']).get(PLAIN_READ)).status).toBe(200);
  });

  it('a role mapped to nothing loses every route (deny by default)', async () => {
    expect((await save({ ...SEED, Servicedesk: [] })).status).toBe(200);
    const res = await as(['Servicedesk']).get(PLAIN_READ);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_ROLE');
    // The other roles are untouched by the edit.
    expect((await as(['RoleMiner']).get(PLAIN_READ)).status).toBe(200);
  });

  it('a save replaces the mapping, it does not merge into it', async () => {
    expect((await as(['RoleMiner']).get(PLAIN_READ)).status).toBe(200);
    expect((await as(['Auditor']).get(PLAIN_READ)).status).toBe(403);

    expect((await save({ Admin: ['*'], Auditor: ['data.read'] })).status).toBe(200);
    expect((await as(['Auditor']).get(PLAIN_READ)).status).toBe(200);
    // RoleMiner was left out of the saved mapping, so it now maps to nothing.
    expect((await as(['RoleMiner']).get(PLAIN_READ)).status).toBe(403);
    expect((await currentMapping()).mapping).toEqual({ Admin: ['*'], Auditor: ['data.read'] });
  });

  it('a user holding no admin.auth cannot save a mapping', async () => {
    const res = await save({ ...SEED, RoleMiner: ['*'] }, ['RoleMiner']);
    expect(res.status).toBe(403);
    expect((await currentMapping()).mapping).toEqual(SEED);
    expect(await storedRow()).toBeUndefined();
  });
});

describe('reset back to the defaults', () => {
  it('restores the seed in memory and in the database, and requests follow it', async () => {
    expect((await save({ Admin: ['*'], Auditor: ['data.read'] })).status).toBe(200);
    expect((await as(['Servicedesk']).get(PLAIN_READ)).status).toBe(403);
    expect(await storedRow()).toBeDefined();

    const res = await reset();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, mapping: SEED, isCustom: false });
    expect(await storedRow()).toBeUndefined();
    expect((await currentMapping()).isCustom).toBe(false);
    expect((await as(['Servicedesk']).get(PLAIN_READ)).status).toBe(200);
    expect((await as(['Auditor']).get(PLAIN_READ)).status).toBe(403);
  });

  it('is refused (409) when the seed would not grant the resetting admin admin.auth — nothing changes', async () => {
    const custom = { Admin: ['*'], PlatformOwner: ['admin.auth', 'data.read'] };
    expect((await save(custom)).status).toBe(200);
    const before = await auditCount();

    const res = await reset(['PlatformOwner']);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Reset refused/);
    expect((await currentMapping()).mapping).toEqual(custom);
    expect(JSON.parse((await storedRow()).configValue)).toEqual(custom);
    expect(await auditCount()).toBe(before);
    expect((await as(['PlatformOwner']).get('/api/admin/roles')).status).toBe(200);
  });
});

describe('self-lockout guard', () => {
  it('an admin removing their own last admin access gets 409 and the mapping is unchanged', async () => {
    const before = await auditCount();
    const res = await save({ ...SEED, Admin: ['data.read'] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/would remove your own admin.auth/);
    expect(res.body.hint).toContain('["Admin"]');

    expect((await currentMapping()).mapping).toEqual(SEED);
    expect(await storedRow()).toBeUndefined();
    expect(await auditCount()).toBe(before);
    // Still an admin on the next request.
    expect((await as(['Admin']).get(ADMIN_ONLY)).status).toBe(200);
  });

  it('the guard weighs all of the editor\'s roles: dropping Admin\'s * is fine while another role keeps admin.auth', async () => {
    const mapping = { Admin: ['data.read'], Ops: ['admin.auth'] };
    expect((await save(mapping, ['Admin', 'Ops'])).status).toBe(200);
    expect((await as(['Admin']).get(ADMIN_ONLY)).status).toBe(403);
    expect((await as(['Ops']).get('/api/admin/roles')).status).toBe(200);
  });
});

describe('unknown permission names', () => {
  it('a save naming an unknown permission is rejected (400) and nothing changes', async () => {
    const res = await save({ ...SEED, Servicedesk: ['data.read', 'data.delete.everything'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown permission "data.delete.everything" for role "Servicedesk"');
    expect((await currentMapping()).mapping).toEqual(SEED);
    expect(await storedRow()).toBeUndefined();
  });

  it('a stored mapping with an unknown name loads with that name dropped and the known ones kept', async () => {
    // A row written by an older version that still knew a since-removed permission.
    await pool.query(
      `INSERT INTO "WorkerConfig" ("configKey","configValue") VALUES ('AUTH_ROLE_PERMISSIONS', $1)`,
      [JSON.stringify({ Admin: ['*'], Servicedesk: ['retired.permission', 'admin.read-tokens'] })],
    );
    await authConfig.loadAuthConfig();
    expect((await currentMapping()).mapping).toEqual({ Admin: ['*'], Servicedesk: ['admin.read-tokens'] });
    expect((await as(['Servicedesk']).get(ADMIN_ONLY)).status).toBe(200);
  });
});

describe('where the effective mapping is read from', () => {
  it('requests use the in-memory copy; a direct database edit applies only after a reload', async () => {
    expect((await save({ ...SEED, Servicedesk: ['data.read', 'admin.read-tokens'] })).status).toBe(200);
    await pool.query(
      `UPDATE "WorkerConfig" SET "configValue" = $1 WHERE "configKey" = 'AUTH_ROLE_PERMISSIONS'`,
      [JSON.stringify(SEED)],
    );
    // Not re-read per request: the saved grant still applies.
    expect((await as(['Servicedesk']).get(ADMIN_ONLY)).status).toBe(200);
    // A restart (config reload) picks up the database value.
    await authConfig.loadAuthConfig();
    expect((await as(['Servicedesk']).get(ADMIN_ONLY)).status).toBe(403);
  });

  it('a saved mapping survives a restart: what the save stored is what a reload applies', async () => {
    const mapping = { Admin: ['*'], Auditor: ['data.read', 'admin.read-tokens'] };
    expect((await save(mapping)).status).toBe(200);
    const stored = (await storedRow()).configValue;
    // Simulate a fresh process: in-memory state back to the seed, then the
    // row the save wrote is put back and the config is loaded from it.
    await authConfig.setRolePermissions(null);
    expect((await as(['Auditor']).get(ADMIN_ONLY)).status).toBe(403);
    await pool.query(
      `INSERT INTO "WorkerConfig" ("configKey","configValue") VALUES ('AUTH_ROLE_PERMISSIONS', $1)`, [stored]);
    await authConfig.loadAuthConfig();

    const snap = await currentMapping();
    expect(snap.isCustom).toBe(true);
    expect(snap.mapping).toEqual(mapping);
    expect((await as(['Auditor']).get(ADMIN_ONLY)).status).toBe(200);
  });
});

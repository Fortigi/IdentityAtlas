// HTTP integration test — boots the real Express app against the testcontainers
// DB with auth ENABLED, exercising the full auth middleware chain end-to-end
// (something the DB-mocked unit tests can't reach).
//
// Only authConfig + jsonwebtoken are mocked — db/connection.js is NOT, so the
// requests hit the real PG16 container (per Phase 7 of the test plan).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

// Enable auth by overriding only what the middleware reads; keep every other
// export real (importActual) so nothing is accidentally undefined.
// role-admin -> '*' (all permissions); role-reader -> data.read only.
vi.mock('../src/config/authConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAuthEnabled: () => true,
  getTenantId: () => 'test-tenant',
  getClientId: () => 'test-client',
  getJwksClient: () => ({}),
  getRequiredRoles: () => null,
  getRolePermissions: () => ({ 'role-admin': ['*'], 'role-reader': ['data.read'] }),
}));
// The bearer token string carries the roles: 'roles:role-admin' -> ['role-admin'].
vi.mock('jsonwebtoken', () => ({
  default: {
    verify: (token, _key, _opts, cb) => {
      const roles = token.startsWith('roles:') ? token.slice(6).split(',').filter(Boolean) : [];
      cb(null, { roles, tid: 'test-tenant' });
    },
  },
}));

let agent;
let pool;

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
});

afterAll(async () => {
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

const adminToken = 'Bearer roles:role-admin';
const readerToken = 'Bearer roles:role-reader';

describe('auth gating — GET /api/contexts (any authenticated user)', () => {
  it('401 without an Authorization header', async () => {
    expect((await agent.get('/api/contexts')).status).toBe(401);
  });
  it('401 on a non-Bearer header', async () => {
    expect((await agent.get('/api/contexts').set('Authorization', 'Basic abc')).status).toBe(401);
  });
  it('200 + { data: [...] } with a valid bearer token', async () => {
    const res = await agent.get('/api/contexts').set('Authorization', adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('auth gating — GET /api/admin/crawler-configs (requires admin.crawlers)', () => {
  it('401 without a token', async () => {
    expect((await agent.get('/api/admin/crawler-configs')).status).toBe(401);
  });
  it('403 for a token lacking the permission (role-reader)', async () => {
    expect((await agent.get('/api/admin/crawler-configs').set('Authorization', readerToken)).status).toBe(403);
  });
  it('200 (array) for an admin token', async () => {
    const res = await agent.get('/api/admin/crawler-configs').set('Authorization', adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('matrix data through the real auth chain — POST /api/matrix/data', () => {
  const body = { filter: { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } };
  it('401 without a token', async () => {
    expect((await agent.post('/api/matrix/data').send(body)).status).toBe(401);
  });
  it('200 + documented shape with an admin token', async () => {
    const res = await agent.post('/api/matrix/data').set('Authorization', adminToken).send(body);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.subjectTotal).toBe('number');
  });
});

describe('crawler-auth gating — POST /api/ingest/* rejects a non-crawler caller', () => {
  it('rejects an unauthenticated ingest call (no crawler key)', async () => {
    const res = await agent.post('/api/ingest/contexts').send({ records: [], syncMode: 'full', systemId: 1 });
    expect([401, 403]).toContain(res.status);
  });
});

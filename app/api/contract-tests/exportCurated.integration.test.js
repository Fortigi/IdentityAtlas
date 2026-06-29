// HTTP integration test — GET /api/admin/export/curated against the real PG16
// container, exercising the actual route handler (not a replicated query).
//
// Regression for the categories join: it used `LOWER(ap.id) = ca."resourceId"`,
// but `Resources.id` is uuid and `LOWER(uuid)` throws
// "function lower(uuid) does not exist" — so the endpoint returned 500
// "Export failed" the moment any GovernanceCategories row existed. The fix
// lowercases `ap.id::text` (matching the import handler), preserving the
// case-insensitive match. With the bug this test gets 500; with the fix, 200 +
// the category's business-role displayName resolved.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

vi.mock('../src/config/authConfig.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAuthEnabled: () => true,
  getTenantId: () => 'test-tenant',
  getClientId: () => 'test-client',
  getJwksClient: () => ({}),
  getRequiredRoles: () => null,
  getRolePermissions: () => ({ 'role-admin': ['*'] }),
}));
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
let systemId;
const adminToken = 'Bearer roles:role-admin';
const BR = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','export-curated') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","resourceType","displayName")
     VALUES ($1,$2,'BusinessRole','Finance Base Access')`,
    [BR, systemId],
  );
  const cat = await pool.query(
    `INSERT INTO "GovernanceCategories" ("name","color") VALUES ('ExportCuratedTest','#3B82F6') RETURNING "id"`,
  );
  // resourceId is stored UPPERCASE on purpose — the join must still match it
  // case-insensitively against the (lowercase) uuid id.
  await pool.query(
    `INSERT INTO "GovernanceCategoryAssignments" ("categoryId","resourceId") VALUES ($1,$2)`,
    [cat.rows[0].id, BR.toUpperCase()],
  );
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "GovernanceCategoryAssignments" WHERE "resourceId" = $1`, [BR.toUpperCase()]);
  await pool?.query(`DELETE FROM "GovernanceCategories" WHERE "name" = 'ExportCuratedTest'`);
  await pool?.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /api/admin/export/curated', () => {
  it('401 without auth', async () => {
    expect((await agent.get('/api/admin/export/curated')).status).toBe(401);
  });

  it('200 and resolves the category business-role displayName (regression: LOWER(uuid))', async () => {
    const res = await agent.get('/api/admin/export/curated').set('Authorization', adminToken);
    expect(res.status).toBe(200);
    const cat = (res.body.categories || []).find((c) => c.name === 'ExportCuratedTest');
    expect(cat).toBeTruthy();
    expect(cat.assignments).toHaveLength(1);
    expect(cat.assignments[0].accessPackageDisplayName).toBe('Finance Base Access');
  });
});

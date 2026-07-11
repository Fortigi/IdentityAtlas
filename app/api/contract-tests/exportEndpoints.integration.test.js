// HTTP integration test — the endpoints the Excel Power Query workbook pages
// through, against the real PG16 container + the real route handlers.
//
// Guards the deep-page regression: /api/users (and /api/groups) used to evaluate
// a per-row tag subquery for every offset+limit row before OFFSET discarded the
// first `offset`, and re-ran a full COUNT(*) on every page — slow enough on a
// large tenant that a deep page timed out → 500 in the export. The fix paginates
// first (tag subquery only for the page rows) and counts only on page 1.
//
// This test asserts the *contract* the workbook relies on: every export endpoint
// pages correctly, returns 200 (not 500) on a deeper page, exposes `total` on the
// first page only, and resolves tags for the page rows.

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
let firstPrincipalId;
const tok = 'Bearer roles:role-admin';

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','export-endpoints') RETURNING "id"`);
  systemId = sys.rows[0].id;

  // 4 principals (A..D) so we can page with limit=2.
  const pr = await pool.query(
    `INSERT INTO "Principals" ("systemId","displayName","principalType")
     VALUES ($1,'AAA Export User','User'),($1,'BBB Export User','User'),
            ($1,'CCC Export User','User'),($1,'DDD Export User','User')
     RETURNING id, "displayName"`,
    [systemId],
  );
  firstPrincipalId = pr.rows.find(r => r.displayName === 'AAA Export User').id;

  // 2 resources + a couple of assignments (for /groups + /assignments).
  const rs = await pool.query(
    `INSERT INTO "Resources" ("systemId","resourceType","displayName")
     VALUES ($1,'Group','AAA Export Group'),($1,'Group','BBB Export Group')
     RETURNING id`,
    [systemId],
  );
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","systemId")
     VALUES ($1,$2,'Direct',$3),($4,$2,'Direct',$3)`,
    [rs.rows[0].id, firstPrincipalId, systemId, rs.rows[1].id],
  );

  // A tag on the first principal (Contexts-backed) so the page-first tag subquery
  // is exercised.
  const ctx = await pool.query(
    `INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "displayName", "extendedAttributes")
     VALUES (gen_random_uuid(),'manual','Principal','Tag','ExportVIP','{"tagColor":"#3b82f6"}'::jsonb)
     RETURNING id`,
  );
  await pool.query(
    `INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy")
     VALUES ($1,'Principal',$2,'analyst')`,
    [ctx.rows[0].id, firstPrincipalId],
  );
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ContextMembers" cm USING "Contexts" c WHERE cm."contextId"=c.id AND c."displayName"='ExportVIP' AND c."contextType"='Tag'`);
  await pool?.query(`DELETE FROM "Contexts" WHERE "displayName"='ExportVIP' AND "contextType"='Tag'`);
  await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId"=$1`, [systemId]);
  await pool?.query(`DELETE FROM "Resources" WHERE "systemId"=$1`, [systemId]);
  await pool?.query(`DELETE FROM "Principals" WHERE "systemId"=$1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id"=$1`, [systemId]);
  await pool?.end();
  delete process.env.USE_SQL;
});

describe('Power Query export endpoints — paging contract', () => {
  it('401 without auth', async () => {
    expect((await agent.get('/api/users?limit=2&offset=0')).status).toBe(401);
  });

  it('/api/users: page 1 carries total + resolves tags; page 2 is 200 with total omitted', async () => {
    const p1 = await agent.get(`/api/users?systemId=${systemId}&limit=2&offset=0`).set('Authorization', tok);
    expect(p1.status).toBe(200);
    expect(p1.body.data.length).toBe(2);
    expect(typeof p1.body.total).toBe('number'); // count present on page 1
    // page-first tag subquery resolved for the page rows
    const vip = p1.body.data.find(u => u.displayName === 'AAA Export User');
    expect(vip).toBeTruthy();
    expect(vip.tags.some(t => t.name === 'ExportVIP')).toBe(true);

    const p2 = await agent.get(`/api/users?systemId=${systemId}&limit=2&offset=2`).set('Authorization', tok);
    expect(p2.status).toBe(200);            // deep page does NOT 500
    expect(p2.body.data.length).toBe(2);
    expect(p2.body.total).toBeNull();       // count skipped after page 1
  });

  it('/api/groups: pages 200 with the same total-on-page-1 contract', async () => {
    const p1 = await agent.get(`/api/groups?limit=1&offset=0`).set('Authorization', tok);
    expect(p1.status).toBe(200);
    expect(typeof p1.body.total).toBe('number');
    const p2 = await agent.get(`/api/groups?limit=1&offset=1`).set('Authorization', tok);
    expect(p2.status).toBe(200);
    expect(p2.body.total).toBeNull();
  });

  it('/api/assignments (bulk): pages 200 with total on page 1 only', async () => {
    const p1 = await agent.get(`/api/assignments?systemId=${systemId}&limit=1&offset=0`).set('Authorization', tok);
    expect(p1.status).toBe(200);
    expect(p1.body.data.length).toBe(1);
    expect(typeof p1.body.total).toBe('number');
    const p2 = await agent.get(`/api/assignments?systemId=${systemId}&limit=1&offset=1`).set('Authorization', tok);
    expect(p2.status).toBe(200);
    expect(p2.body.total).toBeNull();
  });

  it('/api/context-list + /api/context-members: flat lists page with the total-on-page-1 contract', async () => {
    const cl = await agent.get('/api/context-list?limit=100&offset=0').set('Authorization', tok);
    expect(cl.status).toBe(200);
    expect(typeof cl.body.total).toBe('number');
    expect(cl.body.data.some(c => c.displayName === 'ExportVIP' && c.contextType === 'Tag')).toBe(true);

    const cm = await agent.get('/api/context-members?limit=100&offset=0').set('Authorization', tok);
    expect(cm.status).toBe(200);
    expect(typeof cm.body.total).toBe('number');
    expect(cm.body.data.some(m => m.memberId === firstPrincipalId && m.memberType === 'Principal')).toBe(true);

    const cl2 = await agent.get('/api/context-list?limit=1&offset=1').set('Authorization', tok);
    expect(cl2.status).toBe(200);
    expect(cl2.body.total).toBeNull(); // count-on-page-1
  });
});

// HTTP integration test — POST /api/admin/import/curated against the real PG16
// container, exercising the actual route handler end-to-end.
//
// Regression coverage for two bugs a DB-mocked unit test cannot catch:
//   1. The tag + assignment writes targeted "GraphTags" / "GraphTagAssignments",
//      which the Contexts-v6 migration turned into multi-table JOIN VIEWs.
//      Postgres refuses INSERT into such a view (no INSTEAD OF trigger), so any
//      curated import carrying tags threw and returned 500 "Import failed".
//      The fix writes Contexts (contextType='Tag') + ContextMembers directly,
//      mirroring routes/tags.js.
//   2. resolveEntity filtered `AND ValidTo = '9999-...'`, a SQL-Server-era
//      system-versioned column that no longer exists — the predicate threw,
//      the catch swallowed it, and EVERY assignment resolved to "not found".
//
// With either bug present this test fails (500, or assignmentsInserted === 0);
// with both fixed it is 200 and rows land in Contexts / ContextMembers, and the
// read-compat GraphTags views reflect them.

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

// Seeded entities (lowercase uuids — how ContextMembers stores them).
const USER_GUID   = '11111111-1111-1111-1111-111111111111'; // resolved by GUID
const USER2_GUID  = '22222222-2222-2222-2222-222222222222'; // resolved by displayName (soft-match)
const GROUP_GUID  = '33333333-3333-3333-3333-333333333333'; // resource/group tag target
const USER2_NAME  = 'Curated Import Soft Match User';
const GROUP_NAME  = 'Curated Import Group';
const USER_TAG    = 'CuratedImportUserTag';
const GROUP_TAG   = 'CuratedImportGroupTag';

async function tagContext(displayName, targetType) {
  return pool.query(
    `SELECT * FROM "Contexts"
       WHERE "contextType" = 'Tag' AND "variant" = 'manual'
         AND "targetType" = $1 AND "displayName" = $2`,
    [targetType, displayName],
  );
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','import-curated') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
  await pool.query(
    `INSERT INTO "Principals" ("id","systemId","displayName","principalType")
     VALUES ($1,$2,'Curated Import GUID User','User'), ($3,$2,$4,'User')`,
    [USER_GUID, systemId, USER2_GUID, USER2_NAME],
  );
  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","resourceType","displayName")
     VALUES ($1,$2,'Group',$3)`,
    [GROUP_GUID, systemId, GROUP_NAME],
  );
});

afterAll(async () => {
  // Scope deletes to our own rows (singleFork shared DB). Deleting the tag
  // Contexts cascades to their ContextMembers (FK ON DELETE CASCADE).
  await pool?.query(
    `DELETE FROM "Contexts" WHERE "contextType" = 'Tag' AND "displayName" = ANY($1)`,
    [[USER_TAG, GROUP_TAG]],
  );
  await pool?.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('POST /api/admin/import/curated (tags → Contexts/ContextMembers)', () => {
  it('401 without auth', async () => {
    const res = await agent.post('/api/admin/import/curated').send({ tags: [], categories: [] });
    expect(res.status).toBe(401);
  });

  it('200: creates a Tag context and resolves assignments by GUID and by displayName', async () => {
    const res = await agent
      .post('/api/admin/import/curated')
      .set('Authorization', adminToken)
      .send({
        tags: [{
          name: USER_TAG,
          entityType: 'user',
          color: '#abcdef',
          assignments: [
            { entityId: USER_GUID },                                  // GUID match
            { entityId: '00000000-0000-0000-0000-000000000000', displayName: USER2_NAME }, // soft-match
          ],
        }],
        categories: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stats.tagsInserted).toBe(1);
    expect(res.body.stats.assignmentsInserted).toBe(2);
    expect(res.body.stats.assignmentsSoftMatched).toBe(1);
    expect(res.body.stats.assignmentsNotFound).toBe(0);

    // Tag persisted as a manual Contexts row with the colour in extendedAttributes.
    const ctx = await tagContext(USER_TAG, 'Principal');
    expect(ctx.rows).toHaveLength(1);
    expect(ctx.rows[0].extendedAttributes.tagColor).toBe('#abcdef');
    const tagId = ctx.rows[0].id;

    // Both assignments landed in ContextMembers, keyed by the resolved uuids.
    const members = await pool.query(
      `SELECT "memberId","memberType" FROM "ContextMembers" WHERE "contextId" = $1 ORDER BY "memberId"`,
      [tagId],
    );
    expect(members.rows.map((r) => r.memberId)).toEqual([USER_GUID, USER2_GUID]);
    expect(members.rows.every((r) => r.memberType === 'Principal')).toBe(true);

    // Read-compat: the GraphTags / GraphTagAssignments VIEWS reflect the writes.
    const viewTag = await pool.query(`SELECT id,name,"entityType" FROM "GraphTags" WHERE name = $1`, [USER_TAG]);
    expect(viewTag.rows).toHaveLength(1);
    expect(viewTag.rows[0].entityType).toBe('user');
    const viewAssign = await pool.query(`SELECT COUNT(*)::int AS n FROM "GraphTagAssignments" WHERE "tagId" = $1`, [tagId]);
    expect(viewAssign.rows[0].n).toBe(2);
  });

  it('re-import upserts colour and is idempotent (no duplicate members)', async () => {
    const res = await agent
      .post('/api/admin/import/curated')
      .set('Authorization', adminToken)
      .send({
        tags: [{
          name: USER_TAG,
          entityType: 'user',
          color: '#123456',
          assignments: [{ entityId: USER_GUID }],
        }],
        categories: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.stats.tagsInserted).toBe(0);
    expect(res.body.stats.tagsSkipped).toBe(1);           // existing tag → update path
    expect(res.body.stats.assignmentsInserted).toBe(0);   // already a member
    expect(res.body.stats.assignmentsSkipped).toBe(1);

    const ctx = await tagContext(USER_TAG, 'Principal');
    expect(ctx.rows[0].extendedAttributes.tagColor).toBe('#123456'); // colour updated
    const members = await pool.query(`SELECT COUNT(*)::int AS n FROM "ContextMembers" WHERE "contextId" = $1`, [ctx.rows[0].id]);
    expect(members.rows[0].n).toBe(2); // still 2 — no duplication
  });

  it('resolves a group/resource tag assignment against Resources', async () => {
    const res = await agent
      .post('/api/admin/import/curated')
      .set('Authorization', adminToken)
      .send({
        tags: [{
          name: GROUP_TAG,
          entityType: 'group',
          assignments: [{ entityId: GROUP_GUID, displayName: GROUP_NAME, resourceType: 'Group' }],
        }],
        categories: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.stats.tagsInserted).toBe(1);
    expect(res.body.stats.assignmentsInserted).toBe(1);

    const ctx = await tagContext(GROUP_TAG, 'Resource');
    expect(ctx.rows).toHaveLength(1);
    const members = await pool.query(
      `SELECT "memberId","memberType" FROM "ContextMembers" WHERE "contextId" = $1`,
      [ctx.rows[0].id],
    );
    expect(members.rows).toHaveLength(1);
    expect(members.rows[0].memberId).toBe(GROUP_GUID);
    expect(members.rows[0].memberType).toBe('Resource');
  });
});

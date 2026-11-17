// Contract test — the matrix matview flags managedByAccessPackage on actual
// membership cells when the subject holds a governance resource (business role
// / access package) that Contains the resource (migration 049). The matview
// holds ONLY actual memberships — the provisioning gap (managed cell with no
// actual membership) is derived for the grid, so it never inflates the view's
// many count/list consumers.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

let pool;
let systemId;

const BR = '11111111-1111-1111-1111-111111111111'; // a business role (governanceResource)
const G  = '22222222-2222-2222-2222-222222222222'; // a group the role Contains
const U_OK  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // holds BR + member of G → managed
const U_UN  = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // member of G, no BR     → unmanaged
const U_GAP = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // holds BR, not in G     → no actual cell

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'governed-managed') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","resourceType","displayName","governanceResource") VALUES
       ($1,$2,'BusinessRole','Test Role', true),
       ($3,$2,'Group','Test Group', false)`,
    [BR, systemId, G],
  );
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","roleName")
     VALUES ($1,$2,'Contains','Member')`,
    [BR, G],
  );
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "ResourceRelationships" WHERE "parentResourceId" = $1`, [BR]);
  await pool?.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
});

async function assign({ resourceId, principalId, governed }) {
  await pool.query(
    `INSERT INTO "ResourceAssignments"
       ("systemId","resourceId","principalId","assignmentType","governed")
     VALUES ($1,$2,$3,'Direct',$4)`,
    [systemId, resourceId, principalId, governed],
  );
}

async function groupCell(principalId) {
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  const r = await pool.query(
    `SELECT "managedByAccessPackage"
       FROM "vw_ResourceUserPermissionAssignments"
      WHERE "resourceId" = $1 AND "principalId" = $2 AND "membershipType" = 'Direct'`,
    [G, principalId],
  );
  return r.rows;
}

describe('matrix matview — managedByAccessPackage from governance coverage', () => {
  it('holds the role + member of the group → managed cell', async () => {
    await assign({ resourceId: BR, principalId: U_OK, governed: true });  // holds the role
    await assign({ resourceId: G,  principalId: U_OK, governed: false }); // actual membership
    const rows = await groupCell(U_OK);
    expect(rows).toHaveLength(1);
    expect(rows[0].managedByAccessPackage).toBe(true);
  });

  it('member of the group with no governance → unmanaged cell', async () => {
    await assign({ resourceId: G, principalId: U_UN, governed: false });
    const rows = await groupCell(U_UN);
    expect(rows).toHaveLength(1);
    expect(rows[0].managedByAccessPackage).toBe(false);
  });

  it('holds the role but not in the group → no actual cell (gap is grid-derived)', async () => {
    await assign({ resourceId: BR, principalId: U_GAP, governed: true });
    const rows = await groupCell(U_GAP);
    expect(rows).toHaveLength(0);
  });
});

// Migration 061: holding a business role is governed access, so the role's own
// row must be covered by the role itself — otherwise the matrix paints the role
// row ungoverned and the scope statistics count it as an ungoverned assignment.
describe('business-role coverage — a role covers its own membership row (061)', () => {
  async function coverage(principalId) {
    await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
    const r = await pool.query(
      `SELECT "resourceId", "businessRoleId"
         FROM "vw_UserPermissionAssignmentViaBusinessRole"
        WHERE "userId" = $1
        ORDER BY "resourceId"`,
      [principalId],
    );
    return r.rows;
  }

  it('reports both the role itself and the resources it Contains', async () => {
    await assign({ resourceId: BR, principalId: U_OK, governed: true });
    const rows = await coverage(U_OK);
    expect(rows).toEqual(expect.arrayContaining([
      { resourceId: BR, businessRoleId: BR },
      { resourceId: G, businessRoleId: BR },
    ]));
    expect(rows).toHaveLength(2);
  });

  it('leaves a subject who does not hold the role uncovered', async () => {
    await assign({ resourceId: G, principalId: U_UN, governed: false });
    expect(await coverage(U_UN)).toEqual([]);
  });

  it('drops the self row again when the role assignment is soft-deleted', async () => {
    await assign({ resourceId: BR, principalId: U_GAP, governed: true });
    expect(await coverage(U_GAP)).toHaveLength(2);
    await pool.query(
      `UPDATE "ResourceAssignments" SET "deletedAt" = now()
        WHERE "resourceId" = $1 AND "principalId" = $2`,
      [BR, U_GAP],
    );
    expect(await coverage(U_GAP)).toEqual([]);
  });
});

// Issue #1629 — a business role deleted in the source governs nothing. Resources
// is a soft-delete table and resources/assignments reconcile independently, so a
// role can be tombstoned while its membership row is still live. Neither the
// coverage matview nor the matrix matview's managedByAccessPackage flag may keep
// claiming such a role governs the resources it Contains.
describe('business-role coverage — a soft-deleted role governs nothing (#1629)', () => {
  const BR_DEL = '33333333-3333-3333-3333-333333333333'; // role tombstoned in the source
  const G_LIVE = '44444444-4444-4444-4444-444444444444'; // live group BR_DEL Contains
  const G_DEL  = '55555555-5555-5555-5555-555555555555'; // tombstoned group the live BR Contains

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO "Resources" ("id","systemId","resourceType","displayName","governanceResource","deletedAt") VALUES
         ($1,$2,'BusinessRole','Deleted Role', true,  now()),
         ($3,$2,'Group','Live Group',          false, NULL),
         ($4,$2,'Group','Deleted Group',       false, now())`,
      [BR_DEL, systemId, G_LIVE, G_DEL],
    );
    await pool.query(
      `INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","roleName")
       VALUES ($1,$2,'Contains','Member'), ($3,$4,'Contains','Member')`,
      [BR_DEL, G_LIVE, BR, G_DEL],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM "ResourceRelationships" WHERE "parentResourceId" IN ($1,$2)`, [BR_DEL, BR]);
    await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
    await pool.query(`DELETE FROM "Resources" WHERE "id" IN ($1,$2,$3)`, [BR_DEL, G_LIVE, G_DEL]);
  });

  async function coveredResources(principalId) {
    await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
    const r = await pool.query(
      `SELECT "resourceId" FROM "vw_UserPermissionAssignmentViaBusinessRole"
        WHERE "userId" = $1 ORDER BY "resourceId"`,
      [principalId],
    );
    return r.rows.map((x) => x.resourceId);
  }

  it('emits no coverage rows for a soft-deleted role whose membership row is still live', async () => {
    await assign({ resourceId: BR_DEL, principalId: U_OK, governed: true });  // live assignment, dead role
    await assign({ resourceId: G_LIVE, principalId: U_OK, governed: false }); // live child membership
    expect(await coveredResources(U_OK)).toEqual([]);
  });

  it('does not flag the live child cell managedByAccessPackage via the deleted role', async () => {
    await assign({ resourceId: BR_DEL, principalId: U_OK, governed: true });
    await assign({ resourceId: G_LIVE, principalId: U_OK, governed: false });
    await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
    const r = await pool.query(
      `SELECT "managedByAccessPackage" FROM "vw_ResourceUserPermissionAssignments"
        WHERE "resourceId" = $1 AND "principalId" = $2`,
      [G_LIVE, U_OK],
    );
    expect(r.rows).toEqual([{ managedByAccessPackage: false }]);
  });

  it('keeps a live role’s self row and live-child row, drops the soft-deleted-child row', async () => {
    await assign({ resourceId: BR, principalId: U_OK, governed: true }); // BR Contains G (live) and G_DEL (deleted)
    expect((await coveredResources(U_OK)).sort()).toEqual([BR, G].sort());
  });
});

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

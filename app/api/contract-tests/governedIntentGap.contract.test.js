// Contract test — the matrix matview derives managedByAccessPackage +
// provisioningGap + isActualMembership from governed memberships + Contains
// (migration 049), with NO stored intent rows.
//
// Model: a subject who holds a governance resource (governanceResource=true)
// that Contains group G is "managed" for G. If the subject also has an effective
// membership in G → provisioned (no gap). If not → provisioning gap (a derived
// cell with isActualMembership=false). A plain membership with no governance
// behind it is ungoverned.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

let pool;
let systemId;

const BR = '11111111-1111-1111-1111-111111111111'; // a business role (governanceResource)
const G  = '22222222-2222-2222-2222-222222222222'; // a group the role Contains
const U_OK  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // holds BR + actual member of G → provisioned
const U_GAP = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // holds BR, not in G        → gap
const U_UN  = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // member of G, no BR         → ungoverned

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'governed-gap') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","resourceType","displayName","governanceResource") VALUES
       ($1,$2,'BusinessRole','Test Role', true),
       ($3,$2,'EntraGroup','Test Group', false)`,
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
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  const r = await pool.query(
    `SELECT "managedByAccessPackage", "provisioningGap", "isActualMembership"
       FROM "vw_ResourceUserPermissionAssignments"
      WHERE "resourceId" = $1 AND "principalId" = $2 AND "membershipType" = 'Direct'`,
    [G, principalId],
  );
  return r.rows;
}

describe('matrix matview — derived provisioning gap (governed + Contains)', () => {
  it('holds the role + actual member of the group → managed, no gap', async () => {
    await assign({ resourceId: BR, principalId: U_OK, governed: true });  // holds the role
    await assign({ resourceId: G,  principalId: U_OK, governed: false }); // actual membership
    const rows = await groupCell(U_OK);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ managedByAccessPackage: true, provisioningGap: false, isActualMembership: true });
  });

  it('holds the role but not in the group → managed, GAP, no badge', async () => {
    await assign({ resourceId: BR, principalId: U_GAP, governed: true }); // holds the role only
    const rows = await groupCell(U_GAP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ managedByAccessPackage: true, provisioningGap: true, isActualMembership: false });
  });

  it('member of the group with no governance → not managed, no gap', async () => {
    await assign({ resourceId: G, principalId: U_UN, governed: false });
    const rows = await groupCell(U_UN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ managedByAccessPackage: false, provisioningGap: false, isActualMembership: true });
  });
});

// Contract test — the matrix matview derives managedByAccessPackage +
// provisioningGap + isActualMembership from the governed flag (migration 049).
//
// Governed-intent model: a cell can have an actual membership (governed=false),
// a governed-intent row (governed=true), or both. The matview must report:
//   - both         → managed, no gap, badge shown   (provisioned)
//   - intent only  → managed, GAP, no badge          (provisioning gap)
//   - actual only  → not managed, no gap, badge shown (ungoverned access)
// This verifies that derivation against the real schema.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

let pool;
let systemId;

const G  = '11111111-1111-1111-1111-111111111111'; // a group resource
const U_OK  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // actual + intent → provisioned
const U_GAP = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // intent only      → gap
const U_UN  = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // actual only      → ungoverned

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'governed-gap') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
});

async function insertRA({ principalId, governed }) {
  await pool.query(
    `INSERT INTO "ResourceAssignments"
       ("systemId", "resourceId", "principalId", "assignmentType", "governed")
     VALUES ($1, $2, $3, 'Direct', $4)`,
    [systemId, G, principalId, governed],
  );
}

async function cell(principalId) {
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  const r = await pool.query(
    `SELECT "managedByAccessPackage", "provisioningGap", "isActualMembership"
       FROM "vw_ResourceUserPermissionAssignments"
      WHERE "resourceId" = $1 AND "principalId" = $2 AND "membershipType" = 'Direct'`,
    [G, principalId],
  );
  return r.rows;
}

describe('matrix matview — governed-intent gap derivation', () => {
  it('actual + intent → managed, no gap, badge shown', async () => {
    await insertRA({ principalId: U_OK, governed: false });
    await insertRA({ principalId: U_OK, governed: true });
    const rows = await cell(U_OK);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      managedByAccessPackage: true,
      provisioningGap: false,
      isActualMembership: true,
    });
  });

  it('intent only → managed, GAP, no badge', async () => {
    await insertRA({ principalId: U_GAP, governed: true });
    const rows = await cell(U_GAP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      managedByAccessPackage: true,
      provisioningGap: true,
      isActualMembership: false,
    });
  });

  it('actual only → not managed, no gap, badge shown', async () => {
    await insertRA({ principalId: U_UN, governed: false });
    const rows = await cell(U_UN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      managedByAccessPackage: false,
      provisioningGap: false,
      isActualMembership: true,
    });
  });
});

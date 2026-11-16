// Contract test — the reporter's path for #1629, through the HTTP routes the
// matrix page actually calls, against a real PostgreSQL schema.
//
// The matview-level proof that a soft-deleted business role governs nothing lives
// in governedIntentGap.contract.test.js. This file asserts the two consumers the
// reporter looked at agree with it, because each reads the coverage view its own
// way and neither could compensate for a wrong row:
//
//   * POST /matrix/data   — `managedByPackages`, the sidecar that colours a cell
//     and names the role managing it;
//   * POST /matrix/scope-stats — the governed / non-governed split and the
//     governed share, counted from a bare `br."userId" IS NOT NULL` join.
//
// Seeded side by side for one subject: a role the source still has and a role it
// has deleted, each Contains-ing a live group of its own, with every membership
// row live. After the fix only the live role's group counts as governed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;

const USER = { id: 'a6290000-0000-4000-8000-000000000001', displayName: 'Rowan 1629' };
const ROLE_GONE  = { id: 'a6290000-0000-4000-8000-000000000002', displayName: 'Role removed in source 1629' };
const GROUP_GONE = { id: 'a6290000-0000-4000-8000-000000000003', displayName: 'Group of the removed role 1629' };
const ROLE_LIVE  = { id: 'a6290000-0000-4000-8000-000000000004', displayName: 'Role still in source 1629' };
const GROUP_LIVE = { id: 'a6290000-0000-4000-8000-000000000005', displayName: 'Group of the live role 1629' };

// The matrix the reporter opens: that one subject, those two group rows. Business
// roles are off the resource axis by default (#937), so the governed signal on
// the two group cells is the whole question.
const FILTER = {
  rowType: 'principal',
  subject: { include: [{ kind: 'attribute', field: 'displayName', values: [USER.displayName] }], exclude: [] },
  resource: {
    include: [{ kind: 'attribute', field: 'displayName', values: [GROUP_GONE.displayName, GROUP_LIVE.displayName] }],
    exclude: [],
  },
};

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-1629') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  await pool.query(
    `INSERT INTO "Principals" ("id","systemId","displayName","principalType") VALUES ($1,$2,$3,'User')`,
    [USER.id, systemId, USER.displayName],
  );
  // The deleted role is tombstoned — what a full sync does to a resource the
  // source no longer has. Everything else is live, including both memberships on
  // the dead role's side: resources and assignments reconcile per table, with no
  // cascade from one to the other.
  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","resourceType","displayName","governanceResource","deletedAt") VALUES
       ($1,$5,'BusinessRole',$2, true,  now()),
       ($3,$5,'Group',       $4, false, NULL)`,
    [ROLE_GONE.id, ROLE_GONE.displayName, GROUP_GONE.id, GROUP_GONE.displayName, systemId],
  );
  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","resourceType","displayName","governanceResource") VALUES
       ($1,$5,'BusinessRole',$2, true),
       ($3,$5,'Group',       $4, false)`,
    [ROLE_LIVE.id, ROLE_LIVE.displayName, GROUP_LIVE.id, GROUP_LIVE.displayName, systemId],
  );
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","roleName")
     VALUES ($1,$2,'Contains','Member'), ($3,$4,'Contains','Member')`,
    [ROLE_GONE.id, GROUP_GONE.id, ROLE_LIVE.id, GROUP_LIVE.id],
  );
  for (const [resourceId, governed] of [
    [ROLE_GONE.id, true], [ROLE_LIVE.id, true], [GROUP_GONE.id, false], [GROUP_LIVE.id, false],
  ]) {
    await pool.query(
      `INSERT INTO "ResourceAssignments"
         ("systemId","resourceId","principalId","assignmentType","governed","principalType")
       VALUES ($1,$2,$3,'Direct',$4,'User')`,
      [systemId, resourceId, USER.id, governed],
    );
  }

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(
    `DELETE FROM "ResourceRelationships" WHERE "parentResourceId" = ANY($1::uuid[])`,
    [[ROLE_GONE.id, ROLE_LIVE.id]],
  );
  await pool?.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
});

/** The business roles /matrix/data names as managing one (subject, resource) cell. */
const coveringRoles = (body, resourceId) =>
  (body.managedByPackages || [])
    .filter(m => m.memberId === USER.id && m.resourceId === resourceId)
    .flatMap(m => m.accessPackageIds);

describe('#1629 — a source-deleted business role governs nothing, as the matrix routes report it', () => {
  it('names only the live role as managing a cell (POST /matrix/data)', async () => {
    const res = await agent.post('/api/matrix/data').send({ filter: FILTER });
    expect(res.status).toBe(200);
    expect(coveringRoles(res.body, GROUP_GONE.id)).toEqual([]);
    // Not vacuous: the live role's identical cell is still covered, by itself.
    expect(coveringRoles(res.body, GROUP_LIVE.id)).toEqual([ROLE_LIVE.id]);
  });

  it('keeps the membership itself and only drops its managed flag', async () => {
    const res = await agent.post('/api/matrix/data').send({ filter: FILTER });
    expect(res.status).toBe(200);
    const cell = (res.body.data || []).filter(
      d => d.memberId === USER.id && d.resourceId === GROUP_GONE.id,
    );
    expect(cell).toHaveLength(1);
    expect(cell[0].membershipType).toBe('Direct');
    expect(cell[0].managedByAccessPackage).toBe(false);
  });

  it('counts one governed assignment of two (POST /matrix/scope-stats)', async () => {
    const res = await agent.post('/api/matrix/scope-stats').send({ filter: FILTER });
    expect(res.status).toBe(200);
    expect(res.body.assignmentCount).toBe(2);
    expect(res.body.governedAssignmentCount).toBe(1);
    expect(res.body.ungovernedAssignmentCount).toBe(1);
    expect(res.body.governedPct).toBe(50);
  });
});

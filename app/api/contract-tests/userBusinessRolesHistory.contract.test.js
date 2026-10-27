// Contract test — a user's business roles must keep history apart from current
// access, against the real PostgreSQL 16 schema.
//
// Found on a customer tenant: a business role was deleted in the source and
// re-created under the same name. The user's "Business Roles" list showed both,
// unflagged, so the person appeared to hold the same role twice. The rows are
// kept on purpose (soft delete = access history); what was missing was the
// flag, and the count still included the deleted role.
//
// Seeds one user holding:
//   • a live role                                  → current
//   • a deleted role with the SAME name            → historical (role deleted)
//   • a live role whose assignment was removed     → historical (assignment deleted)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool, systemId, userId, liveRoleId, deletedRoleId, removedRoleId;

const ROLE_DELETED_AT = '2026-09-08T14:32:00Z';
const ASSIGNMENT_DELETED_AT = '2026-09-20T10:00:00Z';

async function insertRole(name, deletedAt = null) {
  return (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "governanceResource", "deletedAt")
     VALUES (gen_random_uuid(), $1, $2, 'BusinessRole', true, $3) RETURNING "id"`,
    [systemId, name, deletedAt],
  )).rows[0].id;
}

async function assign(resourceId, deletedAt = null) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId", "governed", "deletedAt")
     VALUES ($1, $2, 'Direct', 'User', $3, true, $4)`,
    [resourceId, userId, systemId, deletedAt],
  );
}

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-user-br-history') RETURNING "id"`,
  )).rows[0].id;

  userId = (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType")
     VALUES (gen_random_uuid(), $1, 'Role Holder', 'holder@example.com', 'User') RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  liveRoleId = await insertRole('Head of Finance');
  deletedRoleId = await insertRole('Head of Finance', ROLE_DELETED_AT);
  removedRoleId = await insertRole('Head of Sales');

  await assign(liveRoleId);
  await assign(deletedRoleId);                       // assignment live, role deleted
  await assign(removedRoleId, ASSIGNMENT_DELETED_AT); // role live, assignment deleted

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /user/:id — business-role count', () => {
  it('counts only the role the user holds now', async () => {
    const res = await agent.get(`/api/user/${userId}`);
    expect(res.status).toBe(200);
    expect(res.body.accessPackageCount).toBe(1);
  });
});

describe('GET /user/:id/access-packages — current vs historical', () => {
  it('lists the current role first and flags both kinds of history', async () => {
    const res = await agent.get(`/api/user/${userId}/access-packages`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((r) => [r.resourceId, r]));
    expect(Object.keys(byId).sort()).toEqual([liveRoleId, deletedRoleId, removedRoleId].sort());

    expect(res.body[0].resourceId).toBe(liveRoleId);
    expect(byId[liveRoleId]).toMatchObject({ deleted: false, deletedAt: null });

    // Same name as the live one: only the flag tells them apart.
    expect(byId[deletedRoleId].accessPackageName).toBe('Head of Finance');
    expect(byId[deletedRoleId].deleted).toBe(true);
    expect(new Date(byId[deletedRoleId].deletedAt).toISOString()).toBe(new Date(ROLE_DELETED_AT).toISOString());

    expect(byId[removedRoleId].deleted).toBe(true);
    expect(new Date(byId[removedRoleId].deletedAt).toISOString()).toBe(new Date(ASSIGNMENT_DELETED_AT).toISOString());
  });
});

describe('GET /user/:id/memberships — historical rows carry their deletion time', () => {
  it('returns the live role unflagged and the history with deletedAt', async () => {
    const res = await agent.get(`/api/user/${userId}/memberships`);
    expect(res.status).toBe(200);
    const live = res.body.filter((r) => !r.deleted);
    const history = res.body.filter((r) => r.deleted);
    expect(live.map((r) => r.resourceId)).toEqual([liveRoleId]);
    expect(live[0].deletedAt).toBeNull();
    expect(history.map((r) => r.resourceId).sort()).toEqual([deletedRoleId, removedRoleId].sort());
    expect(history.every((r) => r.deletedAt)).toBe(true);
  });
});

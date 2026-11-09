// Contract test — the Business Roles list and the matrix business-role columns
// must keep soft-deleted roles (migration 040) out of the current view, against
// the real PostgreSQL 16 schema.
//
// Found on a customer tenant: a business role deleted in the source and
// re-created under the same name showed up twice on the Business Roles page.
// The deleted row is kept on purpose (history); it just must not look current.
//
// Seeds, under one unique name:
//   • a live business role with three governed assignments:
//       – a live assignment of a live user          → counted
//       – a deleted (tombstoned) assignment         → not counted
//       – a live assignment of a deleted user       → not counted
//   • a deleted business role with the SAME name, one live assignment
//   • a live group contained by the live role, and a deleted group contained by it

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';
import { deleteSystemScopedRows } from '../test-utils/systemScopedCleanup.js';

const ROLE_NAME = 'BR-history-contract Finance Approver';
const ROLE_DELETED_AT = '2026-09-08T14:32:00Z';

let agent, pool, systemId;
const ids = {};

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-br-list-history') RETURNING "id"`,
  )).rows[0].id;

  // Resources: [key, displayName, resourceType, deletedAt]
  const resources = [
    ['liveRole', ROLE_NAME, 'BusinessRole', null],
    ['deletedRole', ROLE_NAME, 'BusinessRole', ROLE_DELETED_AT],
    ['liveGroup', 'BR-history live group', 'Group', null],
    ['deletedGroup', 'BR-history deleted group', 'Group', ROLE_DELETED_AT],
  ];
  for (const [key, name, type, deletedAt] of resources) {
    ids[key] = (await pool.query(
      `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "governanceResource", "deletedAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING "id"`,
      [systemId, name, type, type === 'BusinessRole', deletedAt],
    )).rows[0].id;
  }

  // Principals: [key, deletedAt]
  for (const [key, deletedAt] of [['alice', null], ['bob', null], ['leaver', ROLE_DELETED_AT]]) {
    ids[key] = (await pool.query(
      `INSERT INTO "Principals" ("id", "systemId", "displayName", "principalType", "deletedAt")
       VALUES (gen_random_uuid(), $1, $2, 'User', $3) RETURNING "id"`,
      [systemId, `BR-history ${key}`, deletedAt],
    )).rows[0].id;
  }

  // Governed assignments: [role, principal, assignment deletedAt]
  const assignments = [
    ['liveRole', 'alice', null],
    ['liveRole', 'bob', ROLE_DELETED_AT],
    ['liveRole', 'leaver', null],
    ['deletedRole', 'alice', null],
  ];
  for (const [role, principal, deletedAt] of assignments) {
    await pool.query(
      `INSERT INTO "ResourceAssignments"
         ("resourceId", "principalId", "assignmentType", "principalType", "systemId", "governed", "deletedAt")
       VALUES ($1, $2, 'Direct', 'User', $3, true, $4)`,
      [ids[role], ids[principal], systemId, deletedAt],
    );
  }

  for (const child of ['liveGroup', 'deletedGroup']) {
    await pool.query(
      `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId")
       VALUES ($1, $2, 'Contains', $3)`,
      [ids.liveRole, ids[child], systemId],
    );
  }
});

afterAll(async () => {
  await deleteSystemScopedRows(pool, systemId);
  await pool?.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

const listRoles = async (extra = '') => {
  const res = await agent.get(`/api/access-packages?search=${encodeURIComponent(ROLE_NAME)}${extra}`);
  expect(res.status).toBe(200);
  return res.body;
};

describe('GET /api/access-packages — deleted business roles', () => {
  it('hides the deleted namesake by default', async () => {
    const body = await listRoles();
    expect(body.data.map((r) => r.id)).toEqual([ids.liveRole]);
    expect(body.total).toBe(1);
    expect(body.data[0].deletedAt).toBeNull();
  });

  it('counts only live assignments of live principals', async () => {
    const body = await listRoles();
    // alice only — bob's assignment is tombstoned, the leaver is deleted.
    expect(body.data[0].totalAssignments).toBe(1);
  });

  it('?includeDeleted=true shows the deleted role, flagged with its deletion time', async () => {
    const body = await listRoles('&includeDeleted=true');
    expect(body.total).toBe(2);
    const byId = Object.fromEntries(body.data.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual([ids.liveRole, ids.deletedRole].sort());
    expect(byId[ids.liveRole].deletedAt).toBeNull();
    expect(new Date(byId[ids.deletedRole].deletedAt).toISOString()).toBe(new Date(ROLE_DELETED_AT).toISOString());
  });
});

describe('GET /api/access-package-groups — matrix business-role columns', () => {
  it('excludes the deleted role and the deleted child, and counts live assignments only', async () => {
    const res = await agent.get('/api/access-package-groups');
    expect(res.status).toBe(200);
    const ours = res.body.filter((r) => r.accessPackageId === ids.liveRole || r.accessPackageId === ids.deletedRole);
    expect(ours.every((r) => r.accessPackageId === ids.liveRole)).toBe(true);
    expect(ours.map((r) => r.resourceId)).toEqual([ids.liveGroup]);
    expect(ours[0].totalAssignments).toBe(1);
  });
});

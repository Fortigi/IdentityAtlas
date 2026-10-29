// Contract test — resource, group and business-role detail endpoints keep
// soft-deleted rows apart from current access, against the real PostgreSQL 16
// schema.
//
// "deletedAt" (migration 040) tombstones a Principal / Resource /
// ResourceAssignment that vanished from the source; the row stays as history.
// These endpoints read the raw tables, so without a check a deleted holder,
// role or parent showed up as current — and was counted in the detail bubbles.
// Rule: relationship LISTS keep history but flag it (`deleted` + `deletedAt`,
// current rows first); COUNTS include live rows only.
//
// Seeds one resource ("Finance Share") with:
//   • a live member                                 → current
//   • a member whose assignment was deleted          → historical
//   • a member whose principal was deleted           → historical
//   • a live business role containing it             → current
//   • a deleted business role containing it          → historical
//   • a live parent resource and a deleted one       → current / historical
// and, on the live business role, a live assignee plus a deleted assignee, and
// a second (deleted) contained resource.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';
import { closeSystemContract } from '../test-utils/systemScopedCleanup.js';

let agent, pool, systemId;
let resourceId, liveRoleId, deletedRoleId, liveParentId, deletedParentId, deletedChildId;
let liveUserId, removedUserId, deletedUserId;

const ASSIGNMENT_DELETED_AT = '2026-09-20T10:00:00Z';
const PRINCIPAL_DELETED_AT = '2026-09-10T08:00:00Z';
const ROLE_DELETED_AT = '2026-09-08T14:32:00Z';
const PARENT_DELETED_AT = '2026-09-05T09:15:00Z';
const CHILD_DELETED_AT = '2026-09-03T11:45:00Z';

const sameInstant = (a, b) => expect(new Date(a).toISOString()).toBe(new Date(b).toISOString());

async function insertResource(name, resourceType, deletedAt = null) {
  return (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "governanceResource", "deletedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING "id"`,
    [systemId, name, resourceType, resourceType === 'BusinessRole', deletedAt],
  )).rows[0].id;
}

async function insertPrincipal(name, deletedAt = null) {
  return (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType", "deletedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, 'User', $4) RETURNING "id"`,
    [systemId, name, `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, deletedAt],
  )).rows[0].id;
}

async function assign(resId, principalId, deletedAt = null) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId", "deletedAt")
     VALUES ($1, $2, 'Direct', 'User', $3, $4)`,
    [resId, principalId, systemId, deletedAt],
  );
}

async function relate(parentId, childId, relationshipType = 'Contains') {
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId", "roleName")
     VALUES ($1, $2, $3, $4, 'Member')`,
    [parentId, childId, relationshipType, systemId],
  );
}

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-resource-role-history') RETURNING "id"`,
  )).rows[0].id;

  resourceId = await insertResource('Finance Share', 'Group');
  liveRoleId = await insertResource('Finance Clerk', 'BusinessRole');
  deletedRoleId = await insertResource('Finance Clerk', 'BusinessRole', ROLE_DELETED_AT);
  liveParentId = await insertResource('All Finance', 'Group');
  deletedParentId = await insertResource('Old Finance', 'Group', PARENT_DELETED_AT);
  deletedChildId = await insertResource('Retired Share', 'Group', CHILD_DELETED_AT);

  liveUserId = await insertPrincipal('Ada Live');
  removedUserId = await insertPrincipal('Bob Removed');
  deletedUserId = await insertPrincipal('Cy Deleted', PRINCIPAL_DELETED_AT);

  // Members of the resource.
  await assign(resourceId, liveUserId);
  await assign(resourceId, removedUserId, ASSIGNMENT_DELETED_AT); // assignment deleted
  await assign(resourceId, deletedUserId);                        // principal deleted

  // Business roles containing the resource; the live one also contains a deleted resource.
  await relate(liveRoleId, resourceId);
  await relate(deletedRoleId, resourceId);
  await relate(liveRoleId, deletedChildId);

  // Assignees of the live business role.
  await assign(liveRoleId, liveUserId);
  await assign(liveRoleId, removedUserId, ASSIGNMENT_DELETED_AT);
  await assign(liveRoleId, deletedUserId);

  // Parent resources (non-business-role parents).
  await relate(liveParentId, resourceId, 'GrantsAccessTo');
  await relate(deletedParentId, resourceId, 'GrantsAccessTo');

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
});

afterAll(() => closeSystemContract(pool, systemId, { refreshPermissions: true }));

// Both assignee lists (resource members, business-role assignees) hold the same
// three people: live, assignment removed, principal deleted.
async function expectLiveThenHistory(path) {
  const res = await agent.get(path);
  expect(res.status).toBe(200);
  expect(res.body).toHaveLength(3);
  const byId = Object.fromEntries(res.body.map((r) => [r.principalId, r]));
  expect(res.body[0].principalId).toBe(liveUserId);
  expect(byId[liveUserId]).toMatchObject({ deleted: false, deletedAt: null });
  expect(byId[removedUserId].deleted).toBe(true);
  sameInstant(byId[removedUserId].deletedAt, ASSIGNMENT_DELETED_AT);
  expect(byId[deletedUserId].deleted).toBe(true);
  sameInstant(byId[deletedUserId].deletedAt, PRINCIPAL_DELETED_AT);
}

describe('GET /resources/:id — counts are current only', () => {
  it('counts the live member, the live business role and the live parents', async () => {
    const res = await agent.get(`/api/resources/${resourceId}`);
    expect(res.status).toBe(200);
    expect(res.body.memberCount).toBe(1);
    expect(res.body.assignmentByType).toEqual({ Direct: 1, Indirect: 0, Eligible: 0 });
    // Live parents: the live business role + the live GrantsAccessTo parent.
    expect(Number(res.body.accessPackageCount)).toBe(1);
    expect(Number(res.body.parentResourceCount)).toBe(2);
  });
});

describe('GET /resources/:id/assignments — current vs historical', () => {
  it('lists the live member first and flags both kinds of history', () =>
    expectLiveThenHistory(`/api/resources/${resourceId}/assignments`));
});

describe('GET /resources/:id/business-roles — a deleted twin is flagged', () => {
  it('lists the live role first; the same-name deleted role carries its deletion time', async () => {
    const res = await agent.get(`/api/resources/${resourceId}/business-roles`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.businessRoleId)).toEqual([liveRoleId, deletedRoleId]);
    expect(res.body[0]).toMatchObject({ businessRoleName: 'Finance Clerk', deleted: false, deletedAt: null });
    expect(res.body[1]).toMatchObject({ businessRoleName: 'Finance Clerk', deleted: true });
    sameInstant(res.body[1].deletedAt, ROLE_DELETED_AT);
  });
});

describe('GET /resources/:id/parent-resources — a deleted parent is flagged', () => {
  it('lists the live parents first and the deleted parent last', async () => {
    const res = await agent.get(`/api/resources/${resourceId}/parent-resources`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.map((r) => [r.parentResourceId, r]));
    expect(Object.keys(byId).sort()).toEqual([liveRoleId, deletedRoleId, liveParentId, deletedParentId].sort());
    expect(byId[liveParentId]).toMatchObject({ deleted: false, deletedAt: null });
    expect(byId[liveRoleId]).toMatchObject({ deleted: false, deletedAt: null });
    expect(byId[deletedParentId].deleted).toBe(true);
    sameInstant(byId[deletedParentId].deletedAt, PARENT_DELETED_AT);
    expect(byId[deletedRoleId].deleted).toBe(true);
    // Current rows first.
    const firstDeleted = res.body.findIndex((r) => r.deleted);
    expect(res.body.slice(firstDeleted).every((r) => r.deleted)).toBe(true);
    expect(firstDeleted).toBe(2);
  });
});

describe('GET /access-package/:id — counts are current only', () => {
  it('counts the live assignee and the live contained resource', async () => {
    const res = await agent.get(`/api/access-package/${liveRoleId}`);
    expect(res.status).toBe(200);
    expect(res.body.assignmentCount).toBe(1);
    expect(res.body.groupCount).toBe(1);
  });
});

describe('GET /access-package/:id/assignments — current vs historical', () => {
  it('lists the live assignee first and flags the deleted assignment and principal', () =>
    expectLiveThenHistory(`/api/access-package/${liveRoleId}/assignments`));
});

describe('GET /access-package/:id/resource-roles — a deleted contained resource is flagged', () => {
  it('lists the live resource first and the deleted one with its deletion time', async () => {
    const res = await agent.get(`/api/access-package/${liveRoleId}/resource-roles`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.childResourceId)).toEqual([resourceId, deletedChildId]);
    expect(res.body[0]).toMatchObject({ deleted: false, deletedAt: null });
    expect(res.body[1].deleted).toBe(true);
    sameInstant(res.body[1].deletedAt, CHILD_DELETED_AT);
  });
});

describe('GET /group/:id — legacy group detail', () => {
  it('counts only the live business role', async () => {
    const res = await agent.get(`/api/group/${resourceId}`);
    expect(res.status).toBe(200);
    expect(res.body.accessPackageCount).toBe(1);
    expect(res.body.memberCount).toBe(1); // matview already excludes deleted rows
  });

  it('/access-packages lists the live role first and flags the deleted twin', async () => {
    const res = await agent.get(`/api/group/${resourceId}/access-packages`);
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.resourceId)).toEqual([liveRoleId, deletedRoleId]);
    expect(res.body[0]).toMatchObject({ accessPackageName: 'Finance Clerk', deleted: false, deletedAt: null });
    expect(res.body[1]).toMatchObject({ accessPackageName: 'Finance Clerk', deleted: true });
    sameInstant(res.body[1].deletedAt, ROLE_DELETED_AT);
  });
});

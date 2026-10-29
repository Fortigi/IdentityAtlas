// Contract test — counts, totals and context membership exclude soft-deleted rows.
//
// A full sync tombstones (sets "deletedAt", migration 040) the Principals,
// Resources and ResourceAssignments that vanished from the source. The rows are
// kept as history, but they are not current: every COUNT / TOTAL / membership
// surface must ignore them. The SQL-blind unit mocks can only assert that a
// `"deletedAt" IS NULL` clause is present; this file proves the counts against
// the real schema, with one live and one deleted row of every kind so a missing
// filter shows up as an off-by-one.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';
import { deleteSystemScopedRows } from '../test-utils/systemScopedCleanup.js';

let agent, pool, systemId, ctxId, baseline;
const ids = {};

async function insertPrincipal(key, deleted) {
  ids[key] = randomUUID();
  await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "principalType", "deletedAt")
     VALUES ($1, $2, $3, 'User', CASE WHEN $4 THEN now() END)`,
    [ids[key], systemId, `softdel-${key}`, deleted],
  );
}

async function insertResource(key, resourceType, deleted) {
  ids[key] = randomUUID();
  await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "deletedAt")
     VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)`,
    [ids[key], systemId, `softdel-${key}`, resourceType, deleted],
  );
}

// One assignment, held by a principal or (identityId) an identity.
async function insertAssignment({ resource, principal = null, identityId = null, governed = false, deleted }) {
  await pool.query(
    `INSERT INTO "ResourceAssignments"
       ("resourceId", "principalId", "identityId", "assignmentType", "systemId", "governed", "deletedAt")
     VALUES ($1, $2, $3, 'Direct', $4, $5, CASE WHEN $6 THEN now() END)`,
    [ids[resource], principal ? ids[principal] : null, identityId, systemId, governed, deleted],
  );
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  // The dashboard counts are tenant-wide, so measure the delta this file adds.
  baseline = (await agent.get('/api/admin/dashboard-stats')).body;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-counts-exclude-deleted') RETURNING "id"`,
  )).rows[0].id;

  await insertPrincipal('liveUser', false);
  await insertPrincipal('goneUser', true);
  await insertResource('liveGroup', 'Group', false);
  await insertResource('goneGroup', 'Group', true);
  await insertResource('liveRole', 'BusinessRole', false);
  await insertResource('goneRole', 'BusinessRole', true);

  await insertAssignment({ resource: 'liveGroup', principal: 'liveUser', deleted: false });
  await insertAssignment({ resource: 'liveGroup', principal: 'goneUser', deleted: true });
  await insertAssignment({ resource: 'liveRole', principal: 'liveUser', governed: true, deleted: false });
  await insertAssignment({ resource: 'goneRole', principal: 'goneUser', governed: true, deleted: true });
  await insertAssignment({ resource: 'liveGroup', identityId: randomUUID(), deleted: false });
  await insertAssignment({ resource: 'goneGroup', identityId: randomUUID(), deleted: true });

  ctxId = randomUUID();
  await pool.query(
    `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "scopeSystemId")
     VALUES ($1, 'synced', 'Principal', 'Department', 'softdel-ctx', $2)`,
    [ctxId, systemId],
  );
  for (const member of ['liveUser', 'goneUser']) {
    await pool.query(
      `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy") VALUES ($1, 'Principal', $2, 'sync')`,
      [ctxId, ids[member]],
    );
  }
});

afterAll(async () => {
  if (pool && systemId != null) {
    await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]); // cascades ContextMembers
  }
  await deleteSystemScopedRows(pool, systemId);
  await pool?.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /systems and /systems/:id — live rows only', () => {
  // Live: liveGroup + liveRole; liveUser; three live assignments.
  const EXPECTED = { resourceCount: 2, principalCount: 1, assignmentCount: 3 };

  it('the systems list counts live resources, principals and assignments', async () => {
    const res = await agent.get('/api/systems');
    expect(res.status).toBe(200);
    const row = res.body.find(s => s.id === systemId);
    expect({
      resourceCount: Number(row.resourceCount),
      principalCount: Number(row.principalCount),
      assignmentCount: Number(row.assignmentCount),
    }).toEqual(EXPECTED);
  });

  it('the system detail counts the same live rows', async () => {
    const res = await agent.get(`/api/systems/${systemId}`);
    expect(res.status).toBe(200);
    expect({
      resourceCount: Number(res.body.resourceCount),
      principalCount: Number(res.body.principalCount),
      assignmentCount: Number(res.body.assignmentCount),
    }).toEqual(EXPECTED);
    expect([...res.body.computedResourceTypes].sort()).toEqual(['BusinessRole', 'Group']);
  });
});

describe('GET /admin/dashboard-stats — exact counts skip deleted rows', () => {
  it('adds one business role, one governed and one identity assignment — not two', async () => {
    const res = await agent.get('/api/admin/dashboard-stats');
    expect(res.status).toBe(200);
    expect(res.body.businessRoles - baseline.businessRoles).toBe(1);
    expect(res.body.governedAssignments - baseline.governedAssignments).toBe(1);
    expect(res.body.identityAssignments - baseline.identityAssignments).toBe(1);
  });
});

describe('context membership — a deleted principal is not a member', () => {
  it('/contexts/:id/members lists and totals the live member only', async () => {
    const res = await agent.get(`/api/contexts/${ctxId}/members`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data.map(m => m.id)).toEqual([ids.liveUser]);
  });

  it('/contexts/:id shows the live member only', async () => {
    const res = await agent.get(`/api/contexts/${ctxId}`);
    expect(res.status).toBe(200);
    expect(res.body.members.map(m => m.id)).toEqual([ids.liveUser]);
  });

  it('recalcMemberCountsForChain stores live direct + total counts', async () => {
    const { recalcMemberCountsForChain } = await import('../src/contexts/memberCounts.js');
    await recalcMemberCountsForChain(ctxId);
    const row = (await pool.query(
      `SELECT "directMemberCount", "totalMemberCount" FROM "Contexts" WHERE id = $1`, [ctxId],
    )).rows[0];
    expect(row).toEqual({ directMemberCount: 1, totalMemberCount: 1 });
  });
});

// Contract test — the `resourceContexts` sidecar on POST /api/matrix/data.
//
// The matrix Contexts column is fed by a batched ContextMembers → Contexts
// join. Wrong table/column names, a missing `::text` cast on memberId (UUID vs
// text), or a dropped memberType guard are exactly the failures a mocked unit
// test can't see — so pin them against the real schema.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
let resourceId;
let otherResourceId;
let principalId;

const ALL_SCOPE = { filter: { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } };

async function insertContext({ targetType, contextType, displayName, variant = 'synced' }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "scopeSystemId")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, variant, targetType, contextType, displayName, systemId],
  );
  return id;
}

async function addMember(contextId, memberType, memberId) {
  await pool.query(
    `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
     VALUES ($1, $2, $3, 'sync')`,
    [contextId, memberType, memberId],
  );
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-matrix-contexts') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  const principal = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "email", "principalType")
     VALUES ($1, 'Ctx Subject', 'ctx.subject@example.com', 'User') RETURNING "id"`,
    [systemId],
  );
  principalId = principal.rows[0].id;

  for (const name of ['Ctx Resource A', 'Ctx Resource B']) {
    const r = await pool.query(
      `INSERT INTO "Resources" ("systemId", "displayName", "resourceType")
       VALUES ($1, $2, 'Group') RETURNING "id"`,
      [systemId, name],
    );
    if (!resourceId) resourceId = r.rows[0].id; else otherResourceId = r.rows[0].id;
  }

  for (const rid of [resourceId, otherResourceId]) {
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType")
       VALUES ($1, $2, 'Direct', $3, 'User')`,
      [rid, principalId, systemId],
    );
  }

  // Resource A: three Resource-targeted contexts — two sharing a contextType so
  // both ORDER BY keys (contextType, then displayName) are pinned — plus an
  // Identity-targeted one that must NOT surface on the resource row.
  const distribution = await insertContext({ targetType: 'Resource', contextType: 'group-category', displayName: 'Distribution', variant: 'manual' });
  const microsoft365 = await insertContext({ targetType: 'Resource', contextType: 'group-category', displayName: 'Microsoft 365', variant: 'generated' });
  const cluster = await insertContext({ targetType: 'Resource', contextType: 'resource-cluster', displayName: 'Cluster A', variant: 'generated' });
  const department = await insertContext({ targetType: 'Identity', contextType: 'department', displayName: 'Payroll' });
  for (const ctxId of [distribution, microsoft365, cluster]) await addMember(ctxId, 'Resource', resourceId);
  await addMember(department, 'Identity', principalId);

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]); // cascades ContextMembers
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('POST /matrix/data — resourceContexts sidecar', () => {
  it('groups Resource-targeted contexts per resource, ordered by contextType then name', async () => {
    const res = await agent.post('/api/matrix/data').send(ALL_SCOPE);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.resourceContexts)).toBe(true);

    const entry = res.body.resourceContexts.find(rc => rc.resourceId === resourceId);
    expect(entry).toBeTruthy();
    expect(entry.contexts.map(c => c.displayName)).toEqual(['Distribution', 'Microsoft 365', 'Cluster A']);
    expect(entry.contexts.map(c => c.contextType)).toEqual(['group-category', 'group-category', 'resource-cluster']);
    expect(entry.contexts.map(c => c.variant)).toEqual(['manual', 'generated', 'generated']);
  });

  it('omits resources with no Resource-targeted memberships', async () => {
    const res = await agent.post('/api/matrix/data').send(ALL_SCOPE);
    expect(res.body.resourceContexts.some(rc => rc.resourceId === otherResourceId)).toBe(false);
  });

  it('never surfaces an Identity-targeted context on a resource row', async () => {
    const res = await agent.post('/api/matrix/data').send(ALL_SCOPE);
    const names = res.body.resourceContexts.flatMap(rc => rc.contexts.map(c => c.displayName));
    expect(names).not.toContain('Payroll');
  });
});

describe('GET /resources/:id/contexts — shares the same join', () => {
  it('returns the resource-targeted contexts for a single resource', async () => {
    const res = await agent.get(`/api/resources/${resourceId}/contexts`);
    expect(res.status).toBe(200);
    expect(res.body.map(c => c.displayName)).toEqual(['Distribution', 'Microsoft 365', 'Cluster A']);
    expect(res.body.every(c => c.targetType === 'Resource')).toBe(true);
  });
});

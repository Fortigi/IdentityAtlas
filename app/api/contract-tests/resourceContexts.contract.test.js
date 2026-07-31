// Contract test — the resourceContexts sidecar of POST /api/matrix/data and
// the shared ContextMembers → Contexts join it reuses (#870).
//
// Verifies against the real PostgreSQL schema that the batched sidecar query
// joins the right tables, groups per resource in (contextType, displayName)
// order, and returns ONLY Resource-targeted memberships — a wrong column,
// cast, or a missing memberType guard is invisible to unit tests (mocked DB)
// but a data leak or 500 in production.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
const resourceIds = [];
let principalId;
let ctxCategory;
let ctxTag;
let ctxTagAudit;
let ctxIdentity;

async function insertContext({ targetType, contextType, name }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "scopeSystemId")
     VALUES ($1, 'generated', $2, $3, $4, $5)`,
    [id, targetType, contextType, name, systemId],
  );
  return id;
}

async function addMember(contextId, memberType, memberId) {
  await pool.query(
    `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
     VALUES ($1, $2, $3, 'algorithm')`,
    [contextId, memberType, memberId],
  );
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-resource-contexts') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  const p = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "principalType") VALUES ($1, 'Ctx Alice', 'User') RETURNING "id"`,
    [systemId],
  );
  principalId = p.rows[0].id;

  for (const name of ['Ctx Group A', 'Ctx Group B', 'Ctx Group C']) {
    const r = await pool.query(
      `INSERT INTO "Resources" ("systemId", "displayName", "resourceType") VALUES ($1, $2, 'Group') RETURNING "id"`,
      [systemId, name],
    );
    resourceIds.push(r.rows[0].id);
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType")
       VALUES ($1, $2, 'Direct', $3, 'User')`,
      [r.rows[0].id, principalId, systemId],
    );
  }

  // Two Resource-targeted contexts + one Identity-targeted context whose
  // member row deliberately reuses a resource's UUID — the sidecar must
  // filter it out on memberType, not just on the id.
  ctxCategory = await insertContext({ targetType: 'Resource', contextType: 'entra-group-category', name: 'Microsoft 365' });
  ctxTag      = await insertContext({ targetType: 'Resource', contextType: 'Tag', name: 'Finance' });
  ctxTagAudit = await insertContext({ targetType: 'Resource', contextType: 'Tag', name: 'Audit' });
  ctxIdentity = await insertContext({ targetType: 'Identity', contextType: 'Department', name: 'Finance Dept' });

  await addMember(ctxCategory, 'Resource', resourceIds[0]);
  await addMember(ctxTag,      'Resource', resourceIds[0]);
  await addMember(ctxTagAudit, 'Resource', resourceIds[0]);
  await addMember(ctxCategory, 'Resource', resourceIds[1]);
  await addMember(ctxIdentity, 'Identity', resourceIds[0]); // must NOT surface

  // The grid reads a materialized view that migrations create unpopulated.
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
  it('groups Resource-targeted contexts per resource in contextType/displayName order', async () => {
    const res = await agent
      .post('/api/matrix/data')
      .send({ filter: { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.resourceContexts)).toBe(true);

    // Scope to our own resources — the contract DB is shared across files.
    const byId = new Map(res.body.resourceContexts.map(rc => [rc.resourceId, rc.contexts]));

    const r0 = byId.get(resourceIds[0]);
    expect(r0).toBeTruthy();
    expect(r0.map(c => c.id).sort()).toEqual([ctxCategory, ctxTag, ctxTagAudit].sort());
    expect(r0).toContainEqual({ id: ctxCategory, displayName: 'Microsoft 365', contextType: 'entra-group-category', variant: 'generated' });
    expect(r0).toContainEqual({ id: ctxTag, displayName: 'Finance', contextType: 'Tag', variant: 'generated' });
    // Within one contextType the SQL orders by displayName: Audit before
    // Finance (same-case, so stable under any DB collation).
    const tagOrder = r0.filter(c => c.contextType === 'Tag').map(c => c.displayName);
    expect(tagOrder).toEqual(['Audit', 'Finance']);

    expect(byId.get(resourceIds[1])).toEqual([
      { id: ctxCategory, displayName: 'Microsoft 365', contextType: 'entra-group-category', variant: 'generated' },
    ]);

    // A resource with no Resource-context membership has no sidecar entry.
    expect(byId.has(resourceIds[2])).toBe(false);
  });

  it('excludes non-Resource memberships even when the member UUID matches', async () => {
    const res = await agent
      .post('/api/matrix/data')
      .send({ filter: { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });

    expect(res.status).toBe(200);
    const r0 = res.body.resourceContexts.find(rc => rc.resourceId === resourceIds[0]);
    expect(r0.contexts.map(c => c.id)).not.toContain(ctxIdentity);
  });
});

describe('GET /resources/:id/contexts — shared join regression', () => {
  it('returns the resource contexts and filters out non-Resource memberships', async () => {
    const res = await agent.get(`/api/resources/${resourceIds[0]}/contexts`);
    expect(res.status).toBe(200);
    expect(res.body.map(c => c.id).sort()).toEqual([ctxCategory, ctxTag, ctxTagAudit].sort());
    expect(res.body.map(c => c.id)).not.toContain(ctxIdentity);
    // Documented shape fields survive the shared-builder swap.
    for (const c of res.body) {
      expect(c).toHaveProperty('displayName');
      expect(c).toHaveProperty('contextType');
      expect(c).toHaveProperty('targetType', 'Resource');
      expect(c).toHaveProperty('variant');
    }
  });
});

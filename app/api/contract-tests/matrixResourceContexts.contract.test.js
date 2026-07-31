// Contract test — the /matrix/data resourceContexts sidecar (#870) against the
// real PostgreSQL schema.
//
// Verifies the batch ContextMembers ⋈ Contexts join uses the right table,
// columns, and uuid→text cast, groups per resource, and returns ONLY
// memberType='Resource' rows — a resource whose id also appears as an
// Identity-targeted member must contribute nothing. Also pins that the shared
// builder still serves GET /resources/:id/contexts (the de-duped join).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
let resourceWithContexts;
let resourceWithout;
let principalId;
const ctxIds = { tag: randomUUID(), category: randomUUID(), dept: randomUUID() };

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-matrix-resource-contexts') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  const p = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "email", "principalType")
     VALUES ($1, 'Ctx Alice', 'ctx-alice@example.com', 'User') RETURNING "id"`,
    [systemId],
  );
  principalId = p.rows[0].id;

  for (const name of ['Ctx Group A', 'Ctx Group B']) {
    const r = await pool.query(
      `INSERT INTO "Resources" ("systemId", "displayName", "resourceType")
       VALUES ($1, $2, 'Group') RETURNING "id"`,
      [systemId, name],
    );
    if (name === 'Ctx Group A') resourceWithContexts = r.rows[0].id;
    else resourceWithout = r.rows[0].id;
  }

  // Both resources visible in the grid via one Direct assignment each.
  for (const rid of [resourceWithContexts, resourceWithout]) {
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType")
       VALUES ($1, $2, 'Direct', $3, 'User')`,
      [rid, principalId, systemId],
    );
  }

  // Two Resource-targeted contexts (contextType values chosen to sort
  // unambiguously in any collation: 'category' < 'tag') and one
  // Identity-targeted context whose member row reuses the resource's id — the
  // memberType filter must exclude it from the sidecar.
  const contexts = [
    [ctxIds.category, 'generated', 'Resource', 'category', 'M365'],
    [ctxIds.tag, 'manual', 'Resource', 'tag', 'Finance'],
    [ctxIds.dept, 'synced', 'Identity', 'Department', 'Finance Dept'],
  ];
  for (const [id, variant, targetType, contextType, name] of contexts) {
    await pool.query(
      `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "scopeSystemId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, variant, targetType, contextType, name, systemId],
    );
  }
  const members = [
    [ctxIds.category, 'Resource', resourceWithContexts, 'algorithm'],
    [ctxIds.tag, 'Resource', resourceWithContexts, 'analyst'],
    [ctxIds.dept, 'Identity', resourceWithContexts, 'sync'], // must NOT surface
  ];
  for (const [contextId, memberType, memberId, addedBy] of members) {
    await pool.query(
      `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
       VALUES ($1, $2, $3, $4)`,
      [contextId, memberType, memberId, addedBy],
    );
  }

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
  it('groups Resource-targeted context memberships per visible resource, server-ordered', async () => {
    const res = await agent
      .post('/api/matrix/data')
      .send({ filter: { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.resourceContexts)).toBe(true);

    const entry = res.body.resourceContexts.find(r => r.resourceId === resourceWithContexts);
    expect(entry).toBeTruthy();
    // Only the two Resource-targeted memberships, ordered by (contextType, displayName).
    expect(entry.contexts.map(c => c.displayName)).toEqual(['M365', 'Finance']);
    expect(entry.contexts.map(c => c.id)).not.toContain(ctxIds.dept);
    expect(entry.contexts[0]).toMatchObject({
      contextType: 'category', targetType: 'Resource', variant: 'generated',
    });

    // A resource with no Resource-context memberships gets no entry at all.
    expect(res.body.resourceContexts.some(r => r.resourceId === resourceWithout)).toBe(false);
  });
});

describe('GET /resources/:id/contexts — shared builder still serves the endpoint', () => {
  it('returns the resource\'s context memberships with the documented columns', async () => {
    const res = await agent.get(`/api/resources/${resourceWithContexts}/contexts`);
    expect(res.status).toBe(200);
    const names = res.body.map(c => c.displayName);
    expect(names).toContain('M365');
    expect(names).toContain('Finance');
    for (const row of res.body) {
      expect(row).toHaveProperty('contextType');
      expect(row).toHaveProperty('targetType');
      expect(row).toHaveProperty('variant');
    }
  });
});

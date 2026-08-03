// Contract test — the matrix Contexts sidecar against a real PostgreSQL schema.
//
// The grid's Contexts column joins "ContextMembers" → "Contexts" and casts the
// visible resource ids to uuid[]. A wrong column name, a wrong cast, or a
// forgotten memberType filter is a silently-empty (or silently-wrong) column in
// production — mocked unit tests can't see any of it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
const resourceIds = [];
const contextIds = [];
let principalId;

const filterBody = { filter: { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } };

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-matrix-contexts') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  const pr = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "email", "principalType")
     VALUES ($1, 'Carol', 'carol@example.com', 'User') RETURNING "id"`,
    [systemId],
  );
  principalId = pr.rows[0].id;

  // Two resources: one in three contexts, one in none.
  for (const name of ['Ctx-Group-A', 'Ctx-Group-B']) {
    const r = await pool.query(
      `INSERT INTO "Resources" ("systemId", "displayName", "resourceType")
       VALUES ($1, $2, 'Group') RETURNING "id"`,
      [systemId, name],
    );
    resourceIds.push(r.rows[0].id);
  }

  for (const [contextType, displayName, targetType] of [
    ['Tag', 'Finance', 'Resource'],
    ['group-category', 'Microsoft 365', 'Resource'],
    ['cluster', 'Cluster-A', 'Resource'],
    ['Department', 'Identity-Only Finance', 'Identity'],
  ]) {
    const c = await pool.query(
      `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "scopeSystemId")
       VALUES (gen_random_uuid(), 'generated', $1, $2, $3, $4) RETURNING "id"`,
      [targetType, contextType, displayName, systemId],
    );
    contextIds.push(c.rows[0].id);
  }

  // Resource-targeted memberships for the first resource…
  for (const contextId of contextIds.slice(0, 3)) {
    await pool.query(
      `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
       VALUES ($1, 'Resource', $2, 'algorithm')`,
      [contextId, resourceIds[0]],
    );
  }
  // …plus an Identity-typed membership carrying the SAME id. It must not surface
  // on the resource row: the sidecar filters on memberType='Resource', and this
  // row is the only thing that proves the filter is actually applied.
  await pool.query(
    `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
     VALUES ($1, 'Identity', $2, 'algorithm')`,
    [contextIds[3], resourceIds[0]],
  );

  for (const resourceId of resourceIds) {
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType")
       VALUES ($1, $2, 'Direct', $3, 'User')`,
      [resourceId, principalId, systemId],
    );
  }

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ContextMembers" WHERE "contextId" = ANY($1::uuid[])`, [contextIds]);
  await pool.query(`DELETE FROM "Contexts" WHERE "id" = ANY($1::uuid[])`, [contextIds]);
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('POST /matrix/data — resourceContexts sidecar', () => {
  it('groups Resource-targeted contexts per resource, ordered by type then name', async () => {
    const res = await agent.post('/api/matrix/data').send(filterBody);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.resourceContexts)).toBe(true);

    const entry = res.body.resourceContexts.find(e => e.resourceId === resourceIds[0]);
    expect(entry).toBeTruthy();
    const labels = entry.contexts.map(c => `${c.contextType}:${c.displayName}`);
    expect(labels.sort()).toEqual(['Tag:Finance', 'cluster:Cluster-A', 'group-category:Microsoft 365'].sort());
    // ORDER BY contextType, displayName — assert the pair whose relative order
    // is collation-independent (both lowercase).
    const order = entry.contexts.map(c => c.contextType);
    expect(order.indexOf('cluster')).toBeLessThan(order.indexOf('group-category'));
  });

  it('omits resources with no Resource-targeted context membership', async () => {
    const res = await agent.post('/api/matrix/data').send(filterBody);
    expect(res.body.resourceContexts.some(e => e.resourceId === resourceIds[1])).toBe(false);
  });

  it('never leaks an Identity-typed membership onto a resource row', async () => {
    const res = await agent.post('/api/matrix/data').send(filterBody);
    const names = res.body.resourceContexts.flatMap(e => e.contexts.map(c => c.displayName));
    expect(names).not.toContain('Identity-Only Finance');
  });

  it('serves the same join for a single resource via GET /resources/:id/contexts', async () => {
    const res = await agent.get(`/api/resources/${resourceIds[0]}/contexts`);
    expect(res.status).toBe(200);
    expect(res.body.map(c => c.displayName).sort()).toEqual(['Cluster-A', 'Finance', 'Microsoft 365']);
  });
});

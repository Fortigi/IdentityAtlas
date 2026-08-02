// Contract test — the /matrix/data flat grid's `resourceContexts` sidecar
// (issue #870) against the real PostgreSQL schema.
//
// Verifies the ContextMembers→Contexts batch join emits valid SQL (table and
// column names, the ::text cast on memberId, the memberType filter) and that
// the response groups contexts per resource — the exact class of failure the
// mocked unit tests cannot catch.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
const resourceIds = [];
const principalIds = [];
const contextIds = { tag: randomUUID(), category: randomUUID(), cluster: randomUUID(), identityDept: randomUUID() };

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-resource-contexts') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  const alice = await pool.query(
    `INSERT INTO "Principals" ("systemId", "displayName", "email", "principalType")
     VALUES ($1, 'Ctx Alice', 'ctx-alice@example.com', 'User') RETURNING "id"`,
    [systemId],
  );
  principalIds.push(alice.rows[0].id);

  // 3 resources: one in 3 contexts, one in 1, one in none.
  for (const name of ['Ctx-Heavy', 'Ctx-Light', 'Ctx-None']) {
    const r = await pool.query(
      `INSERT INTO "Resources" ("systemId", "displayName", "resourceType")
       VALUES ($1, $2, 'Group') RETURNING "id"`,
      [systemId, name],
    );
    resourceIds.push(r.rows[0].id);
  }

  // Every resource needs an assignment to appear as a matrix row.
  for (const resourceId of resourceIds) {
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType")
       VALUES ($1, $2, 'Direct', $3, 'User')`,
      [resourceId, principalIds[0], systemId],
    );
  }

  // Resource-targeted contexts (the kind the column shows) + one
  // Identity-targeted context that must NEVER leak onto a resource row.
  const contexts = [
    [contextIds.tag,          'manual',    'Resource', 'Tag',            'Finance'],
    [contextIds.category,     'generated', 'Resource', 'group-category', 'M365'],
    [contextIds.cluster,      'generated', 'Resource', 'resource-cluster', 'Cluster-A'],
    [contextIds.identityDept, 'synced',    'Identity', 'Department',     'Finance Dept'],
  ];
  for (const [id, variant, targetType, contextType, displayName] of contexts) {
    await pool.query(
      `INSERT INTO "Contexts" ("id", "variant", "targetType", "contextType", "displayName", "scopeSystemId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, variant, targetType, contextType, displayName, systemId],
    );
  }

  const memberships = [
    [contextIds.tag,      'Resource', resourceIds[0]],
    [contextIds.category, 'Resource', resourceIds[0]],
    [contextIds.cluster,  'Resource', resourceIds[0]],
    [contextIds.tag,      'Resource', resourceIds[1]],
    // An Identity-targeted membership sharing a resource's uuid can't happen
    // in practice; the closest real hazard is a memberId that is NOT a
    // resource — the memberType filter must exclude it.
    [contextIds.identityDept, 'Identity', principalIds[0]],
  ];
  for (const [contextId, memberType, memberId] of memberships) {
    await pool.query(
      `INSERT INTO "ContextMembers" ("contextId", "memberType", "memberId", "addedBy")
       VALUES ($1, $2, $3, 'analyst')`,
      [contextId, memberType, memberId],
    );
  }

  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ContextMembers" WHERE "contextId" = ANY($1)`, [Object.values(contextIds)]);
  await pool.query(`DELETE FROM "Contexts" WHERE "id" = ANY($1)`, [Object.values(contextIds)]);
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('POST /matrix/data — resourceContexts sidecar', () => {
  async function fetchSidecar() {
    const res = await agent
      .post('/api/matrix/data')
      .send({ filter: { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.resourceContexts)).toBe(true);
    return new Map(res.body.resourceContexts.map(r => [r.resourceId, r.contexts]));
  }

  it('groups Resource-targeted context memberships per visible resource', async () => {
    const byId = await fetchSidecar();

    const heavy = byId.get(resourceIds[0]);
    expect(heavy).toBeDefined();
    expect(heavy.map(c => c.displayName).sort()).toEqual(['Cluster-A', 'Finance', 'M365']);
    // Each entry carries everything the chips render.
    for (const c of heavy) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('displayName');
      expect(c).toHaveProperty('contextType');
      expect(c).toHaveProperty('variant');
    }

    const light = byId.get(resourceIds[1]);
    expect(light).toBeDefined();
    expect(light.map(c => c.displayName)).toEqual(['Finance']);

    // A resource in no contexts has no sidecar entry (the UI renders the
    // empty state from the map miss).
    expect(byId.has(resourceIds[2])).toBe(false);
  });

  it('sorts each resource\'s contexts by contextType then displayName (server-side)', async () => {
    const byId = await fetchSidecar();
    const heavy = byId.get(resourceIds[0]);
    // Re-derive the expected order from the DB's own collation so the pin is
    // deterministic regardless of the container's locale.
    const expected = (await pool.query(
      `SELECT "displayName" FROM "Contexts"
        WHERE "id" = ANY($1) ORDER BY "contextType", "displayName"`,
      [[contextIds.tag, contextIds.category, contextIds.cluster]],
    )).rows.map(r => r.displayName);
    expect(heavy.map(c => c.displayName)).toEqual(expected);
  });

  it('never returns non-Resource memberships on a resource row', async () => {
    const byId = await fetchSidecar();
    const allNames = [...byId.values()].flat().map(c => c.displayName);
    expect(allNames).not.toContain('Finance Dept'); // Identity-targeted context
    expect(byId.has(principalIds[0])).toBe(false);  // principal memberId filtered out
  });
});

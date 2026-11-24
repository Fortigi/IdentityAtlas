// Contract test — the team overview's SQL over real PostgreSQL: a role covers
// what it Contains for the person who holds it, not for a colleague who holds
// the same resource by hand; a removed assignment no longer counts.
// Invented people only; everything hangs off its own system and is removed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
const id = { unit: randomUUID(), ann: randomUUID(), bob: randomUUID(), role: randomUUID(), group: randomUUID(), loose: randomUUID(), gone: randomUUID() };
const q = (sql, params) => pool.query(sql, params);
const assign = (resourceId, principalId, extra = '', governed = false) => q(
  `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", governed${extra ? ', "deletedAt"' : ''})
   VALUES ($1, $2, 'Direct', $3, $4${extra ? ', now()' : ''})`, [resourceId, principalId, systemId, governed]);

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  systemId = (await q(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('Test', 'team-overview-contract') RETURNING id`)).rows[0].id;
  await q(`INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName")
           VALUES ($1, 'manual', 'Principal', 'Department', 'OrganizationalUnit', 'TO Unit')`, [id.unit]);
  for (const [pid, name] of [[id.ann, 'Ann TO'], [id.bob, 'Bob TO']]) {
    await q(`INSERT INTO "Principals" (id, "systemId", "externalId", "displayName", "principalType") VALUES ($1, $2, $3, $4, 'User')`, [pid, systemId, `to-${pid}`, name]);
    await q(`INSERT INTO "ContextMembers" ("contextId", "memberId", "memberType", "addedBy") VALUES ($1, $2, 'Principal', 'analyst')`, [id.unit, pid]);
  }
  const resource = (rid, name, type, gov) => q(
    `INSERT INTO "Resources" (id, "systemId", "externalId", "displayName", "resourceType", "governanceResource") VALUES ($1, $2, $3, $4, $5, $6)`,
    [rid, systemId, `to-${rid}`, name, type, gov]);
  await resource(id.role, 'TO Role', 'BusinessRole', true);
  await resource(id.group, 'TO Group', 'Group', false);
  await resource(id.loose, 'TO Loose', 'Group', false);
  await resource(id.gone, 'TO Gone', 'Group', false);
  await q(`INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId") VALUES ($1, $2, 'Contains', $3)`, [id.role, id.group, systemId]);
  await assign(id.role, id.ann, '', true);
  await q(`UPDATE "ResourceAssignments" SET origin = 'Requested', "originDetail" = 'Request and approve' WHERE "resourceId" = $1`, [id.role]);
  await assign(id.group, id.ann);
  await assign(id.loose, id.ann);
  await assign(id.gone, id.ann, 'deleted');
  await assign(id.group, id.bob);
  await q(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
});

afterAll(async () => {
  await q(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "ContextMembers" WHERE "contextId" = $1`, [id.unit]);
  await q(`DELETE FROM "Contexts" WHERE id = $1`, [id.unit]);
  await q(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
  await q(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
});

describe('GET /api/contexts/:id/team-overview', () => {
  it('counts per person what THEIR roles do not cover, and reports the role changes', async () => {
    const res = await agent.get(`/api/contexts/${id.unit}/team-overview`);
    expect(res.status).toBe(200);
    const ann = res.body.people.find(p => p.id === id.ann);
    const bob = res.body.people.find(p => p.id === id.bob);
    // Ann: TO Group (covered by her role) + TO Loose; TO Gone is removed.
    expect(ann).toMatchObject({ permissions: 2, ungoverned: 1 });
    // Bob holds the same group by hand and has no role, so it is ungoverned for him.
    expect(bob).toMatchObject({ permissions: 1, ungoverned: 1 });
    expect(res.body.roles).toEqual([{
      // No policy says how the role is run; Ann's request makes her hold it by hand.
      id: id.role, displayName: 'TO Role', control: 'Unknown', holders: [id.ann],
      origins: { [id.ann]: { origin: 'Requested', originDetail: 'Request and approve', control: 'Manual' } },
    }]);
    expect(res.body.changes.filter(c => c.type === 'role-added').map(c => [c.personId, c.roleName])).toEqual([[id.ann, 'TO Role']]);
  });

  it('lists one member\'s ungoverned permissions by name, and refuses someone outside the unit', async () => {
    const res = await agent.get(`/api/contexts/${id.unit}/team-overview/${id.ann}/ungoverned`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ truncated: false, items: [{ id: id.loose, displayName: 'TO Loose', resourceType: 'Group', how: 'Direct' }] });
    const bob = await agent.get(`/api/contexts/${id.unit}/team-overview/${id.bob}/ungoverned`);
    expect(bob.body.items.map(i => i.id)).toEqual([id.group]);
    expect((await agent.get(`/api/contexts/${id.unit}/team-overview/${randomUUID()}/ungoverned`)).status).toBe(404);
  });

  it('counts inherited access through a group in the person\'s role as governed, but not a direct grant or someone else\'s', async () => {
    const parent = randomUUID(); const inherited = randomUUID(); const direct = randomUUID();
    for (const [rid, name] of [[parent, 'TO Parent'], [inherited, 'TO Inherited'], [direct, 'TO DirectToo']]) {
      await q(`INSERT INTO "Resources" (id, "systemId", "externalId", "displayName", "resourceType") VALUES ($1, $2, $3, $4, 'Group')`, [rid, systemId, `to-${rid}`, name]);
    }
    const grant = (resourceId, principalId, type, principalType = 'User') => q(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId") VALUES ($1, $2, $3, $4, $5)`,
      [resourceId, principalId, type, principalType, systemId]);
    // The role's group is inside TO Parent, which is inside TO Inherited: two levels deep.
    await grant(parent, id.group, 'Direct', 'Group');
    await grant(inherited, parent, 'Direct', 'Group');
    await grant(direct, id.group, 'Direct', 'Group');
    await grant(inherited, id.ann, 'Indirect');
    await grant(direct, id.ann, 'Direct');
    await grant(inherited, id.bob, 'Indirect');

    const names = async (who) => (await agent.get(`/api/contexts/${id.unit}/team-overview/${who}/ungoverned`)).body.items.map(i => i.displayName).sort();
    expect(await names(id.ann)).toEqual(['TO DirectToo', 'TO Loose']);
    expect(await names(id.bob)).toEqual(['TO Group', 'TO Inherited']);
    const { body } = await agent.get(`/api/contexts/${id.unit}/team-overview`);
    expect(body.people.find(p => p.id === id.ann).ungoverned).toBe(2);
    expect(body.people.find(p => p.id === id.bob).ungoverned).toBe(2);

    await q(`DELETE FROM "ResourceAssignments" WHERE "resourceId" = ANY($1::uuid[])`, [[parent, inherited, direct]]);
    await q(`DELETE FROM "Resources" WHERE id = ANY($1::uuid[])`, [[parent, inherited, direct]]);
  });

  it('still reports who joined when the unit\'s own row changed thousands of times since', async () => {
    await q(`INSERT INTO "_history" ("tableName", "rowId", operation, "changedAt", "rowData", "prevData")
             SELECT 'Contexts', $1, 'U', now() + (n || ' seconds')::interval,
                    jsonb_build_object('id', $1::text, 'displayName', 'TO Unit ' || n), jsonb_build_object('id', $1::text, 'displayName', 'TO Unit')
               FROM generate_series(1, 2100) n`, [id.unit]);
    const res = await agent.get(`/api/contexts/${id.unit}/team-overview`);
    expect(res.body.changes.filter(c => c.type === 'joined').map(c => c.personId).sort()).toEqual([id.ann, id.bob].sort());
    expect(res.body.truncated).toBe(false);
    await q(`DELETE FROM "_history" WHERE "tableName" = 'Contexts' AND "rowId" = $1`, [id.unit]);
  });
});

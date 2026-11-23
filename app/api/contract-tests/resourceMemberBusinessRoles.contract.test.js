// Contract test: the "Business roles" of a context's resource members over real
// PostgreSQL. Only a live governance resource with a Contains link counts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
const id = { app: randomUUID(), held: randomUUID(), free: randomUUID(), roleB: randomUUID(), roleA: randomUUID(), gone: randomUUID(), plain: randomUUID(), other: randomUUID() };
const q = (sql, params) => pool.query(sql, params);
const resource = (rid, name, type, governance, deleted = false) => q(
  `INSERT INTO "Resources" (id, "systemId", "externalId", "displayName", "resourceType", "governanceResource", "deletedAt")
   VALUES ($1, $2, $3, $4, $5, $6, ${deleted ? 'now()' : 'NULL'})`, [rid, systemId, `brc-${rid}`, name, type, governance]);
const link = (parent, child, type = 'Contains', roleName = null) => q(
  `INSERT INTO "ResourceRelationships" ("parentResourceId", "childResourceId", "relationshipType", "systemId", "roleName") VALUES ($1, $2, $3, $4, $5)`,
  [parent, child, type, systemId, roleName]);

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  systemId = (await q(`INSERT INTO "Systems" ("systemType", "displayName") VALUES ('Test', 'business-role-column-contract') RETURNING id`)).rows[0].id;
  await q(`INSERT INTO "Contexts" (id, variant, "targetType", "contextType", "contextCategory", "displayName")
           VALUES ($1, 'manual', 'Resource', 'Application', 'LogicalApplication', 'BRC App')`, [id.app]);
  await resource(id.held, 'BRC Held', 'Group', false);
  await resource(id.free, 'BRC Free', 'Group', false);
  await resource(id.roleB, 'BRC Role B', 'BusinessRole', true);
  await resource(id.roleA, 'BRC Role A', 'BusinessRole', true);
  await resource(id.gone, 'BRC Role Gone', 'BusinessRole', true, true);
  await resource(id.plain, 'BRC Plain Parent', 'Group', false);
  await resource(id.other, 'BRC Role Other Link', 'BusinessRole', true);
  for (const member of [id.held, id.free]) {
    await q(`INSERT INTO "ContextMembers" ("contextId", "memberId", "memberType", "addedBy") VALUES ($1, $2, 'Resource', 'analyst')`, [id.app, member]);
  }
  await link(id.roleB, id.held);
  await link(id.roleA, id.held, 'Contains', 'Member');
  await link(id.gone, id.held);
  await link(id.plain, id.held);
  await link(id.other, id.held, 'GrantsAccessTo');
});

afterAll(async () => {
  await q(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "ContextMembers" WHERE "contextId" = $1`, [id.app]);
  await q(`DELETE FROM "Contexts" WHERE id = $1`, [id.app]);
  await q(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await q(`DELETE FROM "Systems" WHERE id = $1`, [systemId]);
});

describe('GET /api/contexts/:id/members — business roles', () => {
  it('lists the live roles that contain a resource, by name, and an empty list for one in none', async () => {
    const res = await agent.get(`/api/contexts/${id.app}/members`);
    expect(res.status).toBe(200);
    const of = rid => res.body.data.find(m => m.id === rid).businessRoles;
    expect(of(id.held)).toEqual([{ id: id.roleA, displayName: 'BRC Role A' }, { id: id.roleB, displayName: 'BRC Role B' }]);
    expect(of(id.free)).toEqual([]);
  });
});

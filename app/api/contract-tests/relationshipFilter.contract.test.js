// Contract test — the #840 relationship filter against the real PostgreSQL 16
// schema, end-to-end through the list endpoints (supertest) so the resolver SQL,
// the route wiring, and the availability endpoint are all exercised against real
// tables. These are the fixture-backed acceptance criteria (AC1–AC11).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';
import { findUncoveredRelationshipTypes } from '../src/relationships/edgeCatalog.js';

let agent, pool;
const ids = {};

// Insert helpers ------------------------------------------------------------
async function newResource(systemId, name, type) {
  return (await pool.query(
    `INSERT INTO "Resources" ("id","systemId","displayName","resourceType","enabled")
     VALUES (gen_random_uuid(),$1,$2,$3,true) RETURNING "id"`,
    [systemId, name, type],
  )).rows[0].id;
}
async function newPrincipal(systemId, name, type, ext = null) {
  return (await pool.query(
    `INSERT INTO "Principals" ("id","systemId","displayName","email","principalType","extendedAttributes")
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING "id"`,
    [systemId, name, `${name}@x.test`, type, ext],
  )).rows[0].id;
}
async function assign(systemId, resourceId, principalId) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","systemId")
     VALUES ($1,$2,'Direct',$3)`,
    [resourceId, principalId, systemId],
  );
}
async function ownership(systemId, ownedId, ownershipType, relType, owners) {
  const ownId = await newResource(systemId, `own-${ownedId}`, ownershipType);
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","systemId")
     VALUES ($1,$2,$3,$4)`,
    [ownedId, ownId, relType, systemId],
  );
  for (const o of owners) await assign(systemId, ownId, o);
}
async function principalRel(systemId, subjectId, relatedId, relType) {
  await pool.query(
    `INSERT INTO "PrincipalRelationships" ("principalId","relatedPrincipalId","relationshipType","systemId")
     VALUES ($1,$2,$3,$4)`,
    [subjectId, relatedId, relType, systemId],
  );
}

// GET /api/resources|users, returning the set of matching ids ---------------
async function listIds(path, { filters, relFilters }) {
  const q = new URLSearchParams();
  if (filters) q.set('filters', JSON.stringify(filters));
  if (relFilters) q.set('relFilters', JSON.stringify(relFilters));
  q.set('limit', '1000');
  const res = await agent.get(`${path}?${q}`);
  expect(res.status).toBe(200);
  return new Set(res.body.data.map((r) => r.id));
}

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());
  const systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','rel-filter') RETURNING "id"`,
  )).rows[0].id;
  ids.systemId = systemId;

  // Groups + one application.
  ids.G1 = await newResource(systemId, 'G1', 'Group');
  ids.G2 = await newResource(systemId, 'G2', 'Group');
  ids.G3 = await newResource(systemId, 'G3', 'Group');
  ids.APP1 = await newResource(systemId, 'APP1', 'Application');

  // Owners/members pool.
  const P = {};
  for (const n of ['PM1', 'PM2', 'PO1', 'PO2', 'PO3']) P[n] = await newPrincipal(systemId, n, 'User');

  // G1: 2 members, 2 owners. G2: 0 members, 1 owner. G3: 0 members, 0 owners.
  await assign(systemId, ids.G1, P.PM1);
  await assign(systemId, ids.G1, P.PM2);
  await ownership(systemId, ids.G1, 'GroupOwnership', 'HasOwnership', [P.PO1, P.PO2]);
  await ownership(systemId, ids.G2, 'GroupOwnership', 'HasOwnership', [P.PO1]);
  // APP1: 1 owner via app ownership (proves the HasAppOwnership arm).
  await ownership(systemId, ids.APP1, 'ApplicationOwnership', 'HasAppOwnership', [P.PO3]);

  // AI agents: A1 has an owner, A2 does not.
  ids.A1 = await newPrincipal(systemId, 'A1', 'AIAgent');
  ids.A2 = await newPrincipal(systemId, 'A2', 'AIAgent');
  await principalRel(systemId, ids.A1, P.PO1, 'Owner');

  // Guests: U1 has a sponsor, U2 does not (both userType=Guest in extendedAttributes).
  ids.U1 = await newPrincipal(systemId, 'U1', 'User', { userType: 'Guest' });
  ids.U2 = await newPrincipal(systemId, 'U2', 'User', { userType: 'Guest' });
  await principalRel(systemId, ids.U1, P.PO1, 'Sponsor');
});

afterAll(async () => {
  // Contract tests share ONE Postgres DB, so this file must remove everything it
  // seeded — otherwise its extra principals/resources leak into other suites
  // (e.g. the export-paging contract) and break their row-count assertions.
  const sid = ids.systemId;
  await pool.query(`DELETE FROM "PrincipalRelationships" WHERE "systemId" = $1`, [sid]);
  await pool.query(`DELETE FROM "ResourceAssignments"  WHERE "systemId" = $1`, [sid]);
  await pool.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [sid]);
  if (ids.tagId) {
    await pool.query(`DELETE FROM "ContextMembers" WHERE "contextId" = $1`, [ids.tagId]);
    await pool.query(`DELETE FROM "Contexts" WHERE "id" = $1`, [ids.tagId]);
  }
  await pool.query(`DELETE FROM "Resources"  WHERE "systemId" = $1`, [sid]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [sid]);
  await pool.query(`DELETE FROM "Systems"    WHERE "id" = $1`, [sid]);
  await pool.end();
  delete process.env.USE_SQL;
});

describe('resource edges (Resources list)', () => {
  it('AC1 — groups with no owners', async () => {
    const got = await listIds('/api/resources', { filters: { resourceType: 'Group' }, relFilters: [{ edge: 'resource.owners', op: 'absent' }] });
    expect(got).toEqual(new Set([ids.G3]));
  });

  it('AC2 — groups with fewer than 2 owners', async () => {
    const got = await listIds('/api/resources', { filters: { resourceType: 'Group' }, relFilters: [{ edge: 'resource.owners', op: 'lt', n: 2 }] });
    expect(got).toEqual(new Set([ids.G2, ids.G3]));
  });

  it('AC3 — groups with no members', async () => {
    const got = await listIds('/api/resources', { filters: { resourceType: 'Group' }, relFilters: [{ edge: 'resource.members', op: 'absent' }] });
    expect(got).toEqual(new Set([ids.G2, ids.G3]));
  });

  it('AC3b — applications with no owners (app-ownership arm)', async () => {
    const got = await listIds('/api/resources', { filters: { resourceType: 'Application' }, relFilters: [{ edge: 'resource.owners', op: 'absent' }] });
    expect(got).toEqual(new Set()); // APP1 has an owner via HasAppOwnership
  });
});

describe('principal edges (Users list)', () => {
  it('AC4 — AI agents with no owner', async () => {
    const got = await listIds('/api/users', { filters: { principalType: 'AIAgent' }, relFilters: [{ edge: 'principal.owner', op: 'absent' }] });
    expect(got).toEqual(new Set([ids.A2]));
  });

  it('AC5 — guests with no sponsor', async () => {
    const got = await listIds('/api/users', { filters: { 'ext.userType': 'Guest' }, relFilters: [{ edge: 'principal.sponsor', op: 'absent' }] });
    expect(got).toEqual(new Set([ids.U2]));
  });

  it('AC6 — guests with a sponsor (exists is the inverse of absent)', async () => {
    const got = await listIds('/api/users', { filters: { 'ext.userType': 'Guest' }, relFilters: [{ edge: 'principal.sponsor', op: 'exists' }] });
    expect(got).toEqual(new Set([ids.U1]));
  });
});

describe('AC7/AC8/AC9 — empty + error handling', () => {
  it('AC7 — empty relFilters behaves like no relFilters', async () => {
    const withEmpty = await listIds('/api/resources', { filters: { resourceType: 'Group' }, relFilters: [] });
    const without = await listIds('/api/resources', { filters: { resourceType: 'Group' } });
    expect(withEmpty).toEqual(without);
    expect(without.size).toBe(3);
  });

  it('AC8 — unknown edge id returns 400', async () => {
    const res = await agent.get(`/api/resources?relFilters=${encodeURIComponent(JSON.stringify([{ edge: 'bogus', op: 'absent' }]))}`);
    expect(res.status).toBe(400);
  });

  it('AC9 — negative n returns 400', async () => {
    const res = await agent.get(`/api/resources?relFilters=${encodeURIComponent(JSON.stringify([{ edge: 'resource.owners', op: 'lt', n: -1 }]))}`);
    expect(res.status).toBe(400);
  });

  it('rejects a principal edge on the resource list (400)', async () => {
    const res = await agent.get(`/api/resources?relFilters=${encodeURIComponent(JSON.stringify([{ edge: 'principal.owner', op: 'absent' }]))}`);
    expect(res.status).toBe(400);
  });
});

describe('AC10 — availability endpoint', () => {
  it('lists Principal edges with availability true where data exists', async () => {
    const res = await agent.get('/api/relationship-edges?entity=Principal');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.edges.map((e) => [e.id, e]));
    expect(byId['principal.sponsor'].available).toBe(true); // U1 has a sponsor
    expect(byId['principal.owner'].available).toBe(true);   // A1 has an owner
    expect(byId['principal.sponsor'].ops).toContain('absent');
  });

  it('accepts the list entityType alias and rejects an unknown entity', async () => {
    expect((await agent.get('/api/relationship-edges?entity=resource')).status).toBe(200);
    expect((await agent.get('/api/relationship-edges?entity=Nonsense')).status).toBe(400);
  });
});

describe('AC11 — assign-by-filter honours relFilters', () => {
  it('tags only the entities matching the relationship condition', async () => {
    const tagId = (await pool.query(
      `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName")
       VALUES (gen_random_uuid(),'manual','Principal','Tag','rel-tag') RETURNING "id"`,
    )).rows[0].id;
    ids.tagId = tagId; // recorded so afterAll can clean it up

    const res = await agent
      .post(`/api/tags/${tagId}/assign-by-filter`)
      .send({ entityType: 'user', filters: { 'ext.userType': 'Guest' }, relFilters: [{ edge: 'principal.sponsor', op: 'absent' }] });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1); // only U2 (no sponsor), not U1

    const members = (await pool.query(`SELECT "memberId" FROM "ContextMembers" WHERE "contextId" = $1`, [tagId])).rows;
    expect(members.map((m) => m.memberId)).toEqual([ids.U2]);
  });
});

describe('coverage guard — catalog covers the data', () => {
  it('every relationship type in the seeded data is catalogued or ignored', async () => {
    const rr = (await pool.query(`SELECT DISTINCT "relationshipType" FROM "ResourceRelationships"`)).rows.map((r) => r.relationshipType);
    const pr = (await pool.query(`SELECT DISTINCT "relationshipType" FROM "PrincipalRelationships"`)).rows.map((r) => r.relationshipType);
    expect(findUncoveredRelationshipTypes({ resourceRelTypes: rr, principalRelTypes: pr })).toEqual([]);
  });
});

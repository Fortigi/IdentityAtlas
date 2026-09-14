// Contract test — POST /api/matrix/data against a real PostgreSQL schema.
//
// Verifies the matrix data endpoint's SQL runs against the real schema and the
// materialized view, and returns the documented shape. The matrix grid is the
// product's core surface; a wrong column name or view name here is a 500 in
// production that unit tests (which mock the DB) cannot catch.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent;
let pool;
let systemId;
const resourceIds = [];
const principalIds = [];
const identityIds = {};

beforeAll(async () => {
  ({ agent, pool } = await bootContractApp());

  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-matrix-data') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;

  // 2 principals (subjects).
  for (const name of ['Alice', 'Bob']) {
    const r = await pool.query(
      `INSERT INTO "Principals" ("systemId", "displayName", "email", "principalType")
       VALUES ($1, $2, $3, 'User') RETURNING "id"`,
      [systemId, name, `${name.toLowerCase()}@example.com`],
    );
    principalIds.push(r.rows[0].id);
  }

  // 3 resources.
  for (const name of ['Engineering', 'Finance', 'Sales']) {
    const r = await pool.query(
      `INSERT INTO "Resources" ("systemId", "displayName", "resourceType")
       VALUES ($1, $2, 'Group') RETURNING "id"`,
      [systemId, name],
    );
    resourceIds.push(r.rows[0].id);
  }

  // 5 assignments across the two principals: 4 Direct + 1 Indirect, so the
  // matview's Direct/Indirect breakdown is exercised (Phase 3 regression pin).
  const pairs = [
    [resourceIds[0], principalIds[0], 'Direct'],
    [resourceIds[1], principalIds[0], 'Direct'],
    [resourceIds[2], principalIds[0], 'Direct'],
    [resourceIds[0], principalIds[1], 'Direct'],
    [resourceIds[1], principalIds[1], 'Indirect'],
  ];
  for (const [resourceId, principalId, assignmentType] of pairs) {
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType")
       VALUES ($1, $2, $3, $4, 'User')`,
      [resourceId, principalId, assignmentType, systemId],
    );
  }

  // Two identities over the same two principals, so the identity row type has
  // something to return. Alice's identity carries a linked-account count; Bob's
  // is NULL — the state of an identity the linking engine never rolled up, which
  // the grid has to render as "nothing to expand into" rather than a blank.
  for (const [key, name, principalId, accountCount] of [
    ['alice', 'Alice Person', principalIds[0], 2],
    ['bob', 'Bob Person', principalIds[1], null],
  ]) {
    const r = await pool.query(
      `INSERT INTO "Identities" ("id", "displayName", "accountCount")
       VALUES (gen_random_uuid(), $1, $2) RETURNING "id"`,
      [name, accountCount],
    );
    identityIds[key] = r.rows[0].id;
    await pool.query(
      `INSERT INTO "IdentityMembers" ("identityId", "principalId", "isPrimary") VALUES ($1, $2, true)`,
      [identityIds[key], principalId],
    );
  }

  // The grid reads a materialized view that migrations create unpopulated.
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
});

afterAll(async () => {
  // IdentityMembers cascades off Identities.
  await pool.query(`DELETE FROM "Identities" WHERE "id" = ANY($1::uuid[])`, [Object.values(identityIds)]);
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('POST /matrix/data — flat grid', () => {
  it('returns 200 with the documented shape and the seeded assignments', async () => {
    const res = await agent
      .post('/api/matrix/data')
      .send({ filter: { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(typeof res.body.subjectTotal).toBe('number');
    expect(typeof res.body.resourceTotal).toBe('number');

    // subjectTotal / resourceTotal are GLOBAL counts (every Principal / Resource
    // in the DB), and the contract suite shares one singleFork database where
    // other files leave rows behind — so assert our seed is *included*, not the
    // exact totals.
    expect(res.body.subjectTotal).toBeGreaterThanOrEqual(2);
    expect(res.body.resourceTotal).toBeGreaterThanOrEqual(3);

    // Scope the row assertions to our own resources (unique uuids) so they're
    // deterministic regardless of any leftover rows from other test files.
    const ourRows = res.body.data.filter(r => resourceIds.includes(r.resourceId));
    expect(ourRows.length).toBe(5); // the 5 seeded assignments
    for (const row of ourRows) {
      expect(principalIds).toContain(row.memberId);
      expect(['Direct', 'Indirect']).toContain(row.membershipType);
    }
  });

  // Phase 3 regression pin: the matview must preserve the Direct/Indirect
  // distinction (assignmentType → membershipType CASE, migration 043). A change
  // that collapses them would silently merge access categories in the grid.
  // A failing pin here without a feature PR is a bug — investigate, don't delete.
  it('preserves the Direct vs Indirect membership breakdown', async () => {
    const res = await agent
      .post('/api/matrix/data')
      .send({ filter: { subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });
    expect(res.status).toBe(200);
    const ourRows = res.body.data.filter(r => resourceIds.includes(r.resourceId));
    const breakdown = ourRows.reduce((acc, r) => { acc[r.membershipType] = (acc[r.membershipType] || 0) + 1; return acc; }, {});
    expect(breakdown).toEqual({ Direct: 4, Indirect: 1 });
  });

  // #1212: the matrix header shows how many accounts an identity expands into,
  // which means the count has to arrive WITH the grid rows. Only a real database
  // can say whether the column is selected once, under that name, and whether
  // the NULL an un-rolled-up identity carries comes back as 0.
  it('ships a linked-account count with every identity row', async () => {
    const res = await agent
      .post('/api/matrix/data')
      .send({ filter: { rowType: 'identity', subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });

    expect(res.status).toBe(200);
    expect(res.body.rowType).toBe('identity');
    const ourRows = res.body.data.filter(r => resourceIds.includes(r.resourceId));
    expect(ourRows.length).toBeGreaterThan(0);

    const byIdentity = new Map(ourRows.map(r => [r.memberId, r.accountCount]));
    expect(byIdentity.get(identityIds.alice)).toBe(2);
    // NULL normalises to 0 — a blank would badge the header with nothing at all
    // and an absent key would make it look like the API stopped sending it.
    expect(byIdentity.get(identityIds.bob)).toBe(0);
  });

  it('sends no account count on a principal grid, where a subject IS an account', async () => {
    const res = await agent
      .post('/api/matrix/data')
      .send({ filter: { rowType: 'principal', subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });
    expect(res.status).toBe(200);
    const ourRows = res.body.data.filter(r => resourceIds.includes(r.resourceId));
    expect(ourRows.length).toBe(5);
    for (const row of ourRows) expect(row).not.toHaveProperty('accountCount');
  });
});

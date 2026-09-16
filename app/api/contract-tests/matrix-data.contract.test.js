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

  // 3 principals (subjects). Carol holds no assignments of her own — she exists
  // only as a second account under Alice's identity, so the identity grid's
  // account count can differ from the number of accounts that carry access.
  for (const name of ['Alice', 'Bob', 'Carol']) {
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

  // Two identities, so the identity row type has something to return — seeded so
  // the denormalised "Identities"."accountCount" DISAGREES with the real member
  // rows in both directions. Alice's says 99 while she has 2 accounts; Bob's is
  // NULL (the state of every identity the account-linking engine never rolled
  // up, which is most of them) while he has 1. A grid that read the stored
  // column instead of counting would answer 99 and nothing at all (#1212).
  for (const [key, name, memberPrincipalIds, storedCount] of [
    ['alice', 'Alice Person', [principalIds[0], principalIds[2]], 99],
    ['bob', 'Bob Person', [principalIds[1]], null],
  ]) {
    const r = await pool.query(
      `INSERT INTO "Identities" ("id", "displayName", "accountCount")
       VALUES (gen_random_uuid(), $1, $2) RETURNING "id"`,
      [name, storedCount],
    );
    identityIds[key] = r.rows[0].id;
    for (const [idx, principalId] of memberPrincipalIds.entries()) {
      await pool.query(
        `INSERT INTO "IdentityMembers" ("identityId", "principalId", "isPrimary") VALUES ($1, $2, $3)`,
        [identityIds[key], principalId, idx === 0],
      );
    }
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
  // can say whether the column is selected once, under that name, and whether it
  // reports what IdentityMembers actually holds rather than the stored roll-up.
  it('counts an identity\'s accounts live, ignoring the stale stored roll-up', async () => {
    const res = await agent
      .post('/api/matrix/data')
      .send({ filter: { rowType: 'identity', subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });

    expect(res.status).toBe(200);
    expect(res.body.rowType).toBe('identity');
    const ourRows = res.body.data.filter(r => resourceIds.includes(r.resourceId));
    expect(ourRows.length).toBeGreaterThan(0);

    const byIdentity = new Map(ourRows.map(r => [r.memberId, r.accountCount]));
    // 2 real member rows, stored column says 99: the badge has to promise the
    // number of columns the expand endpoint will actually return.
    expect(byIdentity.get(identityIds.alice)).toBe(2);
    // 1 real member row, stored column is NULL: this is the case the requestor
    // hit — a count that silently rendered as nothing on an identity that does
    // expand into accounts.
    expect(byIdentity.get(identityIds.bob)).toBe(1);
  });

  // The count is the promise "expanding gives you this many columns", so it has
  // to agree with the endpoint that fulfils it — against the same seeded data,
  // through a completely separate query.
  it('agrees with the account-matrix endpoint the expand actually calls', async () => {
    const grid = await agent
      .post('/api/matrix/data')
      .send({ filter: { rowType: 'identity', subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } } });
    const row = grid.body.data.find(r => r.memberId === identityIds.alice);
    expect(row).toBeDefined();

    const expand = await agent.get(`/api/identities/${identityIds.alice}/account-matrix`);
    expect(expand.status).toBe(200);
    expect(row.accountCount).toBe(expand.body.accounts.length);
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

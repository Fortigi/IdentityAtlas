// Contract test — routes/systems.js against the real PostgreSQL 16 schema.
//
// Guards #679: routes/systems.js was written against the v4 (SQL Server) schema
// and never fully migrated to v5 (postgres). The SQL-blind + validation-blind
// unit mocks (systems.test.js) hid three schema-mismatch bugs that only surface
// against the real schema:
//
//   1. `:id` validation. Systems.id is SERIAL (integer) in v5, but every systems
//      route gated `:id` on a 36-char UUID regex — so a real integer system id
//      (e.g. "5") returned 400 and the SQL never ran. The unit test passed
//      because it used a fabricated UUID as the id.
//   2. GET /systems/:id/owners joined the non-existent GraphUsers table (fixed to
//      Principals in #678). A mocked db never notices a bad JOIN — this pins it.
//   3. POST /systems/:id/owners INSERTed columns (role/assignedDateTime/assignedBy)
//      that SystemOwners doesn't have, and detected the duplicate-owner conflict
//      with SQL-Server error strings ('UNIQUE'/'PRIMARY') postgres never emits.
//
// These are exactly the query bugs a mocked unit test can't see (#679).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool, systemId, ownerId, otherId;

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;
  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-systems-owners') RETURNING "id"`,
  )).rows[0].id;
  // Two principals in the same system: one seeded as an owner, one not.
  ownerId = (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType")
     VALUES (gen_random_uuid(), $1, 'Zoe Owner', 'zoe@example.com', 'User') RETURNING "id"`,
    [systemId],
  )).rows[0].id;
  otherId = (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType")
     VALUES (gen_random_uuid(), $1, 'Not An Owner', 'no@example.com', 'User') RETURNING "id"`,
    [systemId],
  )).rows[0].id;
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "SystemOwners" WHERE "systemId" = $1`, [systemId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "SystemOwners" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /systems/:id — real integer id + counts', () => {
  it('resolves an integer system id (not a UUID) and returns the row', async () => {
    const res = await agent.get(`/api/systems/${systemId}`);
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('contract-systems-owners');
    // principalCount is a real aggregate against the seeded Principals.
    expect(Number(res.body.principalCount)).toBe(2);
  });

  it('404s a non-existent (but well-formed integer) id', async () => {
    const res = await agent.get('/api/systems/2147483647');
    expect(res.status).toBe(404);
  });

  it('400s a non-integer id', async () => {
    const res = await agent.get('/api/systems/not-a-number');
    expect(res.status).toBe(400);
  });
});

describe('GET /systems/:id/owners — joins Principals against the real schema', () => {
  it('returns the seeded owner joined to Principals (would fail on the old GraphUsers join)', async () => {
    await pool.query(
      `INSERT INTO "SystemOwners" ("systemId", "userId") VALUES ($1, $2)`,
      [systemId, ownerId],
    );
    const res = await agent.get(`/api/systems/${systemId}/owners`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // The joined Principals columns — present ONLY if the LEFT JOIN resolved
    // against a real table. With the old `JOIN GraphUsers` this endpoint threw
    // and its catch returned [], so these would be absent.
    expect(res.body[0].userDisplayName).toBe('Zoe Owner');
    expect(res.body[0].userPrincipalName).toBe('zoe@example.com');
  });

  it('returns an empty list for a system with no owners', async () => {
    const res = await agent.get(`/api/systems/${systemId}/owners`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST/DELETE /systems/:id/owners — write path against the real schema', () => {
  it('adds an owner, then lists it, then removes it', async () => {
    const add = await agent.post(`/api/systems/${systemId}/owners`).send({ userId: ownerId });
    expect(add.status).toBe(201);
    expect(add.body.userId).toBe(ownerId);

    const list = await agent.get(`/api/systems/${systemId}/owners`);
    expect(list.body.map(o => o.userId)).toContain(ownerId);

    const del = await agent.delete(`/api/systems/${systemId}/owners/${ownerId}`);
    expect(del.status).toBe(200);
    const after = await agent.get(`/api/systems/${systemId}/owners`);
    expect(after.body).toEqual([]);
  });

  it('409s when the same owner is added twice (postgres duplicate-key, not a 500)', async () => {
    await agent.post(`/api/systems/${systemId}/owners`).send({ userId: otherId });
    const dup = await agent.post(`/api/systems/${systemId}/owners`).send({ userId: otherId });
    expect(dup.status).toBe(409);
  });
});

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
       VALUES ($1, $2, 'EntraGroup') RETURNING "id"`,
      [systemId, name],
    );
    resourceIds.push(r.rows[0].id);
  }

  // 5 Direct assignments across the two principals.
  const pairs = [
    [resourceIds[0], principalIds[0]],
    [resourceIds[1], principalIds[0]],
    [resourceIds[2], principalIds[0]],
    [resourceIds[0], principalIds[1]],
    [resourceIds[1], principalIds[1]],
  ];
  for (const [resourceId, principalId] of pairs) {
    await pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "systemId", "principalType")
       VALUES ($1, $2, 'Direct', $3, 'User')`,
      [resourceId, principalId, systemId],
    );
  }

  // The grid reads a materialized view that migrations create unpopulated.
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_ResourceUserPermissionAssignments"`);
  await pool.query(`REFRESH MATERIALIZED VIEW "vw_UserPermissionAssignmentViaBusinessRole"`);
});

afterAll(async () => {
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

    // Regression pins on the fresh contract DB: 2 principals, 3 resources.
    expect(res.body.subjectTotal).toBe(2);
    expect(res.body.resourceTotal).toBe(3);

    // The seeded Direct assignments surface through the materialized view.
    expect(res.body.data.length).toBe(5);
    const row = res.body.data[0];
    expect(row).toHaveProperty('resourceId');
    expect(row).toHaveProperty('memberId');
    expect(row).toHaveProperty('membershipType');
    expect(resourceIds).toContain(res.body.data[0].resourceId);
  });
});

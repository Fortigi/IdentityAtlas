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
});

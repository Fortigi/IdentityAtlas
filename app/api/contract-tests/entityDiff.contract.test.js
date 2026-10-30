// Contract test — the Diff tab's "then vs now" snapshots, against the real
// PostgreSQL 16 schema and its _history audit trigger.
//
// Set up a user, take a moment T, then change things the way the ingest does:
// an attribute edit, a new manager, a removed assignment (soft delete), a new
// business role. The diff at T must show the old state on the left and the new
// state on the right; an untouched assignment must be on both sides.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';
import { deleteSystemScopedRows } from '../test-utils/systemScopedCleanup.js';

let agent, pool, systemId, userId, oldMgr, newMgr, keptRole, removedRole, addedRole, at;

async function insertPrincipal(name, managerId = null) {
  return (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "principalType", "department", "managerId")
     VALUES (gen_random_uuid(), $1, $2, 'User', 'Sales', $3) RETURNING "id"`,
    [systemId, name, managerId],
  )).rows[0].id;
}

async function insertRole(name) {
  return (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "governanceResource")
     VALUES (gen_random_uuid(), $1, $2, 'BusinessRole', true) RETURNING "id"`,
    [systemId, name],
  )).rows[0].id;
}

async function assign(resourceId) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId", "resourceType")
     VALUES ($1, $2, 'Direct', 'User', $3, 'BusinessRole')`,
    [resourceId, userId, systemId],
  );
}

const labels = (snap) => snap.relationships.map((i) => `${i.group}:${i.label}`).sort();

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-entity-diff') RETURNING "id"`,
  )).rows[0].id;

  oldMgr = await insertPrincipal('Alice Old');
  newMgr = await insertPrincipal('Bob New');
  userId = await insertPrincipal('Carol Diff', oldMgr);
  keptRole = await insertRole('Diff Kept Role');
  removedRole = await insertRole('Diff Removed Role');
  addedRole = await insertRole('Diff Added Role');
  await assign(keptRole);
  await assign(removedRole);

  // T travels as a JavaScript Date, which keeps milliseconds only. Without the
  // pause, the setup rows above can fall in T's own millisecond, land after the
  // truncated T and so be missing from the "before" side.
  await pool.query(`SELECT pg_sleep(0.002)`);
  at = (await pool.query(`SELECT clock_timestamp() AS t`)).rows[0].t;

  await pool.query(`UPDATE "Principals" SET "department" = 'Finance', "managerId" = $2 WHERE "id" = $1`, [userId, newMgr]);
  await pool.query(
    `UPDATE "ResourceAssignments" SET "deletedAt" = now() WHERE "resourceId" = $1 AND "principalId" = $2`,
    [removedRole, userId]);
  await assign(addedRole);
});

afterAll(async () => {
  await deleteSystemScopedRows(pool, systemId);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /user/:id/diff', () => {
  it('shows the user as it was at T on the left and as it is now on the right', async () => {
    const res = await agent.get(`/api/user/${userId}/diff`).query({ at: new Date(at).toISOString() });
    expect(res.status).toBe(200);
    const { before, after } = res.body;

    expect(before).toMatchObject({ exists: true, deleted: false });
    expect(before.attributes.department).toBe('Sales');
    expect(after.attributes.department).toBe('Finance');

    expect(labels(before)).toEqual([
      'Business roles:Diff Kept Role', 'Business roles:Diff Removed Role', 'Manager:Alice Old',
    ]);
    expect(labels(after)).toEqual([
      'Business roles:Diff Added Role', 'Business roles:Diff Kept Role', 'Manager:Bob New',
    ]);
    expect(res.body.omittedUnchanged).toBe(0);
    expect(res.body.historySince).toBeTruthy();
  });

  it('reports a user that did not exist yet as not existing', async () => {
    const longAgo = new Date(new Date(at).getTime() - 3_600_000).toISOString();
    const res = await agent.get(`/api/user/${userId}/diff`).query({ at: longAgo });
    expect(res.status).toBe(200);
    expect(res.body.before.exists).toBe(false);
    expect(res.body.before.relationships).toEqual([]);
    expect(res.body.after.exists).toBe(true);
  });
});

describe('GET /access-package/:id/diff', () => {
  it('shows the member who left on the left only', async () => {
    const res = await agent.get(`/api/access-package/${removedRole}/diff`).query({ at: new Date(at).toISOString() });
    expect(res.status).toBe(200);
    expect(labels(res.body.before)).toEqual(['Members:Carol Diff']);
    expect(labels(res.body.after)).toEqual([]);
  });
});

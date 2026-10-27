// Contract test — a user's Timeline shows removals that happen as soft deletes,
// against the real PostgreSQL 16 schema and its _history audit trigger.
//
// Found on a customer tenant: a user's business role was removed and the role
// itself deleted in the source, yet the user's Timeline showed neither. A
// removal stamps deletedAt (an UPDATE in _history), and the timeline only
// looked for inserts and hard deletes. A deleted role was invisible on the
// user's timeline for a second reason: only the role's row changes, not the
// user's assignment row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootContractApp } from '../test-utils/contractApp.js';

let agent, pool, systemId, userId, removedRoleId, deletedRoleId, untouchedRoleId;

async function insertRole(name) {
  return (await pool.query(
    `INSERT INTO "Resources" ("id", "systemId", "displayName", "resourceType", "governanceResource")
     VALUES (gen_random_uuid(), $1, $2, 'BusinessRole', true) RETURNING "id"`,
    [systemId, name],
  )).rows[0].id;
}

async function assign(resourceId) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId", "principalId", "assignmentType", "principalType", "systemId")
     VALUES ($1, $2, 'Direct', 'User', $3)`,
    [resourceId, userId, systemId],
  );
}

beforeAll(async () => {
  const booted = await bootContractApp();
  agent = booted.agent;
  pool = booted.pool;

  systemId = (await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName")
     VALUES ('test', 'contract-user-timeline-soft-delete') RETURNING "id"`,
  )).rows[0].id;

  userId = (await pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "email", "principalType")
     VALUES (gen_random_uuid(), $1, 'Timeline User', 'timeline@example.com', 'User') RETURNING "id"`,
    [systemId],
  )).rows[0].id;

  removedRoleId = await insertRole('Head of Sales');
  deletedRoleId = await insertRole('Head of Finance');
  untouchedRoleId = await insertRole('Head of Legal');
  await assign(removedRoleId);
  await assign(deletedRoleId);
  await assign(untouchedRoleId);

  // The two ways access disappears, both as the ingest does them: an UPDATE.
  await pool.query(
    `UPDATE "ResourceAssignments" SET "deletedAt" = now()
      WHERE "resourceId" = $1 AND "principalId" = $2`, [removedRoleId, userId]);
  await pool.query(`UPDATE "Resources" SET "deletedAt" = now() WHERE "id" = $1`, [deletedRoleId]);
  // An ordinary edit to a held role must stay off the user's timeline.
  await pool.query(`UPDATE "Resources" SET "description" = 'edited' WHERE "id" = $1`, [untouchedRoleId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL; // singleFork — env mutations leak across files
});

describe('GET /user/:id/timeline — soft deletes', () => {
  it('shows the additions, the removed assignment and the deleted role', async () => {
    const res = await agent.get(`/api/user/${userId}/timeline`);
    expect(res.status).toBe(200);
    const summaries = res.body.events.map((e) => e.summary);

    expect(summaries).toContain('Added to Head of Sales (Direct)');
    expect(summaries).toContain('Removed from Head of Sales (Direct)');
    expect(summaries).toContain('Head of Finance deleted in source');

    const removal = res.body.events.find((e) => e.summary === 'Removed from Head of Sales (Direct)');
    expect(removal).toMatchObject({ operation: 'removed', counterpartyKind: 'access-package', counterpartyId: removedRoleId });
    const roleGone = res.body.events.find((e) => e.summary === 'Head of Finance deleted in source');
    expect(roleGone).toMatchObject({ operation: 'removed', counterpartyId: deletedRoleId });

    // The edit to a held role is that role's business, not the user's.
    expect(summaries.some((s) => s.includes('Head of Legal') && !s.startsWith('Added to'))).toBe(false);
    expect(res.body.removedCount).toBe(2);
    expect(res.body.addedCount).toBe(3);
  });

  it('the deleted role\'s own timeline reads "Deleted in source", not an attribute diff', async () => {
    const res = await agent.get(`/api/access-package/${deletedRoleId}/timeline`);
    expect(res.status).toBe(200);
    const summaries = res.body.events.map((e) => e.summary);
    expect(summaries).toContain('Deleted in source');
    expect(summaries.some((s) => s.startsWith('Deleted At'))).toBe(false);
  });
});

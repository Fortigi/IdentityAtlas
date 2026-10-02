// Contract test — the stored context assignment counts against real PostgreSQL.
//
// The unit test can only look at the statement's text. This is where the
// statement runs: three CTE passes over Contexts, ContextMembers, Resources and
// ResourceAssignments, written back with one UPDATE. Every number below is a
// different number, so a swapped column, a missed de-duplication or a counted
// soft-delete shows up as a wrong value rather than a coincidence.
//
// The database is shared with the other contract files, so everything seeded
// here hangs off its own system and is asserted by id.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { bootContractApp } from '../test-utils/contractApp.js';
import { refreshContextAssignmentCounts } from '../src/contexts/assignmentCounts.js';

let pool;
let systemId;

const id = {
  busy: randomUUID(),       // two live entitlements with holders, plus rows that must not count
  idle: randomUUID(),       // one entitlement nobody holds
  empty: randomUUID(),      // a resource context with no members
  people: randomUUID(),     // an Identity context: never counted
  entA: randomUUID(), entB: randomUUID(), entIdle: randomUUID(),
  entDeleted: randomUUID(), ownership: randomUUID(),
  ada: randomUUID(), bob: randomUUID(), cy: randomUUID(),
};

const context = (cid, displayName, targetType) => pool.query(
  `INSERT INTO "Contexts" ("id","variant","targetType","contextType","displayName","scopeSystemId")
   VALUES ($1,'synced',$2,'ContractCounts',$3,$4)`, [cid, targetType, displayName, systemId]);

const principal = (pid, displayName) => pool.query(
  `INSERT INTO "Principals" ("id","systemId","displayName","principalType","extendedAttributes")
   VALUES ($1,$2,$3,'User','{}'::jsonb)`, [pid, systemId, displayName]);

const resource = (rid, displayName, resourceType, deleted = false) => pool.query(
  `INSERT INTO "Resources" ("id","systemId","displayName","resourceType","deletedAt")
   VALUES ($1,$2,$3,$4,$5)`, [rid, systemId, displayName, resourceType, deleted ? new Date() : null]);

const member = (cid, rid) => pool.query(
  `INSERT INTO "ContextMembers" ("contextId","memberType","memberId","addedBy") VALUES ($1,'Resource',$2,'sync')`, [cid, rid]);

const assignment = (rid, pid, type, { governed = false, deleted = false } = {}) => pool.query(
  `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","governed","systemId","deletedAt")
   VALUES ($1,$2,$3,$4,$5,$6)`, [rid, pid, type, governed, systemId, deleted ? new Date() : null]);

const stored = async (cid) => (await pool.query(
  `SELECT "resourceCount","directAssignmentCount","indirectAssignmentCount","eligibleAssignmentCount","holderCount"
     FROM "Contexts" WHERE id = $1`, [cid])).rows[0];

const historyRows = async () => (await pool.query(
  `SELECT count(*)::int AS n FROM "_history" WHERE "tableName" = 'Contexts' AND "rowId" = ANY($1::text[])`,
  [[id.busy, id.idle, id.empty, id.people]])).rows[0].n;

beforeAll(async () => {
  ({ pool } = await bootContractApp());
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-context-assignment-counts') RETURNING "id"`);
  systemId = sys.rows[0].id;

  await context(id.busy, 'Counts Busy', 'Resource');
  await context(id.idle, 'Counts Idle', 'Resource');
  await context(id.empty, 'Counts Empty', 'Resource');
  await context(id.people, 'Counts People', 'Identity');

  await principal(id.ada, 'Ada');
  await principal(id.bob, 'Bob');
  await principal(id.cy, 'Cy');

  await resource(id.entA, 'ENT_A', 'Entitlement');
  await resource(id.entB, 'ENT_B', 'Entitlement');
  await resource(id.entIdle, 'ENT_IDLE', 'Entitlement');
  await resource(id.entDeleted, 'ENT_DELETED', 'Entitlement', true);
  await resource(id.ownership, 'ENT_A', 'ResourceOwnership');

  // Five members, two of which must not count: a deleted resource and an
  // ownership row.
  for (const rid of [id.entA, id.entB, id.entDeleted, id.ownership]) await member(id.busy, rid);
  await member(id.idle, id.entIdle);

  // ENT_A: Ada directly (stored twice, as the governed intent/actual pair) and
  // Bob directly; Cy through a role.
  await assignment(id.entA, id.ada, 'Direct');
  await assignment(id.entA, id.ada, 'Direct', { governed: true });
  await assignment(id.entA, id.bob, 'Direct');
  await assignment(id.entA, id.cy, 'Indirect');
  // ENT_B: Ada directly again (a second assignment, the same holder), Bob eligible.
  await assignment(id.entB, id.ada, 'Direct');
  await assignment(id.entB, id.bob, 'Eligible');
  // Must not count: a removed assignment, and holders of rows that are not resources of the context.
  await assignment(id.entB, id.cy, 'Direct', { deleted: true });
  await assignment(id.entDeleted, id.cy, 'Direct');
  await assignment(id.ownership, id.cy, 'Direct');
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Contexts" WHERE "scopeSystemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  delete process.env.USE_SQL;
});

describe('context assignment counts (contract)', () => {
  it('are empty until the first refresh', async () => {
    expect(await stored(id.busy)).toEqual({
      resourceCount: null, directAssignmentCount: null, indirectAssignmentCount: null,
      eligibleAssignmentCount: null, holderCount: null,
    });
  });

  it('count assignments per kind and holders once, skipping what is deleted or not a resource', async () => {
    const result = await refreshContextAssignmentCounts(pool);
    expect(result.updated).toBeGreaterThanOrEqual(3);

    expect(await stored(id.busy)).toEqual({
      resourceCount: 2,              // ENT_A, ENT_B
      directAssignmentCount: 3,      // Ada+Bob on A (the twin row is one), Ada on B
      indirectAssignmentCount: 1,    // Cy on A
      eligibleAssignmentCount: 1,    // Bob on B
      holderCount: 3,                // Ada, Bob, Cy — Bob's eligibility alone would not make him one
    });
  });

  it('say 0, not empty, for a counted context that has nothing', async () => {
    expect(await stored(id.idle)).toEqual({
      resourceCount: 1, directAssignmentCount: 0, indirectAssignmentCount: 0, eligibleAssignmentCount: 0, holderCount: 0,
    });
    expect(await stored(id.empty)).toEqual({
      resourceCount: 0, directAssignmentCount: 0, indirectAssignmentCount: 0, eligibleAssignmentCount: 0, holderCount: 0,
    });
  });

  it('stay empty on a context that does not group resources', async () => {
    expect((await stored(id.people)).resourceCount).toBeNull();
    expect((await stored(id.people)).holderCount).toBeNull();
  });

  it('write nothing, and no audit row, when nothing changed', async () => {
    const before = await historyRows();
    await refreshContextAssignmentCounts(pool);
    expect(await historyRows()).toBe(before);
  });

  it('follow the data on the next refresh', async () => {
    await assignment(id.entIdle, id.cy, 'Indirect');
    await refreshContextAssignmentCounts(pool);
    expect(await stored(id.idle)).toMatchObject({ indirectAssignmentCount: 1, directAssignmentCount: 0, holderCount: 1 });
    // The other context is untouched by it.
    expect((await stored(id.busy)).holderCount).toBe(3);
  });
});

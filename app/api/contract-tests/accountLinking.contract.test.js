// Contract test — the account-linking run against a real PostgreSQL schema.
//
// The engine's unit tests mock db/connection.js and dispatch on SQL fragments,
// so they prove the write loop's decisions but say nothing about which rows the
// orphan queries actually select. This file runs the real runLinking against
// the contract database and asserts on the IdentityMembers rows and the
// orphansRemaining statistic it leaves behind.
//
// What it pins (#1442): a principal that a full sync has soft-deleted
// (reconcileStale stamps "deletedAt" instead of removing the row) is not a
// linking candidate and is not counted as a remaining orphan.
//
// The database is shared with the other contract files, so the membership
// assertion is scoped to this file's own identity and the orphan count is
// asserted as a delta rather than an absolute.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import pg from 'pg';

const SYSTEM_NAME = 'contract-account-linking';
// Distinct enough that no other contract file's fixtures can match it.
const EMPLOYEE_ID = 'AL-CT-E123';

let pool;
let systemId;
let engine;

const ids = {
  identity: randomUUID(),
  live: randomUUID(),
  departed: randomUUID(),
  unmatched: randomUUID(),
};

beforeAll(async () => {
  // db/connection.js builds its pool lazily from DATABASE_URL, so this has to
  // be set before the engine issues its first query.
  process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
  // The run ends by enqueueing the orphaned-accounts context plugin. That is a
  // fire-and-forget background job against the shared database and is not what
  // this file is testing — stub it, as the engine unit tests do.
  vi.doMock('../src/contexts/plugins/runner.js', () => ({ enqueueRun: vi.fn(async () => {}) }));
  engine = await import('../src/accountlinking/engine.js');

  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', $1) RETURNING "id"`, [SYSTEM_NAME],
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM "AccountLinkingRuns" WHERE "triggeredBy" = 'contract-test'`);
  await pool.query(`DELETE FROM "Identities" WHERE "id" = $1`, [ids.identity]); // cascades IdentityMembers
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool.end();
  vi.doUnmock('../src/contexts/plugins/runner.js');
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "Identities" WHERE "id" = $1`, [ids.identity]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
});

function insertPrincipal(id, displayName, employeeId) {
  return pool.query(
    `INSERT INTO "Principals" ("id", "systemId", "displayName", "employeeId", "principalType", "extendedAttributes")
     VALUES ($1, $2, $3, $4, 'User', '{}'::jsonb)`,
    [id, systemId, displayName, employeeId],
  );
}

/** What a full-sync reconcile does to a principal missing from the source. */
function softDelete(id) {
  return pool.query(`UPDATE "Principals" SET "deletedAt" = now() WHERE "id" = $1`, [id]);
}

/** Run linking to completion and return the finished AccountLinkingRuns row. */
async function runLinking() {
  const run = await engine.startAccountLinkingRun('contract-test', { awaitCompletion: true });
  const r = await pool.query(`SELECT * FROM "AccountLinkingRuns" WHERE "id" = $1`, [run.id]);
  return r.rows[0];
}

async function membersOfOwnIdentity() {
  const r = await pool.query(
    `SELECT "principalId" FROM "IdentityMembers" WHERE "identityId" = $1`, [ids.identity]);
  return r.rows.map(row => row.principalId);
}

describe('runLinking — soft-deleted principals', () => {
  it('links the live account but never a soft-deleted one that matches just as strongly', async () => {
    // Both accounts carry the identity's employeeId — an exact signal at weight
    // 95, well over the default linkThreshold of 50 — and both classify as
    // Secondary, so the only thing separating them is the deletedAt stamp.
    await pool.query(
      `INSERT INTO "Identities" ("id", "displayName", "employeeId") VALUES ($1, 'Robin Euson', $2)`,
      [ids.identity, EMPLOYEE_ID]);
    await insertPrincipal(ids.live, 'Euson, Robin', EMPLOYEE_ID);
    await insertPrincipal(ids.departed, 'Euson, Robin (old tenant)', EMPLOYEE_ID);
    await softDelete(ids.departed);

    expect((await runLinking()).status).toBe('completed');

    // Control and regression in one assertion: the live twin must link (so a
    // change that simply stopped linking would also go red), the departed twin
    // must not.
    expect(await membersOfOwnIdentity()).toEqual([ids.live]);
  });

  it('does not count a soft-deleted account in orphansRemaining', async () => {
    // Baseline first, with none of our principals present; then add a single
    // soft-deleted account that matches no identity. The count is global to the
    // shared database, so assert the delta.
    const before = (await runLinking()).orphansRemaining;

    await insertPrincipal(ids.unmatched, 'Ghost Account', 'AL-CT-E999');
    await softDelete(ids.unmatched);

    expect((await runLinking()).orphansRemaining).toBe(before);
  });
});

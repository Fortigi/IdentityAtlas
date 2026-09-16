// Contract test — a FULL sync that carries no records still reconciles.
//
// A crawler reconciles a source down to zero by sending an empty full-sync
// batch: tools/crawlers/shared/Invoke-CrawlerIngest.ps1 does exactly that
// ("Empty full-sync batch so the server scoped-deletes stale rows"). Two things
// used to stop it working, and both are asserted here against a real schema:
//
//   1. the request was rejected with 400 "records array cannot be empty"
//      (validateRecordsArray), and
//   2. even once accepted, ingest() returned early on an empty array —
//      before the scoped delete ran — so nothing was tombstoned.
//
// The visible symptom was a SCIM endpoint that legitimately served no groups
// failing its entire sync, and an emptied source keeping its old rows forever.
//
// The blast radius matters as much as the delete: an empty full batch must
// clear ONLY its own (systemId, scope) partition. A crawler phase sends one per
// scope, so a wipe that ignored the scope would delete other phases' rows.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { deleteEntireScope } from '../src/ingest/engine.js';
import { validateRecordsArray } from '../src/ingest/validation.helpers.js';

let pool;
let systemId;
let otherSystemId;

const GROUP_A = '33333333-3333-3333-3333-333333333331';
const GROUP_B = '33333333-3333-3333-3333-333333333332';
const U1 = 'cccccccc-cccc-cccc-cccc-cccccccccc01';
const U2 = 'cccccccc-cccc-cccc-cccc-cccccccccc02';

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const a = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'empty-full-sync') RETURNING "id"`);
  systemId = a.rows[0].id;
  const b = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'empty-full-sync-other') RETURNING "id"`);
  otherSystemId = b.rows[0].id;
});

afterAll(async () => {
  for (const s of [systemId, otherSystemId]) {
    await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [s]);
    await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [s]);
  }
  await pool?.end();
});

beforeEach(async () => {
  for (const s of [systemId, otherSystemId]) {
    await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [s]);
  }
});

async function insertRA(sys, resourceId, principalId, assignmentType, resourceType) {
  await pool.query(
    `INSERT INTO "ResourceAssignments"
       ("systemId", "resourceId", "principalId", "assignmentType", "resourceType", "principalType")
     VALUES ($1, $2, $3, $4, $5, 'User')`,
    [sys, resourceId, principalId, assignmentType, resourceType]);
}

async function liveCount(sys, resourceType) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM "ResourceAssignments"
      WHERE "systemId" = $1 AND "resourceType" = $2 AND "deletedAt" IS NULL`,
    [sys, resourceType]);
  return r.rows[0].n;
}

const KEYS = ['resourceId', 'principalId', 'assignmentType'];
// Supplied rather than discovered: discovery goes through the app's db module,
// which does not point at this container.
const RA_COLS = new Set(['systemId', 'resourceId', 'principalId', 'identityId', 'assignmentType',
                         'resourceType', 'principalType', 'deletedAt']);
// Driven through this file's own pool, the way engine.contract.test.js drives
// scopedDelete: the engine's module-level db points at the app's DATABASE_URL,
// not the contract container. ingest()'s decision to call this for an empty full
// batch is covered by the route tests in src/routes/ingest.coverage.test.js.
async function emptyFullSync(scope) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted = await deleteEntireScope(
      client, 'ResourceAssignments', KEYS, systemId, scope, 'systemId', '"principalId" IS NOT NULL', RA_COLS);
    await client.query('COMMIT');
    return { inserted: 0, updated: 0, deleted };
  } finally {
    client.release();
  }
}

describe('empty full sync — the request is accepted', () => {
  it('validation allows a full batch with no records, and still rejects an empty delta', () => {
    expect(validateRecordsArray({ records: [], syncMode: 'full' })).toEqual([]);
    expect(validateRecordsArray({ records: [], syncMode: 'delta' }))
      .toEqual(['records array cannot be empty']);
  });
});

describe('empty full sync — the rows are reconciled away', () => {
  it('tombstones every row in the scope', async () => {
    await insertRA(systemId, GROUP_A, U1, 'Direct', 'Group');
    await insertRA(systemId, GROUP_B, U2, 'Direct', 'Group');
    expect(await liveCount(systemId, 'Group')).toBe(2);

    const result = await emptyFullSync({ resourceType: 'Group' });

    expect(await liveCount(systemId, 'Group')).toBe(0);
    expect(result.deleted).toBe(2);
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('leaves another scope in the SAME system untouched', async () => {
    // One phase per scope: emptying the group-members phase must not wipe the
    // app-role rows another phase owns.
    await insertRA(systemId, GROUP_A, U1, 'Direct', 'Group');
    await insertRA(systemId, GROUP_B, U2, 'Direct', 'AppRole');

    await emptyFullSync({ resourceType: 'Group' });

    expect(await liveCount(systemId, 'Group')).toBe(0);
    expect(await liveCount(systemId, 'AppRole')).toBe(1);
  });

  it('leaves the same scope in ANOTHER system untouched', async () => {
    await insertRA(systemId, GROUP_A, U1, 'Direct', 'Group');
    await insertRA(otherSystemId, GROUP_B, U2, 'Direct', 'Group');

    await emptyFullSync({ resourceType: 'Group' });

    expect(await liveCount(systemId, 'Group')).toBe(0);
    expect(await liveCount(otherSystemId, 'Group')).toBe(1);
  });

  it('is idempotent — a second empty sync deletes nothing more', async () => {
    await insertRA(systemId, GROUP_A, U1, 'Direct', 'Group');
    await emptyFullSync({ resourceType: 'Group' });
    const second = await emptyFullSync({ resourceType: 'Group' });
    expect(second.deleted).toBe(0);
  });
});

describe('empty delta sync — nothing is touched', () => {
  it('is not reconciled at all: delta says nothing about what is absent', () => {
    // The mode check lives in ingest(), which only reaches the wipe for a full
    // sync; the route test asserts it hands an empty delta over and gets a no-op.
    expect(validateRecordsArray({ records: [], syncMode: 'delta' }))
      .toEqual(['records array cannot be empty']);
    expect(validateRecordsArray({ records: [], deletedIds: ['x'], syncMode: 'delta' })).toEqual([]);
  });
});

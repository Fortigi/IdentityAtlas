// Contract test — the resource-axis reconcile partition for ResourceAssignments.
//
// Assignment-model redesign phase 2 collapses the Entra "source" types
// (AppRole/OAuth2Grant/DirectoryRole/…) into Direct/Indirect/Eligible. Once
// several crawler phases all write 'Direct', a phase's full-sync reconcile MUST
// be partitioned by resourceType — otherwise the group-members phase (which
// scopes assignmentType='Direct') would soft-delete the AppRole/OAuth2 'Direct'
// rows that live on other resource types. This test proves, against a real
// schema, that adding resourceType to the scope keeps the delete inside its own
// (assignmentType, resourceType) partition — and that omitting it does NOT.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { scopedDelete } from '../src/ingest/engine.js';

let pool;
let systemId;

const RA_COLS = new Set([
  'systemId', 'resourceId', 'principalId', 'identityId', 'assignmentType',
  'resourceType', 'principalType', 'deletedAt',
]);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'assign-partition') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  // Clean up our rows so we don't pollute sibling contract files (shared DB).
  await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
});

async function insertRA(resourceId, principalId, assignmentType, resourceType) {
  await pool.query(
    `INSERT INTO "ResourceAssignments"
       ("systemId", "resourceId", "principalId", "assignmentType", "resourceType", "principalType")
     VALUES ($1, $2, $3, $4, $5, 'User')`,
    [systemId, resourceId, principalId, assignmentType, resourceType],
  );
}

async function deletedAt(resourceId, principalId, assignmentType) {
  const r = await pool.query(
    `SELECT "deletedAt" FROM "ResourceAssignments"
      WHERE "resourceId" = $1 AND "principalId" = $2 AND "assignmentType" = $3`,
    [resourceId, principalId, assignmentType],
  );
  return r.rows[0]?.deletedAt ?? null;
}

async function makeTemp(client, name, keys) {
  await client.query(
    `CREATE TEMP TABLE "${name}" ("resourceId" UUID, "principalId" UUID, "assignmentType" TEXT) ON COMMIT DROP`,
  );
  for (const k of keys) {
    await client.query(
      `INSERT INTO "${name}" ("resourceId", "principalId", "assignmentType") VALUES ($1, $2, $3)`,
      [k.resourceId, k.principalId, k.assignmentType],
    );
  }
}

// Stable uuids for readability.
const GROUP = '11111111-1111-1111-1111-111111111111';
const APPROLE = '22222222-2222-2222-2222-222222222222';
const U1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('ResourceAssignments reconcile — resource-axis partition', () => {
  it('scoping by resourceType keeps the delete inside its own partition (AppRole Direct survives a group-members reconcile)', async () => {
    await insertRA(GROUP, U1, 'Direct', 'Group');   // in the batch -> keep
    await insertRA(GROUP, U2, 'Direct', 'Group');   // absent from batch -> soft-delete
    await insertRA(APPROLE, U1, 'Direct', 'AppRole');    // other partition -> MUST survive

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await makeTemp(client, 'tmp_ra_keep', [{ resourceId: GROUP, principalId: U1, assignmentType: 'Direct' }]);
      const deleted = await scopedDelete(
        client, 'ResourceAssignments',
        ['resourceId', 'principalId', 'assignmentType'],
        'tmp_ra_keep', systemId,
        { assignmentType: 'Direct', resourceType: 'Group' },
        'systemId', RA_COLS,
      );
      await client.query('COMMIT');

      expect(deleted).toBe(1);                                          // only the absent Group row
      expect(await deletedAt(GROUP, U1, 'Direct')).toBeNull();         // present -> kept
      expect(await deletedAt(GROUP, U2, 'Direct')).not.toBeNull();     // absent  -> soft-deleted
      expect(await deletedAt(APPROLE, U1, 'Direct')).toBeNull();       // other partition -> SURVIVES
    } finally {
      client.release();
    }
  });

  it('WITHOUT resourceType the same reconcile would cross partitions and wipe the AppRole Direct row (why resourceType is load-bearing)', async () => {
    await insertRA(GROUP, U1, 'Direct', 'Group');   // in batch
    await insertRA(APPROLE, U1, 'Direct', 'AppRole');    // other partition

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await makeTemp(client, 'tmp_ra_nort', [{ resourceId: GROUP, principalId: U1, assignmentType: 'Direct' }]);
      const deleted = await scopedDelete(
        client, 'ResourceAssignments',
        ['resourceId', 'principalId', 'assignmentType'],
        'tmp_ra_nort', systemId,
        { assignmentType: 'Direct' },   // <- no resourceType: the unsafe, pre-redesign scope
        'systemId', RA_COLS,
      );
      await client.query('COMMIT');

      expect(deleted).toBe(1);                                         // the AppRole row, wrongly
      expect(await deletedAt(APPROLE, U1, 'Direct')).not.toBeNull();   // collateral damage without the partition
    } finally {
      client.release();
    }
  });
});

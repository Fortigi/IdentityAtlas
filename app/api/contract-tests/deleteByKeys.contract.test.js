// Contract test — delete-by-key (`deletedKeys`) against real PostgreSQL.
//
// The unit test pins the SQL text; only a real database shows what that text
// removes. Each case puts rows next to the target that differ from it in ONE key
// part — another member, another group, another assignment type, the governed
// twin, another system — so a join that ignored that part would take them too.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const { applyDeleteByKeys } = await import('../src/ingest/deleteByKeys.js');
const { closePool } = await import('../src/db/connection.js');

let pool;
let sysA;
let sysB;

const G1 = '11111111-1111-1111-1111-111111111111';
const G2 = '22222222-2222-2222-2222-222222222222';
const U1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

async function insertRA(systemId, resourceId, principalId, assignmentType = 'Direct', governed = false) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("systemId", "resourceId", "principalId", "assignmentType", "governed")
     VALUES ($1, $2, $3, $4, $5)`,
    [systemId, resourceId, principalId, assignmentType, governed],
  );
}

// Every row of both systems as "system:resource:principal:type:governed:live|deleted".
async function rows() {
  const r = await pool.query(
    `SELECT "systemId", "resourceId", "principalId", "assignmentType", "governed", "deletedAt"
       FROM "ResourceAssignments" WHERE "systemId" = ANY($1::int[])
      ORDER BY "systemId", "resourceId", "principalId", "assignmentType", "governed"`,
    [[sysA, sysB]],
  );
  return r.rows.map(x => [
    x.systemId === sysA ? 'A' : 'B', x.resourceId.slice(0, 2), x.principalId.slice(0, 2),
    x.assignmentType, x.governed, x.deletedAt ? 'deleted' : 'live',
  ].join(':'));
}

const del = (systemId, deletedKeys, restrict = null) =>
  applyDeleteByKeys({ systemId, deletedKeys }, 'resource-assignments', { deleted: 0 }, restrict);

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  sysA = (await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-delkeys-A') RETURNING id`)).rows[0].id;
  sysB = (await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-delkeys-B') RETURNING id`)).rows[0].id;
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = ANY($1::int[])`, [[sysA, sysB]]);
  await insertRA(sysA, G1, U1);                      // the target
  await insertRA(sysA, G1, U2);                      // another member of the same group
  await insertRA(sysA, G2, U1);                      // the same member in another group
  await insertRA(sysA, G1, U1, 'Indirect');          // the same pair, another type
  await insertRA(sysA, G1, U1, 'Direct', true);      // the governed twin
  await insertRA(sysB, G1, U1);                      // the same key in another system
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = ANY($1::int[])`, [[sysA, sysB]]);
  await pool.query(`DELETE FROM "Systems" WHERE id = ANY($1::int[])`, [[sysA, sysB]]);
  await pool?.end();
  await closePool();
});

describe('deletedKeys on ResourceAssignments', () => {
  it('soft-deletes exactly the named row of the batch\'s own system', async () => {
    const result = { deleted: 0 };
    await applyDeleteByKeys(
      { systemId: sysA, deletedKeys: [{ resourceId: G1, principalId: U1, assignmentType: 'Direct' }] },
      'resource-assignments', result,
    );
    expect(result.deleted).toBe(1);
    expect(await rows()).toEqual([
      `A:11:aa:Direct:false:deleted`,
      `A:11:aa:Direct:true:live`,
      `A:11:aa:Indirect:false:live`,
      `A:11:bb:Direct:false:live`,
      `A:22:aa:Direct:false:live`,
      `B:11:aa:Direct:false:live`,
    ]);
  });

  it('reaches the governed twin only when the key says governed: true', async () => {
    await del(sysA, [{ resourceId: G1, principalId: U1, assignmentType: 'Direct', governed: true }]);
    const now = await rows();
    expect(now).toContain('A:11:aa:Direct:true:deleted');
    expect(now).toContain('A:11:aa:Direct:false:live');
  });

  it('deletes several keys in one statement and counts only the rows it changed', async () => {
    const result = { deleted: 0 };
    await applyDeleteByKeys({ systemId: sysA, deletedKeys: [
      { resourceId: G1, principalId: U2, assignmentType: 'Direct' },
      { resourceId: G2, principalId: U1, assignmentType: 'Direct' },
      { resourceId: G2, principalId: U2, assignmentType: 'Direct' },   // never existed
    ] }, 'resource-assignments', result);
    expect(result.deleted).toBe(2);

    // Already deleted: a second pass changes nothing and counts nothing.
    const again = { deleted: 0 };
    await applyDeleteByKeys({ systemId: sysA, deletedKeys: [{ resourceId: G1, principalId: U2, assignmentType: 'Direct' }] },
      'resource-assignments', again);
    expect(again.deleted).toBe(0);
  });

  it('leaves another system\'s rows alone for a key restricted to that other system', async () => {
    // A key restricted to system B sends a batch for system A it cannot own.
    await del(sysA, [{ resourceId: G1, principalId: U1, assignmentType: 'Direct' }], [sysB]);
    expect(await rows()).toContain('A:11:aa:Direct:false:live');

    await del(sysA, [{ resourceId: G1, principalId: U1, assignmentType: 'Direct' }], [sysA]);
    expect(await rows()).toContain('A:11:aa:Direct:false:deleted');
  });
});

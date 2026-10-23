// Contract test — delete-by-key (`deletedKeys`) against real PostgreSQL.
//
// The unit test pins the SQL text; only a real database shows what that text
// removes. Each case puts rows next to the target that differ from it in ONE key
// part — another member, another group, another assignment type, the governed
// twin — so a join that ignored that part would take them too.
//
// The assignment key is unique ACROSS systems (uq_RA_principal has no systemId),
// so a key names at most one row anywhere. The systemId bound is therefore about
// whose row that is: a batch from system A that names a row system B owns must
// leave it alone.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const { applyDeleteByKeys } = await import('../src/ingest/deleteByKeys.js');
const { closePool } = await import('../src/db/connection.js');

let pool;
let sysA;
let sysB;

// Fresh ids per run: the key is unique across systems and the contract DB is
// shared, so fixed ids could collide with another file's rows.
const G1 = randomUUID();
const G2 = randomUUID();
const U1 = randomUUID();
const U2 = randomUUID();
const NAME = { [G1]: 'g1', [G2]: 'g2', [U1]: 'u1', [U2]: 'u2' };

async function insertRA(systemId, resourceId, principalId, assignmentType = 'Direct', governed = false) {
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("systemId", "resourceId", "principalId", "assignmentType", "governed")
     VALUES ($1, $2, $3, $4, $5)`,
    [systemId, resourceId, principalId, assignmentType, governed],
  );
}

// Every row of both systems as "system:resource:principal:type:governed:live|deleted", sorted.
async function rows() {
  const r = await pool.query(
    `SELECT "systemId", "resourceId", "principalId", "assignmentType", "governed", "deletedAt"
       FROM "ResourceAssignments" WHERE "systemId" = ANY($1::int[])`,
    [[sysA, sysB]],
  );
  return r.rows.map(x => [
    x.systemId === sysA ? 'A' : 'B', NAME[x.resourceId], NAME[x.principalId],
    x.assignmentType, x.governed, x.deletedAt ? 'deleted' : 'live',
  ].join(':')).sort();
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
  await insertRA(sysB, G2, U2);                      // a row another system owns
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
      `A:g1:u1:Direct:false:deleted`,
      `A:g1:u1:Direct:true:live`,
      `A:g1:u1:Indirect:false:live`,
      `A:g1:u2:Direct:false:live`,
      `A:g2:u1:Direct:false:live`,
      `B:g2:u2:Direct:false:live`,
    ]);
  });

  it('leaves a row another system owns, even when the batch names its key', async () => {
    const result = { deleted: 0 };
    await applyDeleteByKeys({ systemId: sysA, deletedKeys: [{ resourceId: G2, principalId: U2, assignmentType: 'Direct' }] },
      'resource-assignments', result);
    expect(result.deleted).toBe(0);
    expect(await rows()).toContain('B:g2:u2:Direct:false:live');

    await del(sysB, [{ resourceId: G2, principalId: U2, assignmentType: 'Direct' }]);
    expect(await rows()).toContain('B:g2:u2:Direct:false:deleted');
  });

  it('reaches the governed twin only when the key says governed: true', async () => {
    await del(sysA, [{ resourceId: G1, principalId: U1, assignmentType: 'Direct', governed: true }]);
    const now = await rows();
    expect(now).toContain('A:g1:u1:Direct:true:deleted');
    expect(now).toContain('A:g1:u1:Direct:false:live');
  });

  it('deletes several keys in one statement and counts only the rows it changed', async () => {
    const result = { deleted: 0 };
    await applyDeleteByKeys({ systemId: sysA, deletedKeys: [
      { resourceId: G1, principalId: U2, assignmentType: 'Direct' },
      { resourceId: G2, principalId: U1, assignmentType: 'Direct' },
      { resourceId: G1, principalId: U1, assignmentType: 'Eligible' },   // never existed
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
    expect(await rows()).toContain('A:g1:u1:Direct:false:live');

    await del(sysA, [{ resourceId: G1, principalId: U1, assignmentType: 'Direct' }], [sysA]);
    expect(await rows()).toContain('A:g1:u1:Direct:false:deleted');
  });
});

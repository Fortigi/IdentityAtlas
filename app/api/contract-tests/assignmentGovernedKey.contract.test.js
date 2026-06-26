// Contract test — the `governed` flag is part of the ResourceAssignments key.
//
// Assignment-model redesign phase 3: a governed membership is stored as TWO rows
// — the actual (governed=false) and the governed-intent (governed=true) — for the
// same (resource, principal, assignmentType). This is only possible if `governed`
// is part of the partial unique indexes (migration 047). This test verifies, against
// a real schema, that the two rows coexist and that duplicates within one governed
// value are still rejected.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

let pool;
let systemId;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'governed-key') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
});

const G = '11111111-1111-1111-1111-111111111111';
const U = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const I = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

async function insertRA({ principalId = null, identityId = null, governed }) {
  await pool.query(
    `INSERT INTO "ResourceAssignments"
       ("systemId", "resourceId", "principalId", "identityId", "assignmentType", "governed")
     VALUES ($1, $2, $3, $4, 'Direct', $5)`,
    [systemId, G, principalId, identityId, governed],
  );
}

describe('ResourceAssignments — governed is part of the unique key', () => {
  it('lets the actual (governed=false) and governed-intent (governed=true) rows coexist (principal path)', async () => {
    await insertRA({ principalId: U, governed: false });
    await insertRA({ principalId: U, governed: true });   // must NOT violate the unique index
    const r = await pool.query(
      `SELECT "governed" FROM "ResourceAssignments" WHERE "resourceId"=$1 AND "principalId"=$2 ORDER BY "governed"`,
      [G, U],
    );
    expect(r.rows.map(x => x.governed)).toEqual([false, true]);
  });

  it('still rejects a duplicate within the same governed value (principal path)', async () => {
    await insertRA({ principalId: U, governed: false });
    await expect(insertRA({ principalId: U, governed: false })).rejects.toMatchObject({ code: '23505' });
  });

  it('lets actual + governed-intent coexist on the identity path too', async () => {
    await insertRA({ identityId: I, governed: false });
    await insertRA({ identityId: I, governed: true });
    const r = await pool.query(
      `SELECT count(*)::int AS c FROM "ResourceAssignments" WHERE "resourceId"=$1 AND "identityId"=$2`,
      [G, I],
    );
    expect(r.rows[0].c).toBe(2);
  });
});

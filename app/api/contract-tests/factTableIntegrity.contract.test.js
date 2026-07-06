// Contract test — fact-table referential integrity (migration 051).
//
// The fact tables carry no DB-level FK on purpose (see 051 for why: chunked
// multi-transaction ingest + legitimate external/guest/service-principal members
// that are not in "Principals"). This test enforces the integrity guarantee we
// DO make: migration 051's cleanup removes rows whose RESOURCE is gone, while
// leaving valid rows — including an assignment to an external principal that is
// deliberately absent from "Principals" — untouched. It re-executes the shipped
// migration SQL verbatim against a seeded scenario, and asserts idempotency.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLEANUP_SQL = readFileSync(
  join(__dirname, '../src/db/migrations/051_fact_table_orphan_cleanup.sql'),
  'utf8',
);

let pool;
let systemId;

// Resources: two live, one that is never inserted (the orphan target).
const R_LIVE_A = 'a1a1a1a1-0000-0000-0000-000000000001';
const R_LIVE_B = 'a1a1a1a1-0000-0000-0000-000000000002';
const R_GONE   = 'dead0000-0000-0000-0000-000000000001';
// Principals: one live, one external (a real group member NOT synced into Principals).
const P_LIVE     = 'b2b2b2b2-0000-0000-0000-000000000001';
const P_EXTERNAL = 'e0e0e0e0-0000-0000-0000-000000000001';

async function raKeys() {
  const r = await pool.query(
    `SELECT "resourceId","principalId","assignmentType" FROM "ResourceAssignments"
       WHERE "systemId" = $1 ORDER BY "assignmentType"`,
    [systemId],
  );
  return r.rows;
}
async function rrKeys() {
  const r = await pool.query(
    `SELECT "parentResourceId","childResourceId" FROM "ResourceRelationships"
       WHERE "systemId" = $1 ORDER BY "parentResourceId"`,
    [systemId],
  );
  return r.rows;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','fact-integrity') RETURNING id`,
  );
  systemId = sys.rows[0].id;

  await pool.query(
    `INSERT INTO "Resources" ("id","systemId","resourceType","displayName")
     VALUES ($1,$3,'Group','Live A'), ($2,$3,'Group','Live B')`,
    [R_LIVE_A, R_LIVE_B, systemId],
  );
  await pool.query(
    `INSERT INTO "Principals" ("id","systemId","displayName","principalType")
     VALUES ($1,$2,'Live User','User')`,
    [P_LIVE, systemId],
  );

  // Assignments: clean row, an external-member (resource present, principal
  // absent -> keep), and a resource-orphan (resource gone -> delete).
  await pool.query(
    `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","systemId") VALUES
       ($1,$2,'Direct',$5),
       ($1,$3,'Indirect',$5),
       ($4,$2,'Eligible',$5)
    `,
    [R_LIVE_A, P_LIVE, P_EXTERNAL, R_GONE, systemId],
  );
  // Relationships: clean row (-> keep) and a parent-orphan (parent gone -> delete).
  await pool.query(
    `INSERT INTO "ResourceRelationships" ("parentResourceId","childResourceId","relationshipType","systemId") VALUES
       ($1,$2,'Contains',$4),
       ($3,$1,'Contains',$4)
    `,
    [R_LIVE_A, R_LIVE_B, R_GONE, systemId],
  );
});

afterAll(async () => {
  await pool?.query(`DELETE FROM "ResourceAssignments"   WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "ResourceRelationships" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Resources"  WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool?.query(`DELETE FROM "Systems"    WHERE id = $1`, [systemId]);
  await pool?.end();
});

describe('migration 051 — fact-table orphan cleanup', () => {
  it('starts with the seeded rows (3 assignments incl. the orphan, 2 relationships)', async () => {
    expect(await raKeys()).toHaveLength(3);
    expect(await rrKeys()).toHaveLength(2);
  });

  it('removes resource-orphans but keeps clean rows and external-member assignments', async () => {
    await pool.query(CLEANUP_SQL);

    const ra = await raKeys();
    // The resource-orphan (Eligible, R_GONE) is gone; the clean and the
    // external-member (Indirect, principal absent) rows survive.
    expect(ra).toHaveLength(2);
    expect(ra.map((r) => r.assignmentType).sort()).toEqual(['Direct', 'Indirect']);
    const external = ra.find((r) => r.assignmentType === 'Indirect');
    expect(external.principalId).toBe(P_EXTERNAL); // external member preserved

    const rr = await rrKeys();
    expect(rr).toHaveLength(1);
    expect(rr[0].parentResourceId).toBe(R_LIVE_A);
  });

  it('is idempotent — a second run deletes nothing', async () => {
    const before = { ra: (await raKeys()).length, rr: (await rrKeys()).length };
    await pool.query(CLEANUP_SQL);
    expect((await raKeys()).length).toBe(before.ra);
    expect((await rrKeys()).length).toBe(before.rr);
  });
});

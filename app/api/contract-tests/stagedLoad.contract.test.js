// Contract test — the staged full load against real PG16 (ingest/stages.js).
// The merge tests keep one sentinel row in a third system, so the table is never
// empty and they always take the merge path. The empty-table path is exercised
// once, and only when the table really is empty — the shared contract DB may hold
// other files' rows, and this file must not delete them.
//
// The contract:
//   - new keys are inserted, with the stage's system stamped;
//   - a re-import of UNCHANGED rows writes nothing — updated 0, updatedAt kept —
//     which is the point: the timestamp reconcile must touch every row to say
//     "still here", the stage says nothing about a row that did not change;
//   - a changed row is updated, and only it;
//   - deleteMissing tombstones rows of THIS system missing from the stage, and no
//     other system's rows;
//   - a keys-only stage removes what is missing and writes nothing else;
//   - a tombstoned row that is back is revived.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const { openStage, appendToStage, finalizeStage } = await import('../src/ingest/stages.js');

let pool;
let sysA;
let sysB;
let sysSentinel;
const KEYS = ['resourceId', 'principalId', 'assignmentType', 'governed'];
const FILTER = '"principalId" IS NOT NULL';
const R = (n) => `57a90000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const P = (n) => `57a90000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;

const row = (r, p, extra = {}) => ({ resourceId: R(r), principalId: P(p), assignmentType: 'Direct', governed: false, ...extra });

async function stageLoad(systemId, rows, { deleteMissing = true } = {}) {
  const st = openStage({ tableName: 'ResourceAssignments', keyColumns: KEYS, systemId,
    conflictFilter: FILTER, scopeDeleteFilter: FILTER, ownerId: 1 });
  await appendToStage(st, rows.map(x => ({ ...x, systemId })));
  return finalizeStage(st, { deleteMissing });
}

const live = async (systemId) => (await pool.query(
  `SELECT "resourceId", "principalId", "resourceType", "updatedAt", "deletedAt" FROM "ResourceAssignments"
    WHERE "systemId" = $1 ORDER BY 1, 2`, [systemId])).rows;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  sysA = (await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-stage-A') RETURNING id`)).rows[0].id;
  sysB = (await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-stage-B') RETURNING id`)).rows[0].id;
  sysSentinel = (await pool.query(`INSERT INTO "Systems" ("systemType","displayName") VALUES ('test','contract-stage-sentinel') RETURNING id`)).rows[0].id;
  for (const sid of [sysA, sysB]) {
    for (let n = 1; n <= 4; n++) {
      await pool.query(`INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType") VALUES ($1, $2, $3, 'Group')
                        ON CONFLICT (id) DO NOTHING`, [R(sid === sysA ? n : n + 10), sid, `G${n}`]);
    }
  }
});

const sentinel = () => pool.query(
  `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","governed","systemId")
   VALUES ($1, $2, 'Direct', false, $3) ON CONFLICT DO NOTHING`, [R(99), P(99), sysSentinel]);

beforeEach(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = ANY($1::int[])`, [[sysA, sysB, sysSentinel]]);
  await sentinel();
});

afterAll(async () => {
  const all = [sysA, sysB, sysSentinel];
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = ANY($1::int[])`, [all]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = ANY($1::int[])`, [all]);
  await pool.query(`DELETE FROM "Systems" WHERE id = ANY($1::int[])`, [all]);
  await pool?.end();
});

describe('staged load — merge path', () => {
  it('inserts new keys with the stage system stamped', async () => {
    const r = await stageLoad(sysA, [row(1, 1), row(2, 1)]);
    expect(r).toMatchObject({ path: 'merge', inserted: 2, updated: 0, deleted: 0 });
    expect((await live(sysA)).map(x => x.resourceId)).toEqual([R(1), R(2)]);
  });

  it('an unchanged re-import writes nothing and keeps updatedAt', async () => {
    await stageLoad(sysA, [row(1, 1), row(2, 1)]);
    const before = await live(sysA);
    const r = await stageLoad(sysA, [row(1, 1), row(2, 1)]);
    expect(r).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
    expect((await live(sysA)).map(x => x.updatedAt.getTime())).toEqual(before.map(x => x.updatedAt.getTime()));
  });

  it('updates exactly the row that changed', async () => {
    await stageLoad(sysA, [row(1, 1, { resourceType: 'Group' }), row(2, 1, { resourceType: 'Group' })]);
    const r = await stageLoad(sysA, [row(1, 1, { resourceType: 'Group' }), row(2, 1, { resourceType: 'AppRole' })]);
    expect(r).toMatchObject({ inserted: 0, updated: 1 });
    expect((await live(sysA)).map(x => x.resourceType)).toEqual(['Group', 'AppRole']);
  });

  it('deleteMissing tombstones this system\'s missing rows and leaves other systems alone', async () => {
    await stageLoad(sysA, [row(1, 1), row(2, 1), row(3, 1)]);
    await stageLoad(sysB, [row(11, 1)]);
    const r = await stageLoad(sysA, [row(1, 1)]);
    expect(r.deleted).toBe(2);
    const a = await live(sysA);
    expect(a.filter(x => x.deletedAt === null).map(x => x.resourceId)).toEqual([R(1)]);
    expect((await live(sysB)).filter(x => x.deletedAt === null)).toHaveLength(1);
  });

  it('without deleteMissing, nothing is removed', async () => {
    await stageLoad(sysA, [row(1, 1), row(2, 1)]);
    const r = await stageLoad(sysA, [row(1, 1)], { deleteMissing: false });
    expect(r.deleted).toBe(0);
    expect((await live(sysA)).filter(x => x.deletedAt === null)).toHaveLength(2);
  });

  it('a keys-only stage only removes what is missing', async () => {
    await stageLoad(sysA, [row(1, 1, { resourceType: 'Group' }), row(2, 1, { resourceType: 'Group' })]);
    const st = openStage({ tableName: 'ResourceAssignments', keyColumns: KEYS, systemId: sysA,
      conflictFilter: FILTER, scopeDeleteFilter: FILTER, ownerId: 1 });
    await appendToStage(st, [{ resourceId: R(1), principalId: P(1), assignmentType: 'Direct', governed: false }]);
    const r = await finalizeStage(st, { deleteMissing: true });
    expect(r).toMatchObject({ inserted: 0, updated: 0, deleted: 1 });
    const a = await live(sysA);
    expect(a.find(x => x.resourceId === R(1))).toMatchObject({ resourceType: 'Group', deletedAt: null });
  });

  it('into a truly empty table: bulk path, indexes rebuilt intact (only when nothing else is in the table)', async () => {
    await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [sysSentinel]);
    const others = Number((await pool.query('SELECT count(*) FROM "ResourceAssignments"')).rows[0].count);
    if (others > 0) return;   // another file's rows are present; the merge tests above still ran
    const indexesBefore = (await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ResourceAssignments' ORDER BY 1`)).rows.map(r => r.indexname);
    const r = await stageLoad(sysA, [row(1, 1), row(2, 1)]);
    expect(r).toMatchObject({ path: 'empty-table', inserted: 2 });
    const indexesAfter = (await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ResourceAssignments' ORDER BY 1`)).rows.map(r => r.indexname);
    expect(indexesAfter).toEqual(indexesBefore);
    // the rebuilt unique index still refuses a duplicate
    await expect(pool.query(
      `INSERT INTO "ResourceAssignments" ("resourceId","principalId","assignmentType","governed","systemId") VALUES ($1,$2,'Direct',false,$3)`,
      [R(1), P(1), sysA])).rejects.toThrow(/uq_RA_principal/);
  });

  it('revives a tombstoned row that is back in the source', async () => {
    await stageLoad(sysA, [row(1, 1), row(2, 1)]);
    await stageLoad(sysA, [row(1, 1)]);                  // R2 tombstoned
    const r = await stageLoad(sysA, [row(1, 1), row(2, 1)]);
    expect(r.updated).toBe(1);
    expect((await live(sysA)).every(x => x.deletedAt === null)).toBe(true);
  });
});

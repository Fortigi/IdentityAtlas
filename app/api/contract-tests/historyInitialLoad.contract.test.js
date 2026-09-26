// Contract test — a system's initial load writes no per-row "created" history
// (migration 073), against real PG16 and through the real ingest engine.
//
// The contract, each half of which a plausible regression would break silently:
//   - the FIRST sync of a system (Systems."lastSyncDateTime" IS NULL) inserts its
//     rows without a history row each — that history was 25.7 of 34.9 GB at 41M
//     assignments (docs/architecture/scale-rehearsal.md);
//   - once a sync has completed, inserts ARE recorded again;
//   - updates and deletes are recorded even during the initial load;
//   - anything outside the engine (a direct INSERT) is recorded as before — the
//     flag is transaction-local and only the engine sets it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

process.env.DATABASE_URL = process.env.CONTRACT_DB_URL;
const { ingest } = await import('../src/ingest/engine.js');

let pool;
let systemId;

const RES_A = 'c7300000-0000-0000-0000-00000000000a';
const RES_B = 'c7300000-0000-0000-0000-00000000000b';
const PRIN = 'c7300000-0000-0000-0000-000000000001';

const historyCount = async (table, op) => Number((await pool.query(
  `SELECT count(*) FROM "_history" WHERE "tableName" = $1 AND "operation" = $2 AND "rowId" LIKE '%c7300000-%'`,
  [table, op],
)).rows[0].count);

const resource = (id, name) => ({ id, systemId, displayName: name, resourceType: 'Group' });

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.CONTRACT_DB_URL });
  const sys = await pool.query(
    `INSERT INTO "Systems" ("systemType", "displayName") VALUES ('test', 'contract-initial-load-073') RETURNING "id"`,
  );
  systemId = sys.rows[0].id;
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "_history" WHERE "rowId" LIKE '%c7300000-%'`);
  await pool.query(`UPDATE "Systems" SET "lastSyncDateTime" = NULL WHERE "id" = $1`, [systemId]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM "ResourceAssignments" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Principals" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "Resources" WHERE "systemId" = $1`, [systemId]);
  await pool.query(`DELETE FROM "_history" WHERE "rowId" LIKE '%c7300000-%'`);
  await pool.query(`DELETE FROM "Systems" WHERE "id" = $1`, [systemId]);
  await pool?.end();
});

describe('history during a system\'s initial load', () => {
  it('the first sync inserts rows — including assignments — without a history row each', async () => {
    await ingest(null, 'Resources', ['id'], [resource(RES_A, 'Group A'), resource(RES_B, 'Group B')],
      { syncMode: 'delta', systemId });
    await ingest(null, 'Principals', ['id'], [{ id: PRIN, systemId, displayName: 'Ada', principalType: 'User' }],
      { syncMode: 'delta', systemId });
    await ingest(null, 'ResourceAssignments', ['resourceId', 'principalId', 'assignmentType', 'governed'],
      [{ resourceId: RES_A, principalId: PRIN, assignmentType: 'Direct', governed: false, systemId }],
      { syncMode: 'delta', systemId, conflictFilter: '"principalId" IS NOT NULL' });

    const rows = await pool.query(`SELECT count(*) FROM "Resources" WHERE "systemId" = $1`, [systemId]);
    expect(Number(rows.rows[0].count)).toBe(2);   // the data did land
    expect(await historyCount('Resources', 'I')).toBe(0);
    expect(await historyCount('Principals', 'I')).toBe(0);
    expect(await historyCount('ResourceAssignments', 'I')).toBe(0);
  });

  it('an update during the initial load is still recorded', async () => {
    await ingest(null, 'Resources', ['id'], [resource(RES_A, 'Group A')], { syncMode: 'delta', systemId });
    await ingest(null, 'Resources', ['id'], [resource(RES_A, 'Group A renamed')], { syncMode: 'delta', systemId });
    expect(await historyCount('Resources', 'I')).toBe(0);
    expect(await historyCount('Resources', 'U')).toBe(1);
  });

  it('a delete in the same transaction as a flagged upsert is still recorded', async () => {
    await ingest(null, 'Resources', ['id'], [resource(RES_A, 'Group A'), resource(RES_B, 'Group B')],
      { syncMode: 'delta', systemId });
    // A full sync without B: the engine upserts A (flag set) and deletes B in one transaction.
    await ingest(null, 'Resources', ['id'], [resource(RES_A, 'Group A')], { syncMode: 'full', systemId });
    const b = await pool.query(`SELECT "deletedAt" FROM "Resources" WHERE "id" = $1`, [RES_B]);
    const gone = b.rows.length === 0 || b.rows[0].deletedAt !== null;
    expect(gone).toBe(true);
    // Hard delete → a 'D' row; soft delete (tombstone) → a 'U' row. Either way, recorded.
    expect((await historyCount('Resources', 'D')) + (await historyCount('Resources', 'U'))).toBeGreaterThanOrEqual(1);
  });

  it('after a completed sync, inserts are recorded again', async () => {
    await pool.query(`UPDATE "Systems" SET "lastSyncDateTime" = now() WHERE "id" = $1`, [systemId]);
    await ingest(null, 'Resources', ['id'], [resource(RES_A, 'Group A')], { syncMode: 'delta', systemId });
    expect(await historyCount('Resources', 'I')).toBe(1);
  });

  it('a direct INSERT outside the engine is recorded, even for a system on its initial load', async () => {
    await pool.query(
      `INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType") VALUES ($1, $2, 'Manual', 'Group')`,
      [RES_A, systemId]);
    expect(await historyCount('Resources', 'I')).toBe(1);
  });

  it('the flag does not outlive its transaction', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL identity_atlas.initial_load = 'on'`);
      await client.query(
        `INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType") VALUES ($1, $2, 'In tx', 'Group')`,
        [RES_A, systemId]);
      await client.query('COMMIT');
      await client.query(
        `INSERT INTO "Resources" (id, "systemId", "displayName", "resourceType") VALUES ($1, $2, 'After tx', 'Group')`,
        [RES_B, systemId]);
    } finally {
      client.release();
    }
    const h = await pool.query(
      `SELECT "rowId" FROM "_history" WHERE "tableName" = 'Resources' AND "operation" = 'I' AND "rowId" LIKE '%c7300000-%'`);
    expect(h.rows.map(r => r.rowId)).toEqual([RES_B]);
  });
});
